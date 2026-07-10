#!/usr/bin/env -S gjs -m
// End-to-end networked-game test over loopback: a HostGame and a ClientGame
// play a rally; we assert the client stays in sync and its paddle input
// reaches the host. Run: gjs -m tests/netgame-smoke.js
import GLib from 'gi://GLib';
import * as C from '../gnomepong@vanvonvan.github.io/lib/constants.js';
import { HostGame, ClientGame } from '../gnomepong@vanvonvan.github.io/lib/netgame.js';

const loop = new GLib.MainLoop(null, false);
let failures = 0;
const lines = [];
const check = (name, cond) => {
    lines.push(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!cond) failures++;
};

const DT = 1 / 60;
const SECRET = 'rally-secret';

const host = new HostGame({ secret: SECRET, winScore: 11, port: 0, handlers: {} });
const port = host.start();

let welcomed = false;
const client = new ClientGame({
    host: '127.0.0.1', port, secret: SECRET,
    handlers: { welcome: () => { welcomed = true; }, error: (e) => logError(e) },
});
client.connect();

let frame = 0;
let syncSamples = 0;
let syncGood = 0;
let scoresMatched = 0;

function startLoop() {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
        // Phase A (frames < 120): both paddles chase the ball to sustain a
        // rally so there's a moving ball to compare.
        // Phase B (>= 120): client holds a distinctive Y so we can prove that
        // input actually reaches the host's right paddle.
        if (frame < 120) {
            host.setLocalPaddle(host.engine.ball.y);
            client.setLocalPaddle(client.engine.ball.y);
        } else {
            client.setLocalPaddle(180);
        }

        host.tick(DT);
        client.tick(DT);

        // Sample sync during the rally (after warmup, before phase B).
        if (frame > 40 && frame < 118) {
            syncSamples++;
            const dx = Math.abs(client.engine.ball.x - host.engine.ball.x);
            const dy = Math.abs(client.engine.ball.y - host.engine.ball.y);
            if (dx < 120 && dy < 120) syncGood++;
            if (Math.abs((client.engine.scoreL + client.engine.scoreR) -
                (host.engine.scoreL + host.engine.scoreR)) <= 1) scoresMatched++;
        }

        frame++;
        if (frame >= 150) {
            finish();
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    });
}

function finish() {
    check('client got welcomed', welcomed === true);
    check('client received a live game state',
        client.engine.state === C.State.PLAYING || client.engine.state === C.State.SERVING);
    check('ball stayed in sync during the rally',
        syncSamples > 0 && syncGood / syncSamples > 0.9);
    check('scores stayed consistent', syncSamples > 0 && scoresMatched / syncSamples > 0.9);
    // Phase B: client held Y=180 → host's right paddle should have followed.
    const rc = host.engine.right.y + host.engine.right.h / 2;
    check('client input reached the host paddle', Math.abs(rc - 180) < 6);

    host.stop();
    client.stop();
    loop.quit();
}

// Wait for the handshake, then drive the loop.
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
    if (welcomed) {
        startLoop();
        return GLib.SOURCE_REMOVE;
    }
    return GLib.SOURCE_CONTINUE;
});

GLib.timeout_add(GLib.PRIORITY_DEFAULT, 6000, () => { loop.quit(); return GLib.SOURCE_REMOVE; });

loop.run();

for (const l of lines) print(l);
print(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0)
    imports.system.exit(1);