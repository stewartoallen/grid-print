/** Copyright 2014-2018 Stewart Allen <so@a3z.co> -- All Rights Reserved */
"use strict";

/**
 * About
 *
 * provide raw socket, web socket, and web interface to serial-controlled
 * hardware such as FDM 3D printers and CNC mills based on marlin derived
 * firmwares.
 *
 * TODO
 *
 * different abort per device or type (fdm vs cnc)
 */

const LineBuffer = require("buffer.lines");
const SerialPort = require('serialport');
const opt = require('minimist')(process.argv.slice(2));
const net = require('net');
const fs = require('fs');
const { exec } = require('child_process');

const port = opt.device || opt.port || opt._[0]; // serial port device path
const baud = parseInt(opt.baud || "250000");     // baud rate for serial port
const bufmax = parseInt(opt.buflen || "8");      // max unack'd output lines

const url = require('url');
const http = require('http');
const serve = require('serve-static');
const connect = require('connect');
const linebuf = require("buffer.lines");
const WebSocket = require('ws');

let waiting = 0;                // unack'd output lines
let maxout = 0;                 // high water mark for buffer
let debug = true;               // echo commands
let paused = false;             // queue processing paused
let processing = false;         // queue being drained
let sdspool = false;            // spool to sd for printing
let dircache = [];              // cache of files in watched directory
let clients = [];               // connected clients
let buf = [];                   // output line buffer
let match = [];                 // queue for matching command with response
let collect = null;             // collect lines between oks
let sport = null;               // bound serial port
let mode = 'marlin';            // operating mode
let interval = null;            // pointer to interval updater

// marlin-centric, to be fixed
const status = {
    clients: {
        ws: 0,                  // web socket client count
        net: 0,                 // direct network clients
        stdin: 0                // 1 of stdin active
    },
    device: {
        boot: 0,                // time of last boot
        connect: 0,             // time port was opened successfully
        close: 0,               // time of last close
        line: 0                 // time of last line output
    },
    error: {
        time: 0,                // time of last error
        cause: null             // last error message
    },
    print: {
        run: false,             // print running
        clear: false,           // bed is clear to print
        filename: null,         // current file name
        progress: 0.0
    },
    target: {                   // target temp
        bed: null,              // bed
        ext: [ null ]           // extruders
    },
    temp: {                     // measured temp
        bed: null,              // bed
        ext: [ null ]           // extruders
    },
    estop: {                    // endstop status
        min: {},
        max: {}
    },
    settings: {},               // map of active settings
};

// write line to all connected clients
function emit(line, flags) {
    const debug = flags && flags.debug;
    const stat = flags && flags.status;
    if (typeof(line) === 'object') {
        line = JSON.stringify(line);
    }
    clients.forEach(client => {
        let cstat = (stat && client.request_status);
        if (cstat || (client.monitoring && !stat)) {
            client.write(line + "\n");
            if (cstat) {
                client.request_status = false;
            }
        }
    });
}

function cmdlog(line, flags) {
    if (typeof(line) === 'object') {
        line = JSON.stringify(line);
    }
    if (!flags || !(flags && flags.auto)) {
        emit("[" + waiting + ":" + bufmax + "," + buf.length + ":" + maxout + "] " + line, flags);
    }
};

// send *** message *** to all clients (not stdout unless stdin specified)
function evtlog(line, flags) {
    if (typeof(line) === 'object') {
        line = JSON.stringify(line);
    }
    emit("*** " + line + " ***", flags);
};

function openSerialPort() {
    if (!port || sport) {
        return;
    }
    sport = new SerialPort(port, { baudRate: baud })
        .on('open', function() {
            evtlog("open: " + port);
            new LineBuffer(sport);
            status.device.connect = Date.now();
        })
        .on('error', function(error) {
            sport = null;
            console.log(error);
            setTimeout(openSerialPort, 1000);
            clearInterval(interval);
            interval = null;
            status.device.connect = 0;
        })
        .on('line', function(line) {
            status.device.line = Date.now();
            line = line.toString().trim();
            let matched = null;
            if (line.indexOf("echo:  M900") === 0) {
                cmdlog("<-- " + line);
                collect = [];
            } else
            if (line.indexOf("ok") === 0 || line.indexOf("error:") === 0) {
                if (line.indexOf("ok ") === 0 && collect) {
                    line = line.substring(3);
                    collect.push(line);
                }
                matched = match.shift();
                if (!matched.flags.auto) {
                    console.log({matched, collect});
                }
                waiting = Math.max(waiting - 1, 0);
                if (status.update) {
                    status.update = false;
                }
                collect = [];
            } else if (collect) {
                collect.push(line);
            } else {
                cmdlog("<-- " + line, {auto: matched});
            }
            processPortOutput(line);
            processQueue();
        })
        .on('close', function() {
            sport = null;
            evtlog("close");
            setTimeout(openSerialPort, 1000);
            status.device.close = Date.now();
        });
}

function processPortOutput(line) {
    if (line.length === 0) return;
    let update = false;
    if (line === "start") {
        update = true;
        status.device.boot = Date.now();
        status.print.clear = false;
        waiting = 0;
        collect = null;
        match = [];
        buf = [];
        if (!interval) {
            interval = setInterval(() => {
                if (status.device.connect === 0) {
                    return;
                }
                write('M105', {auto: true}); // get temps
                write('M114', {auto: true}); // get position
                write('M119', {auto: true}); // get endstops
            }, 1000);
        }
    }
    // parse M105 temperature updates
    if (line.indexOf("T:") === 0) {
        // eliminate spaces before slashes " /"
        line = line.replace(/ \//g,'/').split(' ');
        // parse extruder/bed temps
        line.forEach(tok => {
            tok = tok.split(":");
            switch (tok[0]) {
                case 'T':
                    tok = tok[1].split("/");
                    status.temp.ext[0] = parseFloat(tok[0]);
                    status.target.ext[0] = parseFloat(tok[1]);
                    update = true;
                    break;
                case 'B':
                    tok = tok[1].split("/");
                    status.temp.bed = parseFloat(tok[0]);
                    status.target.bed = parseFloat(tok[1]);
                    update = true;
                    break;
            }
        });
    }
    // parse M114 x/y/z/e positions
    if (line.indexOf("X:") === 0) {
        let pos = status.pos = {};
        line.split(' ').forEach(tok => {
            tok = tok.split(':');
            if (tok.length === 2) {
                pos[tok[0]] = parseFloat(tok[1]);
                update = true;
            }
        });
    }
    // parse M119 endstop status
    if (line.indexOf("_min:") > 0) {
        status.estop.min[line.substring(0,1)] = line.substring(6);
        update = true;
    }
    if (line.indexOf("_max:") > 0) {
        status.estop.max[line.substring(0,1)] = line.substring(6);
        update = true;
    }
    // parse M503 settings status
    if (line.indexOf("echo:  M") === 0) {
        line = line.substring(7).split(' ');
        let code = {
            // M149: "temp_units",
            // M200: "filament",
            M92:  "steps_per",
            M203: "feedrate_max",
            M201: "accel_max",
            M204: "accel",
            M205: "advanced",
            M206: "offset",
            // M145: "heatup",
            M301: "pid",
            M900: "lin_advance"
        }[line.shift()] || null;
        let map = {};
        line.forEach(tok => {
            map[tok.substring(0,1)] = parseFloat(tok.substring(1));
        });
        if (code) {
            status.settings[code] = map;
        }
        update = true;
    }
    // catch fatal errors and reboot
    if (line.indexOf("Error:") === 0) {
        status.error = {
            time: Date.now(),
            cause: line.substring(6)
        };
        sport.close();
    }
    if (update) {
        status.update = true;
    }
};

function sendFile(filename) {
    if (!status.print.clear) {
        return evtlog("bed not marked clear. use *clear first");
    }
    status.print.run = true;
    status.print.clear = false;
    status.print.filename = filename;
    status.print.start = Date.now();
    evtlog("send: " + filename);
    try {
        let gcode = fs.readFileSync(filename).toString().split("\n");
        if (sdspool) {
            evtlog(`spooling "${filename} to SD"`);
            queue(`M28 print.gco`);
            gcode.forEach(line => {
                queue(line);
            });
            queue(`M29`);
            evtlog(`printing "${filename} from SD"`);
            queue(`M23 print.gco`);
            queue(`M24`);
        } else {
            gcode.forEach(line => {
                queue(line);
            });
        }
    } catch (e) {
        evtlog("error sending file");
        console.log(e);
    }
}

function processInput(line, channel) {
    line = line.toString().trim();
    if (line.indexOf("*exec ") === 0) {
        let cmd = line.substring(6);
        exec(cmd, (err, stdout, stderr) => {
            evtlog(JSON.stringify({cmd, err, stdout, stderr}));
        });
        return;
    }
    switch (line) {
        case "*auto on": return opt.auto = true;
        case "*auto off": return opt.auto = false;
        case "*debug on": return debug = true;
        case "*debug off": return debug = false;
        case "*list": return evtlog(JSON.stringify(dircache));
        case "*kick": return kickNext();
        case "*abort": return abort();
        case "*pause": return pause();
        case "*resume": return resume();
        case "*clear":
            status.print.clear = true;
            return evtlog("bed marked clear");
        case "*monitor on":
            if (channel && !channel.monitoring) {
                channel.monitoring = true;
                evtlog("monitoring enabled");
            }
            return;
        case "*monitor off":
            if (channel && channel.monitoring) {
                evtlog("monitoring disabled");
                channel.monitoring = false;
            }
            return;
        case "*status":
            if (channel) {
                channel.request_status = true;
            }
            return evtlog(JSON.stringify(status), {status: true});
    }
    if (line.indexOf("*send ") === 0) {
        sendFile(line.substring(6));
    } else {
        queuePriority(line);
    }
};

function abort() {
    evtlog("execution aborted");
    if (mode === 'grbl') {
        buf = [];
    } else
    // safety if buffer in play
    if (buf.length) {
        write("M108"); // cancel / unblock heating
        buf = [
            "M104 S0 T0",   // extruder 0 heat off
            "M104 S0 T1",   // extruder 1 heat off
            "M140 S0 T0",   // bed heat off
            "M107",         // shut off cooling fan
            "G91",          // relative moves
            "G0 Z10",       // drop bed 1cm
            "G28 X0 Y0",    // home X & Y
            "M84"           // disable steppers
        ];
    }
    processQueue();
    status.print.clear = false;
};

function pause() {
    if (paused) return;
    evtlog("execution paused");
    paused = true;
};

function resume() {
    if (!paused) return;
    evtlog("execution resumed");
    paused = false;
    processQueue();
};

function processQueue() {
    if (processing) return;
    processing = true;
    while (waiting < bufmax && buf.length && !paused) {
        write(buf.shift());
    }
    if (buf.length === 0) {
        maxout = 0;
        if (status.print.run) {
            status.print.end = Date.now();
            status.print.run = false;
            status.print.progress = "100.00";
            evtlog("print done " + ((status.print.end - status.print.start) / 60000) + " min");
        }
    } else {
        if (status.print.run) {
            status.print.progress = ((1.0 - (buf.length / maxout)) * 100.0).toFixed(2);
        }
    }
    processing = false;
};

function queue(line, priority) {
    line = line.trim();
    if (line.length === 0) {
        return;
    }
    if (waiting < bufmax) {
        write(line);
    } else {
        if (priority) {
            buf.splice(0, 0, line)
        } else {
            buf.push(line);
        }
        maxout = Math.max(maxout, buf.length);
    }
};

function queuePriority(line) {
    queue(line, true);
}

function write(line, flags) {
    if (line.indexOf("M2000") === 0) {
        pause();
        return;
    }
    flags = flags || {};
    switch (line.charAt(0)) {
        case ';':
            return;
        case '$': // grbl
        case '?': // grbl
        case '~': // grbl resume
        case 'M':
        case 'G':
            match.push({line, flags});
            waiting++;
            break;
    }
    if (sport) {
        cmdlog("--> " + line, flags);
        sport.write(line + "\n");
    } else {
        console.log("*** serial port missing *** " + line);
    }
}

function checkDropDir() {
    const dir = (opt.dir || opt.filedir);
    if (!dir) return;
    try {
        let valid = [];
        fs.readdirSync(dir).forEach(name => {
            if (name.indexOf(".gcode") > 0 || name.indexOf(".nc") > 0) {
                name = dir + "/" + name;
                let stat = fs.statSync(name);
                valid.push({name: name, size: stat.size, time: stat.mtimeMs});
            }
        });
        dircache = valid.sort((a, b) => {
            return b.time - a.time;
        });
        if (opt.auto && valid.length && status.print.clear) {
            kickNext();
        }
        setTimeout(checkDropDir, 2000);
    } catch (e) {
        console.log(e);
    }
};

function kickNext() {
    if (!dircache.length) return evtlog("no valid files");
    sendFile(dircache[0].name);
};

function headers(req, res, next) {
    res.setHeader("Access-Control-Allow-Origin", req.headers['origin'] || '*');
    res.setHeader("Access-Control-Allow-Credentials", true);
    res.setHeader("Access-Control-Allow-Headers", "X-Moto-Ajax");
    next();
}

// -- start it up --

if (opt.help) {
    console.log([
        "usage: serial [options]",
        "   --device=<dev>   : path to serial port device",
        "   --baud=<rate>    : baud rate for serial device",
        "   --listen=<port>  : port for command interface",
        "   --webport=<port> : port to listen for web connections",
        "   --webdir=<dir>   : directory to serve on <webport>",
        "   --filedir=<dir>  : directory to watch for gcode",
        "   --stdin          : enable stdin as command interface",
        "   --grbl           : enable grbl command mode"
    ].join("\n"));
    process.exit(0);
}

if (opt.grbl) {
    mode = 'grbl';
}

if (opt.probe) {
    SerialPort.list((err, ports) => {
        ports.forEach(port => {
            console.log([
                port.comName,
                port.pnpId        || null,
                port.manufacturer || null,
                port.vendorId     || null,
                port.productId    || null,
                port.serialNumber || null
            ].join(", "));
        });
        process.exit(0);
    });
    return;
}

clients.push(process.stdout);
process.stdout.monitoring = true;

if (opt.stdin) {
    new LineBuffer(process.stdin);
    process.stdin.on("line", line => { processInput(line, process.stdout) });
    status.clients.stdin = 1;
}

if (opt.listen) {
    net.createServer(socket => {
        status.clients.net++;
        new LineBuffer(socket);
        socket.write("*ready\n");
        socket.on("line", line => { processInput(line, socket) });
        socket.on("close", () => {
            clients.splice(clients.indexOf(socket),1);
            status.clients.net--;
        });
        clients.push(socket);
    }).listen(parseInt(opt.listen));
}

if (opt.webport) {
    const webdir = opt.webdir || "web";
    const webport = parseInt(opt.webport) || (opt.listen + 1) || 8000;
    const handler = connect()
        .use(headers)
        .use(serve(process.cwd() + "/" + webdir + "/"));
    const server = http.createServer(handler).listen(webport);
    const wss = new WebSocket.Server({ server });
    wss.on('connection', (ws) => {
        status.clients.ws++;
        ws
            .on('close', () => {
                clients.splice(clients.indexOf(ws),1);
                status.clients.ws--;
            })
            .on('error', (error) => {
                console.log({wss_error: error});
            })
            .on('message', (message) => {
                processInput(message, ws);
            });

        ws.send("*ready");
        ws.write = (data) => {
            try {
                ws.send(data);
            } catch (e) {
                // client will be removed above on 'close' event
            }
        };
        clients.push(ws);
    });
    console.log({ webport, webdir });
}

console.log({ port: port || 'undefined', baud, bufmax, mode });

openSerialPort();

checkDropDir();
