// A single, balanced AI paddle controller — challenging but beatable.
//
// It tracks the ball with a capped speed (slower than the ball can move
// vertically, so hard-angled shots can beat it), reacts only once the ball is
// heading its way, aims at a slightly wrong spot (a bias that re-rolls each
// rally), and drifts back toward center when the ball is moving away.

import * as C from './constants.js';

const AI_SPEED = 470;        // max paddle speed (u/s) — < human's 720
const RETURN_SPEED = 300;    // lazier drift back to center
const DEADZONE = 8;          // don't jitter when basically aligned
const MAX_BIAS = 46;         // how far off-center it can aim (u)

export class AIController {
    constructor(side) {
        this.side = side;
        this._bias = 0;
        this._lastVxSign = 0;
    }

    // Move the AI's paddle for this frame.
    update(engine, dt) {
        const ball = engine.ball;
        const center = engine.paddleCenter(this.side);
        const approaching = this.side === C.Side.RIGHT ? ball.vx > 0 : ball.vx < 0;

        // Re-roll the aim error whenever the ball reverses horizontally, so
        // each incoming shot is misjudged by a fresh, small amount.
        const vxSign = Math.sign(ball.vx);
        if (vxSign !== 0 && vxSign !== this._lastVxSign) {
            this._bias = (Math.random() * 2 - 1) * MAX_BIAS;
            this._lastVxSign = vxSign;
        }

        let target, speed;
        if (engine.state !== C.State.PLAYING) {
            target = C.VIRT_H / 2; // recenter between points
            speed = RETURN_SPEED;
        } else if (approaching) {
            target = ball.y + this._bias;
            speed = AI_SPEED;
        } else {
            target = C.VIRT_H / 2;
            speed = RETURN_SPEED;
        }

        const delta = target - center;
        if (Math.abs(delta) <= DEADZONE)
            return;
        const step = Math.min(Math.abs(delta), speed * dt) * Math.sign(delta);
        engine.movePaddleBy(this.side, step);
    }
}