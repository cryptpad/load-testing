const Netflux = require('netflux-websocket');
const Util = require('./common-util.js');
const Hash = require('./common-hash.js');
const nacl = require('tweetnacl/nacl-fast');
const Sodium = require('sodium-native');
const nThen = require('nthen');
const Saferphore = require('saferphore');
const prompt = require('prompt-confirm');
const ws = require('ws');
const ServerCommand = require('./http-command');
const Pinpad = require('./pinpad');


// CONFIG
const domain = "freemium.cryptpad.fr";
const USE_WS = false;
const blobSizeMult = 1000; // Base size is 128KB
// END CONFIG

const wss = `wss://${domain}/cryptpad_websocket`;
const url = `https://${domain}`;


ServerCommand.setOrigin(url);
global.window = {
    WebSocket: ws.WebSocket,
    addEventListener: () => {}
}

let Env = {
    users: {},
    channels: {},
    queries: 0,
    patches: 0,
    lag: [],
    errors: 0
};
let startSendDataEvt = Util.mkEvent(true);
let hk;

let edPublic = "gH12mjdXc1hGsVMtCJeoGTkBQRA21V0VOEGphoddmPM=";
let edPrivate = "5V0tO8q1wKr62KIJadYdXaXvgG8f6FQtS6XHYrHYLzGAfXaaN1dzWEaxUy0Il6gZOQFBEDbVXRU4QamGh12Y8w==";
let hash = "/2/undefined/edit/UCrOzk5XEOP7qi"; // missing 10 characters

let makeNetwork = function (cb) {
    Netflux.connect(wss).then(function (network) {
        cb(null, network);
    }, function (err) {
        cb(err);
    });
};

let makeHash = (id) => {
    let l = String(id).length;
    let add = 10 - l;
    let str = String(id);
    for(let i=0; i<add; i++) {
        str = 'x' + str;
    }
    let _hash = hash + str + '/';
    return _hash;
};

let getMsg = isCp => {
    let base = nacl.util.encodeBase64(nacl.randomBytes(30));
    let repeat;
    if (isCp) {
        repeat = 1500 + Math.floor(Math.random() * 3000);
    } else {
        repeat = 5 + Math.floor(Math.random() * 10)
    }
    let str = base;
    for (let i = 0; i < repeat; i++) {
        str += base;
    }
    return str;
};

let signMsg = (isCp, secret) => {
    let msg = getMsg(isCp);
    let signKey = nacl.util.decodeBase64(secret.keys.signKey);
    let msg8 = nacl.util.decodeUTF8(msg);
    let signed8 = new Uint8Array(msg8.length + 64);
    //let signed2 = nacl.util.encodeBase64(nacl.sign(nacl.util.decodeUTF8(msg), signKey));
    Sodium.crypto_sign(signed8, msg8, signKey);
    let signed = nacl.util.encodeBase64(signed8);
    if (!isCp) { return signed; }
    let id = msg.slice(0,8);
    return `cp|${id}|${signed}`;
};

let makeData = function (id, cb) {
    let user = Env.users[id];
    if (!user || !user.wc || !user.secret || !user.isEmpty) {
        return void setTimeout(cb);
    }
    let n = nThen;
    for (let i = 1; i<=130; i++) {
        n = n(w => {
            let m = signMsg(!(i%50), user.secret);
            user.wc.bcast(m).then(w());
        }).nThen;
    }
    n(() => {
        cb();
    });
};

let clearDataCmd = (start, max) => {
    let cmd = 'Run the following commands to clear all the data\n';
    cmd += 'rm ';
    for (let i=start; i<(start+max); i++) {
        let hash = makeHash(i);
        let secret = Hash.getSecrets('pad', hash);
        let chan = secret.channel;
        cmd += `${chan.slice(0,2)}/${chan}* `;
    }
    console.error(cmd);
};

let joinChan = (user, id, cb) => {
    if (!user || !user.network) { return; }
    let network = user.network;
    let hash = makeHash(id);
    let secret = Hash.getSecrets('pad', hash);
    if (!user.hash && !user.secret) {
        user.hash = hash;
        user.secret = secret;
    }
    user.isEmpty = true; // Only used with the makeData button
    let chan = Env.channels[secret.channel] = Env.channels[secret.channel] || {
        secret: secret,
    };
    let n = 0;
    network.on('message', (msg, sender) => {
        if (sender !== hk) { return; }
        let parsed = JSON.parse(msg);
        if (parsed.state === 1 && parsed.channel === secret.channel) {
            chan.total = n; // %50 to know if we should make a cp
            return void cb();
        }
        let m = parsed[4];
        if (parsed[3] !== secret.channel) { return; }
        if (!m) { return; }
        n++;
        user.isEmpty = false;
    });
    network.join(secret.channel).then(wc => {
        user.wc = wc;
        if (!hk) {
            wc.members.forEach(function (p) {
                if (p.length === 16) { hk = p; }
            });
        }
        let cfg = {
            metadata: {
                validateKey: secret.keys.validateKey,
                owners: [edPublic]
            }
        };
        let msg = ['GET_HISTORY', wc.id, cfg];
        network.sendto(hk, JSON.stringify(msg));
    });
};

let setRandomInterval = f => {
    let delay = (Env.delay - 300)*2;
    let rdm = 300 + Math.floor(delay * Math.random());
    if (Env.stopPatch) { return; }
    setTimeout(function () {
        f(() => {
            setRandomInterval(f);
        });
    }, rdm);
};

let startOneUser = function (i, init, cb) {
    let network;
    let myPads = [i];
    let me;
    nThen(w => {
        makeNetwork(w((err, _network) => {
            if (err) {
                w.abort();
                return void console.error(err);
            }
            network = _network;
            me = Env.users[i] = {
                network: network,
                myPads
            };
        }));
    }).nThen(w => {
        joinChan(me, i, w());
    }).nThen(w => {
        if (!init) { return; }
        makeData(i, w());
    }).nThen(w => {
        if (init) { return; }
        let min = Math.max(Env.offset, i-5); // XXX 5 users per pad
        for (let j = min; j<i; j++) {
            myPads.push(j);
            joinChan(me, j, w());
        }
    }).nThen(w => {
        if (init) { return; }
        myPads.forEach(function (id) {
            let channel = (Env.users[id] && Env.users[id].secret) ? Env.users[id].secret.channel : null;
            if (channel==null) {
               //console.log("Channel " + id + " is null");
            } else {
                let wc = me.network.webChannels.find(obj => {
                    return obj.id === channel;
                });
                let chanObj = Env.channels[channel] || {};
                // Only fill the chan if it is not originally empty
                if (Env.users[id].isEmpty) { return; }
                startSendDataEvt.reg(function () {
                    setRandomInterval(function (cb) {
                        let i = chanObj.total || 0;
                        let m = signMsg(!(i%50), chanObj.secret);
                        //console.log('Send patch', channel, i%50);
                        chanObj.total = i+1;
                        Env.incQueries();
                        let t = +new Date();
                        wc.bcast(m).then(() => {
                            let now = +new Date();
                            Env.lag.push((now - t));
                            if (cb) { cb(); }
                        }, err => {
                            Env.errors++;
                            console.error(err);
                            if (cb) { cb(); }
                        });
                    });
                });
            }
        });
    }).nThen(w => {
        // TODO
        // RPC commands? Upload blob?
    }).nThen(w => {
        cb();
    });

};

let start = function (cb) {
    clearDataCmd(Env.offset, Env.numberUsers);
    var sem = Saferphore.create(20);
    let max = Env.numberUsers + Env.offset;
    nThen(w => {
        process.stdout.write(`Load users`);
        let l = 0;
        for (let i=Env.offset; i<max; i++) {
            let done = w();
            sem.take(function(give) {
                //console.log('loading user ', i);
                startOneUser(i, false, () => {
                    l++;
                    setTimeout(give(() => {
                        done();
                    }));
                    process.stdout.clearLine(0);
                    process.stdout.cursorTo(0);
                    process.stdout.write(`Loaded users: ${l}`);
                });
            });
        }
    }).nThen(() => {
        console.log('');
        cb();
    });
};

let makeAllData = function (cb) {
    clearDataCmd(Env.offset, Env.numberUsers);
    var sem = Saferphore.create(10);
    let max = Env.numberUsers + Env.offset;
    nThen(w => {
        for (let i=Env.offset; i<max; i++) {
            let done = w();
            sem.take(function(give) {
                //console.log('loading user ', i);
                startOneUser(i, true, () => {
                    setTimeout(give(() => {
                        done();
                    }));
                    console.log('loaded user ', i);
                });
            });
        }
    }).nThen(() => {
        cb();
    });
};

let startOneHistory = (id, _cb) => {
    let cb = Util.once(_cb);
    let network;
    let hash = makeHash(id);
    let secret = Hash.getSecrets('pad', hash);
    nThen(w => {
        makeNetwork(w((err, _network) => {
            if (err) {
                w.abort();
                return void console.error(err);
            }
            network = _network;
            me = Env.users[id] = {
                network: network
            };
        }));
    }).nThen(w => {
        let n = 0;
        let getHistory = () => {
            n = 0;
            let cfg = {
                metadata: {
                    validateKey: secret.keys.validateKey,
                    owners: [edPublic]
                }
            };
            let msg = ['GET_HISTORY', secret.channel, cfg];
            network.sendto(Env.hk, JSON.stringify(msg)).then((err) => {
                Env.incQueries();
            }, (err) => {
                console.error(err);
            });
        };
        network.on('message', (msg, sender) => {
            if (sender !== Env.hk) { return; }
            let parsed = JSON.parse(msg);
            if (parsed.state === 1 && parsed.channel === secret.channel) {
                    setTimeout(getHistory, 1000);
                /*if (!n) {
                    console.log('EMPTY HISTORY USER', id);
                } else {
                    setTimeout(getHistory, 1000);
                }*/
                return cb();
            }
            let m = parsed[4];
            if (parsed[3] !== secret.channel) { return; }
            if (!m) { return; }
            Env.incPatches();
            n++;
        });
        if (!Env.hk) {
            console.log('GET HK');
            return network.join(secret.channel).then(wc => {
                wc.members.forEach(function (p) {
                    if (p.length === 16) { Env.hk = p; }
                });
                wc.leave();
                setTimeout(getHistory);
            });
        }
        setTimeout(getHistory);
    });
};

let startHistory = () => {
    let max = Env.numberUsers + Env.offset;
    let n = nThen;
    for (let i=Env.offset; i<max; i++) {
        n = n(w => {
            startOneHistory(i, w(() => {
                console.log('loaded user ', i);
            }));
        }).nThen;
    }
    n(() => {
        console.log('READY');

        Env.start = +new Date();
        let last = {
            t: +new Date(),
            p: 0,
            q: 0
        };
        let fr = 0;
        let frp = 0;
        setInterval(() => {
            let q = Env.queries;
            let now = +new Date();
            let diffTime = (now-Env.start)/1000;
            let f = Math.floor(q/diffTime);

            let time = Math.floor(diffTime);
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            process.stdout.write(`Time: ${time}s \t|\t  history/s: ${fr} \t|\t patches/s: ${frp}`);
            process.stdin.resume();
        }, 200);
        setInterval(() => {
            let q = Env.queries;
            let p = Env.patches;
            let now = +new Date();
            fr = Math.floor(1000*(q-last.q)/(now-last.t));
            frp = Math.floor(1000*(p-last.p)/(now-last.t));

            last.t = now;
            last.q = q;
            last.p = p;
        }, 1000);
    });
};

const uploadUrl = url + '/upload-blob';
const allIDs = [];
const uploadRandomFile = (keys, rpc, cookie, cb) => {
    let n = 0;
    const next = (cb) => {
        if (n++ > 1000) {
            // 128MB: stop upload
            return void cb();
        }
        const u8 = new Uint8Array(128000);
        const u = nacl.randomBytes(1000);
        for(let i = 0; i<128; i++) {
            u8.set(u, i*1000);
        }
        cb(u8);
    };

    const sendChunkWs = function (box, cb) {
        if (!(n%50)) {
            console.log('Sending chunk', `${n}/1000`);
        }
        var enc = Util.encodeBase64(box);
        rpc.send.unauthenticated('UPLOAD', enc, cb);
    };
    const sendChunk = (data, cb, cookie) => {
        const enc = Util.encodeBase64(data);
        const c = Util.decodeUTF8(cookie);
        const sig_str = nacl.sign(c, keys.secretKey);
        const sig = Util.encodeBase64(sig_str);

        const body = {
            chunk: enc,
            sig: sig,
            edPublic: keys.edPublic
        };
        if (!(n%50)) {
            console.log('Sending chunk', `${n}/1000`);
        }

        fetch(uploadUrl, {
            method: 'post',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        }).then(res => res.json())
          .then(json => {
            if (json?.error) {
                return cb(json.error);
            }
            cookie = json.cookie;
            cb(void 0, cookie);
        }).catch(cb);
    };

    var again = function (err, box, cookie) {
        if (err) { return console.error(err); }
        if (box) {
            let send = sendChunk;
            if (USE_WS) {
                send = sendChunkWs;
            }
            return void send(box, function (e, cookie) {
                if (e) { return console.error(e); }
                next(u8 => {
                    again(void 0, u8, cookie);
                });
            }, cookie);
        }

        // if not box then done
        const id = Hash.createChannelId() + Hash.createChannelId().slice(0,16);
        console.log(id);
        allIDs.push(id);
        rpc.uploadComplete(id, cb);
    };

    next(u8 => {
        again(void 0, u8, cookie);
    });
};

const startOneBlob = (cb) => {
    let network, rpc, cookie;
    const keys = nacl.sign.keyPair();
    const keys64 = {
        edPublic: nacl.util.encodeBase64(keys.publicKey),
        edPrivate: nacl.util.encodeBase64(keys.secretKey),
    };
    keys.edPublic = keys64.edPublic;
    console.log(keys.edPublic);

    nThen(w => {
        makeNetwork(w((err, _network) => {
            if (err) {
                w.abort();
                return void console.error(err);
            }
            network = _network;
        }));
    }).nThen(w => {
        if (Env.hk) { return; }
        network.join('00000000000000000000000000000000').then(w(wc => {
            wc.members.forEach(function (p) {
                if (p.length === 16) { Env.hk = p; }
            });
            wc.leave();
        }));
    }).nThen(w => {
        network.historyKeeper = Env.hk;
        Pinpad.create(network, keys64, w((err, call) => {
            if (err) {
                w.abort();
                return void console.error(err);
            }
            rpc = call;
        }));
    }).nThen(w => {
        if (USE_WS) { return; }
        ServerCommand(keys, {
            command: 'UPLOAD_COOKIE',
        }, w((err, data) => {
            cookie = data?.cookie;
            if (err || !cookie) {
                w.abort();
                return void console.error(err);
            }
        }));
    }).nThen(w => {
        uploadRandomFile(keys, rpc, cookie, () => {
            console.log('File uploaded');
            cb();
        });
    });

};

const startBlobs = cb => {
    console.log('Start uploading blobs');
    nThen(w => {
        for (let i=0; i<Env.numberBlobs; i++) {
            startOneBlob(w(() => {
                console.log('TO CLEAN', allIDs);
            }));
        }
    }).nThen(() => {
        if (Env.loop) {
            return startBlobs(cb);
        }
        cb();
    });
};


Env.incPatches = () => {
    Env.patches++;
};
Env.incQueries = () => {
    Env.queries++;
    if (Env.maxQ && Env.queries >= Env.maxQ) {
        Env.stopPatch = true;
    }
};

let ask = () => {
    const p = new prompt('Start sending patches?');
    let run = () => {
        let qIt, fIt;

        startSendDataEvt.fire();
        Env.start = +new Date();

        let last = {
            t: +new Date(),
            q: 0
        };
        let fr = 0;
        console.log('Stats:');
        process.stdout.write('waiting...');
        setInterval(() => {
            let q = Env.queries;
            let now = +new Date();
            let diffTime = (now-Env.start)/1000;
            let f = Math.floor(q/diffTime);
            const average = Math.round((Env.lag.length && Env.lag.reduce((a, b) => a + b, 0) / Env.lag.length)) || 0;

            let time = Math.floor(diffTime);
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            process.stdout.write(`Time: ${time}s \t|\t  Queries/s: ${fr}     \t|\t Lag: ${average}ms`);
            process.stdin.resume();
        }, 200);
        setInterval(() => {
            Env.lag = [];
            let q = Env.queries;
            let now = +new Date();
            fr = Math.floor(1000*(q-last.q)/(now-last.t));
            last.t = now;
            last.q = q;
        }, 1000);
    };
    if (Env.noAsk) {
        return run();
    } else if (Env.noPatch) {
        process.stdin.resume();
        return;
    }
    p.ask(function (answer) {
        if (!answer) {
            return setTimeout(ask, 1000);
        }
        run();
    });

};

Env.numberUsers = 100;
Env.offset = 0;
Env.delay = 800;
Env.maxQ = 0;
process.argv.forEach(key => {
    if (/^--users=/.test(key)) {
        let u = key.slice(8);
        Env.numberUsers = Number(u || 100);
        return;
    }
    if (/^--offset=/.test(key)) {
        let o = key.slice(9);
        Env.offset = Number(o || 0);
        return;
    }
    if (/^--delay=/.test(key)) {
        let d = key.slice(8);
        Env.delay = Number(d || 800);
        return;
    }
    if (/^--queries=/.test(key)) {
        let q = key.slice(10);
        Env.maxQ = Number(q || 800);
        return;
    }
    if (/^--blobs=/.test(key)) {
        let u = key.slice(8);
        Env.numberBlobs = Number(u || 10);
        return;
    }
    if (key === '--history') {
        Env.history = true;
        return;
    }
    if (key === '--create') {
        Env.create = true;
        return;
    }
    if (key === '--loop') {
        Env.loop = true;
        return;
    }
    if (key === '--no-ask') {
        Env.noAsk = true;
        return;
    }
    if (key === '--no-patch') {
        Env.noPatch = true;
        return;
    }
});

process.on('SIGINT', function() {
  process.exit(0);
});

if (Env.numberBlobs) {
    console.log('Number of blobs:', Env.numberBlobs);
    return startBlobs(() => {
        console.log('DONE');
    });
}

console.log('Number of users:', Env.numberUsers);
console.log('Offset:', Env.offset);

if (Env.history) {
    startHistory();
} else if (Env.create) {
    makeAllData(() => {
        console.log('DONE');
    });
} else {
    start(() => {
        console.log('Users are ready');
        ask();
    });
}

