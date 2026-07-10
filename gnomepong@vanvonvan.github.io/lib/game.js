// Pure Pong simulation. No GNOME/Clutter imports — the same engine drives the
// local game and (later) the host-authoritative netplay. Controllers move the
// paddles; step() advances the ball, resolves collisions, and scores.

import * as C from './constants.js';

export class GameEngine {
    constructor() {
        this.state = C.State.MENU;
        this.mode = C.Mode.ONE_PLAYER;
        this.winScore = 11;
        this.scoreL = 0;
        this.scoreR = 0;
        this.serveTimer = 0;
        this._serveToward = C.Side.LEFT;
        this.winner = null;

        this.ball = { x: C.VIRT_W / 2, y: C.VIRT_H / 2, vx: 0, vy: 0, r: C.BALL_SIZE / 2 };
        this.left = { x: C.PADDLE_MARGIN, y: (C.VIRT_H - C.PADDLE_H) / 2, w: C.PADDLE_W, h: C.PADDLE_H };
        this.right = {
            x: C.VIRT_W - C.PADDLE_MARGIN - C.PADDLE_W,
            y: (C.VIRT_H - C.PADDLE_H) / 2,
            w: C.PADDLE_W,
            h: C.PADDLE_H,
        };
    }

    paddle(side) {
        return side === C.Side.LEFT ? this.left : this.right;
    }

    paddleCenter(side) {
        const p = this.paddle(side);
        return p.y + p.h / 2;
    }

    // Start a fresh match.
    start(mode, winScore) {
        this.mode = mode;
        this.winScore = Math.max(1, winScore | 0);
        this.scoreL = 0;
        this.scoreR = 0;
        this.winner = null;
        this.left.y = (C.VIRT_H - C.PADDLE_H) / 2;
        this.right.y = (C.VIRT_H - C.PADDLE_H) / 2;
        // Loser of the imaginary previous rally serves; pick a random start.
        this._serveToward = Math.random() < 0.5 ? C.Side.LEFT : C.Side.RIGHT;
        this._park();
    }

    // Park the ball at center and enter the serve countdown.
    _park() {
        this.ball.x = C.VIRT_W / 2;
        this.ball.y = C.VIRT_H / 2;
        this.ball.vx = 0;
        this.ball.vy = 0;
        this.serveTimer = C.SERVE_DELAY;
        this.state = C.State.SERVING;
    }

    // Launch the parked ball toward `side` (defaults to the serving side).
    launch(side = this._serveToward) {
        if (this.state !== C.State.SERVING)
            return;
        const dir = side === C.Side.LEFT ? -1 : 1;
        // Small random vertical angle so serves aren't identical.
        const angle = (Math.random() * 2 - 1) * C.MAX_BOUNCE_ANGLE * 0.35;
        const speed = C.BALL_SPEED_START;
        this.ball.vx = dir * speed * Math.cos(angle);
        this.ball.vy = speed * Math.sin(angle);
        this.state = C.State.PLAYING;
    }

    // Move a paddle by dy (virtual units), clamped to the field.
    movePaddleBy(side, dy) {
        const p = this.paddle(side);
        p.y = this._clampPaddle(p.y + dy);
    }

    // Set a paddle so its center sits at cy (used for mouse control).
    setPaddleCenter(side, cy) {
        const p = this.paddle(side);
        p.y = this._clampPaddle(cy - p.h / 2);
    }

    _clampPaddle(y) {
        const min = C.WALL;
        const max = C.VIRT_H - C.WALL - C.PADDLE_H;
        return Math.max(min, Math.min(max, y));
    }

    // Advance the simulation by dt seconds. Returns a list of events, e.g.
    // 'wall', 'paddle', {score: 'left'|'right'}, 'win'. Controllers should have
    // already positioned the paddles for this frame.
    step(dt) {
        const events = [];
        if (this.state === C.State.SERVING) {
            this.serveTimer -= dt;
            if (this.serveTimer <= 0)
                this.launch();
            return events;
        }
        if (this.state !== C.State.PLAYING)
            return events;

        const b = this.ball;
        const speed = Math.hypot(b.vx, b.vy) || C.BALL_SPEED_START;
        // Sub-step so a fast ball can't tunnel through a thin paddle.
        const maxStep = b.r; // move at most one radius per sub-step
        const nSteps = Math.max(1, Math.ceil((speed * dt) / maxStep));
        const sdt = dt / nSteps;

        for (let i = 0; i < nSteps; i++) {
            b.x += b.vx * sdt;
            b.y += b.vy * sdt;

            // Top / bottom walls.
            if (b.y - b.r < C.WALL && b.vy < 0) {
                b.y = C.WALL + b.r;
                b.vy = -b.vy;
                events.push('wall');
            } else if (b.y + b.r > C.VIRT_H - C.WALL && b.vy > 0) {
                b.y = C.VIRT_H - C.WALL - b.r;
                b.vy = -b.vy;
                events.push('wall');
            }

            // Paddles.
            if (b.vx < 0 && this._hitPaddle(this.left)) {
                this._bounceOffPaddle(this.left, +1);
                events.push('paddle');
            } else if (b.vx > 0 && this._hitPaddle(this.right)) {
                this._bounceOffPaddle(this.right, -1);
                events.push('paddle');
            }

            // Scoring — ball fully past a side.
            if (b.x + b.r < 0) {
                this._score(C.Side.RIGHT, events);
                break;
            } else if (b.x - b.r > C.VIRT_W) {
                this._score(C.Side.LEFT, events);
                break;
            }
        }
        return events;
    }

    _hitPaddle(p) {
        const b = this.ball;
        const face = p.x < C.VIRT_W / 2 ? p.x + p.w : p.x; // inner face x
        // Horizontal overlap with the paddle face (with a little tolerance).
        const withinX = p.x < C.VIRT_W / 2
            ? b.x - b.r <= p.x + p.w && b.x + b.r >= p.x
            : b.x + b.r >= p.x && b.x - b.r <= p.x + p.w;
        const withinY = b.y + b.r >= p.y && b.y - b.r <= p.y + p.h;
        if (withinX && withinY) {
            this._lastFace = face;
            return true;
        }
        return false;
    }

    _bounceOffPaddle(p, dir) {
        const b = this.ball;
        const offset = Math.max(-1, Math.min(1, (b.y - (p.y + p.h / 2)) / (p.h / 2)));
        const angle = offset * C.MAX_BOUNCE_ANGLE;
        const speed = Math.min(Math.hypot(b.vx, b.vy) * C.BALL_SPEEDUP, C.BALL_SPEED_MAX);
        b.vx = dir * speed * Math.cos(angle);
        b.vy = speed * Math.sin(angle);
        // Nudge the ball out of the paddle so it can't re-trigger next sub-step.
        b.x = dir > 0 ? p.x + p.w + b.r : p.x - b.r;
    }

    _score(side, events) {
        if (side === C.Side.LEFT)
            this.scoreL++;
        else
            this.scoreR++;
        events.push({ score: side });
        // The player who was scored against receives the next serve.
        this._serveToward = side === C.Side.LEFT ? C.Side.RIGHT : C.Side.LEFT;
        if (this.scoreL >= this.winScore || this.scoreR >= this.winScore) {
            this.winner = this.scoreL > this.scoreR ? C.Side.LEFT : C.Side.RIGHT;
            this.state = C.State.GAME_OVER;
            events.push('win');
        } else {
            this._park();
        }
    }

    pause() {
        if (this.state === C.State.PLAYING || this.state === C.State.SERVING) {
            this._resumeState = this.state;
            this.state = C.State.PAUSED;
        } else if (this.state === C.State.PAUSED) {
            this.state = this._resumeState || C.State.PLAYING;
        }
    }
}
