#!/usr/bin/env -S gjs -m
// Loopback networking test: host + client in one process over 127.0.0.1.
// Run: gjs -m tests/net-smoke.js
import GLib from 'gi://GLib';
import { NetHost, NetClient } from '../gnomepong@vanvonvan.github.io/lib/net.js';

const loop = new GLib.MainLoop(null, false);
let failures = 0;
const lines = [];
const check = (name, cond) => {
    lines.push(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!cond) failures++;
};

const SENT_STATE = {
    ball: { x: 500, y: 350 }, leftY: 100, rightY: 200,
    scoreL: 1, scoreR: 2, state: 'playing', winner: null,
};

// --- Subtest 1: correct secret handshakes and relays both directions ---
let connected = false;
let hostGotInput = null;
let welcomedSide = null;
let gotState = null;

const host = new NetHost({
    port: 0,
    secret: 'letmein',
    handlers: {
        connected: () => { connected = true; host.sendState(SENT_STATE); },
        input: (y) => { hostGotInput = y; },
        error: (e) => logError(e, 'host'),
    },
});
const port = host.start();

const client = new NetClient({
    host: '127.0.0.1',
    port,
    secret: 'letmein',
    handlers: {
        welcome: (side) => { welcomedSide = side; client.sendInput(333); },
        state: (s) => { gotState = s; },
        error: (e) => logError(e, 'client'),
    },
});
client.connect();

// --- Subtest 2: wrong secret is rejected, never "connected" ---
let connectedWrong = false;
let rejectedReason = null;
let host2, client2;

GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
    check('host saw client connect (good secret)', connected === true);
    check('client was welcomed as right side', welcomedSide === 'right');
    check('client received the state the host sent',
        !!gotState && gotState.scoreL === 1 && gotState.scoreR === 2 &&
        gotState.ball && gotState.ball.x === 500);
    check('host received the client input frame', hostGotInput === 333);
    host.stop();
    client.stop();

    host2 = new NetHost({
        port: 0,
        secret: 'correct-horse',
        handlers: { connected: () => { connectedWrong = true; }, error: () => {} },
    });
    const port2 = host2.start();
    client2 = new NetClient({
        host: '127.0.0.1',
        port: port2,
        secret: 'nope',
        handlers: {
            welcome: () => {},
            rejected: (r) => { rejectedReason = r; },
            error: () => {},
        },
    });
    client2.connect();
    return GLib.SOURCE_REMOVE;
});

GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
    check('wrong secret was rejected', rejectedReason !== null);
    check('host never marked a wrong-secret client connected', connectedWrong === false);
    host2?.stop();
    client2?.stop();
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

// Safety net so the test can never hang.
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => { loop.quit(); return GLib.SOURCE_REMOVE; });

loop.run();

for (const l of lines) print(l);
print(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0)
    imports.system.exit(1);