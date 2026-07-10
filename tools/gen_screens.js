#!/usr/bin/env -S gjs -m
// Generate authentic GnomePong screenshots by driving the REAL renderer
// (lib/render.js) into a Cairo image surface — no running shell needed, so the
// shots always match what the game actually draws.
//
// Run:  gjs -m tools/gen_screens.js   (writes into assets/screenshots/)

import cairo from 'gi://cairo';
import GLib from 'gi://GLib';

import * as C from '../gnomepong@vanvonvan.github.io/lib/constants.js';
import * as Render from '../gnomepong@vanvonvan.github.io/lib/render.js';
import { GameEngine } from '../gnomepong@vanvonvan.github.io/lib/game.js';
import { Menu } from '../gnomepong@vanvonvan.github.io/lib/menu.js';

const [scriptPath] = GLib.filename_from_uri(import.meta.url);
const repoRoot = GLib.path_get_dirname(GLib.path_get_dirname(scriptPath));
const outDir = GLib.build_filenamev([repoRoot, 'assets', 'screenshots']);
GLib.mkdir_with_parents(outDir, 0o755);

// 10:7 to exactly match the virtual field (no letterbox bars).
const W = 1400, H = 980;

const hex = (s) => C.hexToRgb(s);
const COLORS = {
    bg: hex('#05060a'),      // near-black with a faint cool tint
    net: hex('#7fb0c8'),     // cool grey-blue court markings
    ball: hex('#ffffff'),
    paddleL: hex('#ffffff'),
    paddleR: hex('#5fd7ff'), // cyan right paddle — nods to 2P / multiplayer
    score: hex('#eaf6ff'),
};

function surface() {
    const s = new cairo.ImageSurface(cairo.Format.ARGB32, W, H);
    const cr = new cairo.Context(s);
    return { s, cr };
}

function save(s, name) {
    const path = GLib.build_filenamev([outDir, name]);
    s.writeToPNG(path);
    print(`wrote ${path}`);
}

// --- Main menu (attract screen: blocky PONG title + menu, Host highlighted) ---
{
    const e = new GameEngine();
    e.state = C.State.MENU;
    const menu = new Menu(null, [
        { label: '1 Player  (vs AI)' },
        { label: '2 Players  (local)' },
        { label: 'Host game' },
        { label: 'Join game' },
        { label: 'Quit' },
    ]);
    menu.selected = 2; // highlight "Host game"
    const { s, cr } = surface();
    Render.draw(cr, W, H, e, COLORS);
    Render.drawMenu(cr, W, H, menu, COLORS, { scrim: false });
    cr.$dispose();
    save(s, 'menu.png');
}

// --- Mid-rally gameplay ---
{
    const e = new GameEngine();
    e.start(C.Mode.TWO_PLAYER, 11);
    e.state = C.State.PLAYING;
    e.scoreL = 7;
    e.scoreR = 4;
    e.ball.x = 632;
    e.ball.y = 296;
    e.left.y = 250;
    e.right.y = 300;
    const { s, cr } = surface();
    Render.draw(cr, W, H, e, COLORS);
    cr.$dispose();
    save(s, 'gameplay.png');
}

// --- Game over ---
{
    const e = new GameEngine();
    e.start(C.Mode.ONE_PLAYER, 11);
    e.state = C.State.GAME_OVER;
    e.scoreL = 11;
    e.scoreR = 8;
    e.winner = C.Side.LEFT;
    e.left.y = 300;
    e.right.y = 360;
    e.ball.x = 940;
    e.ball.y = 470;
    const menu = new Menu('Left player wins', [
        { label: 'Play Again' },
        { label: 'Main Menu' },
        { label: 'Quit' },
    ]);
    menu.selected = 0;
    const { s, cr } = surface();
    Render.draw(cr, W, H, e, COLORS);
    Render.drawMenu(cr, W, H, menu, COLORS, { scrim: true });
    cr.$dispose();
    save(s, 'gameover.png');
}
