#!/usr/bin/env -S gjs -m
// Headless physics smoke test — run: gjs -m tests/engine-smoke.js
import * as C from '../gnomepong@vanvonvan.github.io/lib/constants.js';
import { GameEngine } from '../gnomepong@vanvonvan.github.io/lib/game.js';

let failures = 0;
function check(name, cond) {
    print(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!cond)
        failures++;
}

const DT = 1 / 60;

// 1) Perfect paddles (instantly track the ball) must NEVER concede a point.
//    This is the real anti-tunneling guarantee: a well-placed paddle always
//    returns the ball, even at max speed.
const e = new GameEngine();
e.start(C.Mode.TWO_PLAYER, 11);
for (let i = 0; i < 40000; i++) {
    e.setPaddleCenter(C.Side.LEFT, e.ball.y);
    e.setPaddleCenter(C.Side.RIGHT, e.ball.y);
    e.step(DT);
}
check('perfect paddles are never scored on (no tunneling)', e.scoreL === 0 && e.scoreR === 0);
check('ball stays on the field with perfect paddles',
    e.ball.x > 0 && e.ball.x < C.VIRT_W);

// 1b) With both paddles parked at the top, mid-height serves are always
//     missed, so the match must reach a clean GAME_OVER.
const em = new GameEngine();
em.start(C.Mode.TWO_PLAYER, 5);
let steps = 0;
while (em.state !== C.State.GAME_OVER && steps < 200000) {
    em.setPaddleCenter(C.Side.LEFT, C.WALL);  // clamps to the very top
    em.setPaddleCenter(C.Side.RIGHT, C.WALL);
    em.step(DT);
    steps++;
}
check('match reaches GAME_OVER', em.state === C.State.GAME_OVER);
check('winner is a valid side', em.winner === C.Side.LEFT || em.winner === C.Side.RIGHT);
check('a winner actually hit winScore', em.scoreL === 5 || em.scoreR === 5);
check('total points equals winning score (shutout)', em.scoreL + em.scoreR === 5);

// 2) Ball speeds up after a paddle hit.
const e2 = new GameEngine();
e2.start(C.Mode.TWO_PLAYER, 11);
e2.launch(C.Side.LEFT); // toward left paddle
const s0 = Math.hypot(e2.ball.vx, e2.ball.vy);
let hit = false;
for (let i = 0; i < 2000 && !hit; i++) {
    e2.setPaddleCenter(C.Side.LEFT, e2.ball.y);
    const ev = e2.step(DT);
    if (ev.includes('paddle'))
        hit = true;
}
const s1 = Math.hypot(e2.ball.vx, e2.ball.vy);
check('paddle hit registered', hit);
check('ball speeds up on paddle hit', s1 > s0);

// 3) Missing the ball scores for the other side.
const e3 = new GameEngine();
e3.start(C.Mode.TWO_PLAYER, 11);
e3.launch(C.Side.LEFT); // heads left; right paddle does nothing -> parks at left wall
let scored = null;
for (let i = 0; i < 3000 && !scored; i++) {
    // Left paddle parks at top so it misses.
    e3.setPaddleCenter(C.Side.LEFT, 0);
    const ev = e3.step(DT);
    for (const x of ev)
        if (typeof x === 'object' && x.score)
            scored = x.score;
}
check('a missed ball scores', scored === C.Side.RIGHT);

print(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0)
    imports.system.exit(1);
