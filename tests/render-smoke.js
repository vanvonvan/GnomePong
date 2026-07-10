#!/usr/bin/env -S gjs -m
// Exercise render.draw() with a mock Cairo context so logic errors surface
// without a live shell. Run: gjs -m tests/render-smoke.js
import * as C from '../gnomepong@vanvonvan.github.io/lib/constants.js';
import * as Render from '../gnomepong@vanvonvan.github.io/lib/render.js';
import { GameEngine } from '../gnomepong@vanvonvan.github.io/lib/game.js';
import { Menu } from '../gnomepong@vanvonvan.github.io/lib/menu.js';

let ops = 0;
const cr = {
    setSourceRGB() {},
    setSourceRGBA() {},
    setLineWidth() {},
    stroke() {},
    rectangle(x, y, w, h) {
        if ([x, y, w, h].some((v) => typeof v !== 'number' || Number.isNaN(v)))
            throw new Error(`bad rectangle args: ${x},${y},${w},${h}`);
        ops++;
    },
    fill() {},
    // Cairo text API used by menus.
    selectFontFace() {},
    setFontSize() {},
    moveTo() {},
    showText() {},
    textExtents() { return { width: 40, height: 12, xBearing: 0, yBearing: -12, xAdvance: 40, yAdvance: 0 }; },
};

const colors = {
    bg: { r: 0, g: 0, b: 0 }, net: { r: 1, g: 1, b: 1 }, ball: { r: 1, g: 1, b: 1 },
    paddleL: { r: 1, g: 1, b: 1 }, paddleR: { r: 1, g: 1, b: 1 }, score: { r: 1, g: 1, b: 1 },
};

const e = new GameEngine();
let failures = 0;
const check = (name, cond) => {
    print(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!cond) failures++;
};

// Menu screen.
e.state = C.State.MENU;
ops = 0;
Render.draw(cr, 1920, 1080, e, colors);
check('menu draws some rectangles', ops > 0);

// Playing screen with two-digit scores (exercises multi-digit + all segments).
e.start(C.Mode.TWO_PLAYER, 11);
e.state = C.State.PLAYING;
e.scoreL = 10; e.scoreR = 7;
ops = 0;
Render.draw(cr, 1280, 800, e, colors);
check('playing draws rectangles', ops > 0);

// Viewport centers correctly on a wide screen (height is the limiting axis).
const vp = Render.viewport(2000, 700);
check('viewport scale correct', Math.abs(vp.scale - 1.0) < 1e-9);
check('viewport letterboxes horizontally', Math.abs(vp.offX - 500) < 1e-9 && Math.abs(vp.offY) < 1e-9);

// Every digit 0-9 renders without throwing.
let allDigits = true;
for (let d = 0; d <= 9; d++) {
    e.scoreL = d; e.scoreR = d;
    try { Render.draw(cr, 1000, 700, e, colors); } catch (_e) { allDigits = false; }
}
check('all digits 0-9 render', allDigits);

// Menu drawing (with and without scrim) and hit-testing.
const pauseMenu = new Menu('Paused', [
    { label: 'Resume', action() {} },
    { label: 'Restart', action() {} },
    { label: 'Main Menu', action() {} },
    { label: 'Quit', action() {} },
]);
let menuOk = true;
try {
    Render.drawMenu(cr, 1280, 800, pauseMenu, colors, { scrim: true });
    const noHeadingMenu = new Menu(null, [{ label: '1 Player', action() {} }]);
    Render.drawMenu(cr, 1280, 800, noHeadingMenu, colors, { scrim: false });
} catch (_e) {
    menuOk = false;
}
check('menu draws (heading + scrim + items)', menuOk);

// A click at the center of item 2 should hit index 1.
const L = Render.menuLayout(1280, 800, pauseMenu);
const b = L.items[1];
check('menuHit finds the item under the point',
    Render.menuHit(1280, 800, pauseMenu, b.x + b.w / 2, b.y + b.h / 2) === 1);
check('menuHit misses empty space', Render.menuHit(1280, 800, pauseMenu, 5, 5) === -1);

print(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0)
    imports.system.exit(1);