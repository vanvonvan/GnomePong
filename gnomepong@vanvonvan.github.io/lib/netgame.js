// Host-authoritative networked game, built on top of net.js + the pure engine.
//
// Host: runs the real simulation. Left paddle = host's local input, right
// paddle = the joined client's input. Broadcasts the full state (plus this
// frame's events, so both sides can play sound) every tick.
//
// Client: runs no physics. It renders whatever the host sends, but predicts
// its OWN (right) paddle from local input so it feels responsive despite RTT.
//
// Both expose `.engine` — a GameEngine-shaped object the renderer draws as-is.

import * as C from './constants.js';
import { GameEngine } from './game.js';
import { NetHost, NetClient } from './net.js';

function serialize(engine, events) {
    return {
        ball: { x: engine.ball.x, y: engine.ball.y },
        lY: engine.left.y,
        rY: engine.right.y,
        sL: engine.scoreL,
        sR: engine.scoreR,
        st: engine.state,
        win: engine.winner,
        ev: events,
    };
}

function apply(engine, s) {
    engine.ball.x = s.ball.x;
    engine.ball.y = s.ball.y;
    engine.left.y = s.lY;
    engine.right.y = s.rY;
    engine.scoreL = s.sL;
    engine.scoreR = s.sR;
    engine.state = s.st;
    engine.winner = s.win;
}

export class HostGame {
    // handlers: { connected(), closed(reason), error(e), events(list) }
    constructor({ secret, winScore, port = 0, handlers = {} }) {
        this.engine = new GameEngine();
        this.engine.start(C.Mode.NET, winScore);
        this._winScore = winScore;
        this._localY = C.VIRT_H / 2;
        this._clientY = C.VIRT_H / 2;
        this._connected = false;
        this._handlers = handlers;
        this._net = new NetHost({
            port,
            secret,
            handlers: {
                connected: () => { this._connected = true; this._handlers.connected?.(); },
                input: (y) => { this._clientY = y; },
                closed: (r) => { this._connected = false; this._handlers.closed?.(r); },
                error: (e) => this._handlers.error?.(e),
            },
        });
    }

    start() { return this._net.start(); }
    get connected() { return this._connected; }

    // Virtual-space center Y for the host's own (left) paddle.
    setLocalPaddle(virtualY) { this._localY = virtualY; }

    serve() { if (this.engine.state === C.State.SERVING) this.engine.launch(); }

    restart() {
        this.engine.start(C.Mode.NET, this._winScore);
    }

    tick(dt) {
        const e = this.engine;
        e.setPaddleCenter(C.Side.LEFT, this._localY);
        e.setPaddleCenter(C.Side.RIGHT, this._clientY);
        let events = [];
        if (this._connected) {
            events = e.step(dt);
            this._net.sendState(serialize(e, events));
        }
        return events;
    }

    stop() { this._net.stop(); }
}

export class ClientGame {
    // handlers: { welcome(side), rejected(reason), closed(reason), error(e), events(list) }
    constructor({ host, port, secret, handlers = {} }) {
        this.engine = new GameEngine();
        this.engine.state = C.State.SERVING; // until the first state arrives
        this._localY = C.VIRT_H / 2;
        this._welcomed = false;
        this._handlers = handlers;
        this._net = new NetClient({
            host,
            port,
            secret,
            handlers: {
                welcome: (side) => { this._welcomed = true; this._handlers.welcome?.(side); },
                rejected: (r) => this._handlers.rejected?.(r),
                closed: (r) => this._handlers.closed?.(r),
                error: (e) => this._handlers.error?.(e),
                state: (s) => {
                    apply(this.engine, s);
                    if (s.ev && s.ev.length)
                        this._handlers.events?.(s.ev);
                },
            },
        });
    }

    connect() { this._net.connect(); }
    get welcomed() { return this._welcomed; }

    // Virtual-space center Y for the client's own (right) paddle.
    setLocalPaddle(virtualY) { this._localY = virtualY; }

    tick(_dt) {
        // Send our input at the tick rate, and predict our own paddle locally
        // so it doesn't wait a round-trip to move.
        if (this._welcomed) {
            this._net.sendInput(this._localY);
            this.engine.setPaddleCenter(C.Side.RIGHT, this._localY);
        }
    }

    stop() { this._net.stop(); }
}
