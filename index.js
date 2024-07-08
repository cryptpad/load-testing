const Netflux = require('netflux-websocket');
const Util = require('./common-util.js');
const Hash = require('./common-hash.js');
const nacl = require('tweetnacl/nacl-fast');
const Sodium = require('sodium-native');
const nThen = require('nthen');
const Saferphore = require('saferphore');
const prompt = require('prompt-confirm');
const ws = require('ws');
const wss = "wss://freemium.cryptpad.fr/cryptpad_websocket";

global.window = {
    WebSocket: ws.WebSocket,
    addEventListener: () => {}
}

let Env = {
    users: {},
    channels: {},
    queries: 0,
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
    let repeat = isCp ? 300 : 5;
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
        f();
        setRandomInterval(f);
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
                            cb();
                        }, err => {
                            Env.errors++;
                            console.error(err);
                            cb();
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


Env.incQueries = () => {
    Env.queries++;
    if (Env.maxQ && Env.queries >= Env.maxQ) {
        Env.stopPatch = true;
    }
};

let ask = () => {
    const p = new prompt('Start sending patches?');
    p.ask(function (answer) {
        if (!answer) {
            return setTimeout(ask, 1000);
        }
        let qIt, fIt;
        let last = {};

        startSendDataEvt.fire();
        Env.start = +new Date();
        last.t = +new Date();
        last.q = 0;
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
            fr = Math.floor(1000*(Env.queries-last.q)/(now-last.t));

            last.t = +new Date();
            last.q = q;
        }, 1000);
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
    if (key === '--create') {
        Env.create = true;
        return;
    }
});

console.log('Number of users:', Env.numberUsers);
console.log('Offset:', Env.offset);

if (Env.create) {
    makeAllData(() => {
        console.log('DONE');
    });
} else {
    start(() => {
        console.log('Users are ready');
        ask();
    });
}

process.on('SIGINT', function() {
  process.exit(0);
});
