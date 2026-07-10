#!/usr/bin/env -S gjs -m
// Standalone GTK4 preview of GnomePong — reuses the exact game/ai/render/menu/
// net modules the extension uses, so it can be played and tuned without the
// shell (which won't nest on this NVIDIA/mutter-50.1 box). No sound (shell-only).
//
// Run:  gjs -m tools/preview.js   (or: make preview)
// Net:  launch two copies; one Host game, the other Join with the shown
//       address + secret (use 127.0.0.1:7777 on the same machine).

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import system from 'system';

import * as C from '../gnomepong@vanvonvan.github.io/lib/constants.js';
import * as Render from '../gnomepong@vanvonvan.github.io/lib/render.js';
import { GameEngine } from '../gnomepong@vanvonvan.github.io/lib/game.js';
import { AIController } from '../gnomepong@vanvonvan.github.io/lib/ai.js';
import { Menu } from '../gnomepong@vanvonvan.github.io/lib/menu.js';
import { HostGame, ClientGame } from '../gnomepong@vanvonvan.github.io/lib/netgame.js';
import { guessLocalIP, parseAddress, DEFAULT_PORT } from '../gnomepong@vanvonvan.github.io/lib/net.js';

// --- Settings / colors ---
const [scriptPath] = GLib.filename_from_uri(import.meta.url);
const repoRoot = GLib.path_get_dirname(GLib.path_get_dirname(scriptPath));
const schemasDir = GLib.build_filenamev([repoRoot, 'gnomepong@vanvonvan.github.io', 'schemas']);

let settings = null;
try {
    const src = Gio.SettingsSchemaSource.new_from_directory(
        schemasDir, Gio.SettingsSchemaSource.get_default(), false);
    const schema = src.lookup('org.gnome.shell.extensions.gnomepong', false);
    if (schema)
        settings = new Gio.Settings({ settings_schema: schema });
} catch (e) {
    logError(e, 'GnomePong preview: schema load failed; default colors');
}

const DEFAULTS = {
    [C.Keys.COLOR_BG]: '#000000', [C.Keys.COLOR_NET]: '#c8c8c8',
    [C.Keys.COLOR_BALL]: '#ffffff', [C.Keys.COLOR_PADDLE_L]: '#ffffff',
    [C.Keys.COLOR_PADDLE_R]: '#ffffff', [C.Keys.COLOR_SCORE]: '#ffffff',
};
const getStr = (k) => (settings ? settings.get_string(k) : DEFAULTS[k]);
const winScore = () => (settings ? settings.get_int(C.Keys.WIN_SCORE) : 11);
function readColors() {
    return {
        bg: C.hexToRgb(getStr(C.Keys.COLOR_BG)), net: C.hexToRgb(getStr(C.Keys.COLOR_NET)),
        ball: C.hexToRgb(getStr(C.Keys.COLOR_BALL)), paddleL: C.hexToRgb(getStr(C.Keys.COLOR_PADDLE_L)),
        paddleR: C.hexToRgb(getStr(C.Keys.COLOR_PADDLE_R)), score: C.hexToRgb(getStr(C.Keys.COLOR_SCORE)),
    };
}

// --- State ---
const engine = new GameEngine();   // local (1P/2P) game
let ai = null;
let net = null;                    // HostGame | ClientGame while networking
let netRole = null;                // 'host' | 'client'
let colors = readColors();
let pointerY = C.VIRT_H / 2;
const keys = new Set();

let menu = null;     // current Menu (main/pause/over), or null while playing
let info = null;     // non-interactive info screen (host wait / connecting / error)
let mainMenu, pauseMenu;

// Optional CLI automation for testing: --host [secret] | --join <addr> [secret]
const argv = system.programArgs;
let autoHost = null;
let autoJoin = null;
if (argv[0] === '--host') autoHost = argv[1] || 'TESTSECRET';
else if (argv[0] === '--join') autoJoin = { addr: argv[1] || '127.0.0.1:7777', secret: argv[2] || '' };

let area = null;     // Gtk.DrawingArea
let joinBox = null;  // Gtk.Box (join form)
let addrEntry, secretEntry;

// The engine currently being rendered.
const view = () => (net ? net.engine : engine);

function mouseVirtualY() {
    const vp = Render.viewport(area.get_width(), area.get_height());
    return vp.scale > 0 ? (pointerY - vp.offY) / vp.scale : C.VIRT_H / 2;
}

function randomSecret() {
    const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 5; i++)
        s += a[Math.floor(Math.random() * a.length)];
    return s;
}

// --- Local game flow ---
function startMatch(mode) {
    teardownNet();
    engine.start(mode, winScore());
    ai = mode === C.Mode.ONE_PLAYER ? new AIController(C.Side.RIGHT) : null;
    menu = null;
    info = null;
}
function openMain() {
    teardownNet();
    engine.state = C.State.MENU;
    ai = null;
    menu = mainMenu;
    info = null;
    hideJoin();
}
function openPause() {
    if (engine.state === C.State.PLAYING || engine.state === C.State.SERVING) {
        engine.pause();
        menu = pauseMenu;
    }
}
function resume() {
    if (engine.state === C.State.PAUSED) {
        engine.pause();
        menu = null;
    }
}
function gameOverMenu(quit, restartAction) {
    const who = view().winner === C.Side.LEFT ? 'Left' : 'Right';
    return new Menu(`${who} player wins`, [
        { label: 'Play Again', action: restartAction },
        { label: 'Main Menu', action: openMain },
        { label: 'Quit', action: quit },
    ]);
}

// --- Networking flow ---
function teardownNet() {
    if (net) {
        net.stop();
        net = null;
    }
    netRole = null;
}

function startHost(quit, forcedSecret) {
    teardownNet();
    const secret = forcedSecret || randomSecret();
    net = new HostGame({
        secret, winScore: winScore(), port: DEFAULT_PORT,
        handlers: {
            connected: () => { printerr('[host] player connected'); info = null; menu = null; },
            closed: () => {
                printerr('[host] connection closed');
                if (netRole === 'host' && net) {
                    info = errorInfo('Player disconnected', quit);
                    teardownNet();
                }
            },
            error: (e) => logError(e, 'host'),
        },
    });
    netRole = 'host';
    menu = null;
    let port;
    try {
        port = net.start();
    } catch (e) {
        teardownNet();
        info = errorInfo(`Could not host: ${e.message || e}`, quit);
        return;
    }
    const ip = guessLocalIP() || 'your-LAN-IP';
    info = {
        title: 'Hosting — waiting for player',
        lines: [`Address:   ${ip}:${port}`, `Secret:    ${secret}`],
        hint: 'Esc to cancel',
        scrim: true,
        esc: openMain,
    };
}

function connectJoin(quit) {
    const parsed = parseAddress(addrEntry.get_text());
    if (!parsed) {
        info = errorInfo('Enter an address like 192.168.1.5:7777', quit);
        return;
    }
    hideJoin();
    teardownNet();
    net = new ClientGame({
        host: parsed.host, port: parsed.port, secret: secretEntry.get_text(),
        handlers: {
            welcome: (side) => { printerr(`[client] welcomed as ${side}`); info = null; menu = null; },
            rejected: (r) => { printerr(`[client] rejected: ${r}`); info = errorInfo(`Rejected: ${r}`, quit); teardownNet(); },
            closed: (r) => {
                const welcomed = net && net.welcomed;
                printerr(`[client] closed: ${r}`);
                info = errorInfo(welcomed ? 'Host disconnected' : `Could not connect (${r})`, quit);
                teardownNet();
            },
            error: (e) => logError(e, 'client'),
        },
    });
    netRole = 'client';
    info = { title: 'Connecting…', lines: [`${parsed.host}:${parsed.port}`], hint: 'Esc to cancel', scrim: true, esc: openMain };
    net.connect();
}

function errorInfo(message, quit) {
    return {
        title: 'Disconnected',
        lines: [message],
        hint: 'Enter / Esc — back to menu',
        scrim: true,
        esc: openMain,
        enter: openMain,
        quit,
    };
}

// --- Join form (GTK widgets) ---
function buildJoinForm(quit) {
    joinBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 12,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
    });
    const title = new Gtk.Label({ label: '<b>Join game</b>', use_markup: true });
    addrEntry = new Gtk.Entry({ placeholder_text: '192.168.1.5:7777', width_request: 320 });
    secretEntry = new Gtk.Entry({ placeholder_text: 'secret', width_request: 320 });
    addrEntry.connect('activate', () => secretEntry.grab_focus());
    secretEntry.connect('activate', () => connectJoin(quit));

    const row = new Gtk.Box({ spacing: 8, halign: Gtk.Align.CENTER });
    const connectBtn = new Gtk.Button({ label: 'Connect' });
    const cancelBtn = new Gtk.Button({ label: 'Cancel' });
    connectBtn.add_css_class('suggested-action');
    connectBtn.connect('clicked', () => connectJoin(quit));
    cancelBtn.connect('clicked', () => openMain());
    row.append(connectBtn);
    row.append(cancelBtn);

    joinBox.append(title);
    joinBox.append(new Gtk.Label({ label: 'Host address (ip:port)' }));
    joinBox.append(addrEntry);
    joinBox.append(new Gtk.Label({ label: 'Secret' }));
    joinBox.append(secretEntry);
    joinBox.append(row);
    joinBox.visible = false;
    return joinBox;
}
function showJoin() {
    teardownNet();
    engine.state = C.State.MENU;
    menu = null;
    info = null;
    joinBox.visible = true;
    addrEntry.grab_focus();
}
function hideJoin() {
    if (joinBox)
        joinBox.visible = false;
}
const joinVisible = () => joinBox && joinBox.visible;

// --- Input ---
function onKeyDown(keyval, quit) {
    if (joinVisible()) {
        if (keyval === Gdk.KEY_Escape) { openMain(); return true; }
        return false; // let the entries type
    }
    if (info) {
        if (keyval === Gdk.KEY_Escape) info.esc?.();
        else if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) (info.enter || info.esc)?.();
        return true;
    }
    if (menu) {
        switch (keyval) {
            case Gdk.KEY_Up: menu.move(-1); return true;
            case Gdk.KEY_Down: menu.move(1); return true;
            case Gdk.KEY_Return: case Gdk.KEY_KP_Enter: case Gdk.KEY_space:
                menu.activate(); return true;
            case Gdk.KEY_Escape:
                if (menu === pauseMenu) resume();
                else if (menu === mainMenu) quit();
                else openMain();
                return true;
            case Gdk.KEY_1: if (menu === mainMenu) startMatch(C.Mode.ONE_PLAYER); return true;
            case Gdk.KEY_2: if (menu === mainMenu) startMatch(C.Mode.TWO_PLAYER); return true;
        }
        return true;
    }
    // Playing.
    if (net) {
        switch (keyval) {
            case Gdk.KEY_Escape: case Gdk.KEY_p: case Gdk.KEY_P:
                if (netRole === 'host') openNetPause(quit);
                else openMain(); // client leaves
                return true;
            case Gdk.KEY_space:
                if (netRole === 'host') net.serve();
                return true;
            case Gdk.KEY_r: case Gdk.KEY_R:
                if (netRole === 'host') net.restart();
                return true;
        }
        return true;
    }
    switch (keyval) {
        case Gdk.KEY_Escape: case Gdk.KEY_p: case Gdk.KEY_P: openPause(); return true;
        case Gdk.KEY_w: case Gdk.KEY_W: keys.add('lup'); return true;
        case Gdk.KEY_s: case Gdk.KEY_S: keys.add('ldown'); return true;
        case Gdk.KEY_Up: keys.add('rup'); return true;
        case Gdk.KEY_Down: keys.add('rdown'); return true;
        case Gdk.KEY_space: if (engine.state === C.State.SERVING) engine.launch(); return true;
        case Gdk.KEY_r: case Gdk.KEY_R: startMatch(engine.mode); return true;
    }
    return true;
}

function onKeyUp(keyval) {
    switch (keyval) {
        case Gdk.KEY_w: case Gdk.KEY_W: keys.delete('lup'); break;
        case Gdk.KEY_s: case Gdk.KEY_S: keys.delete('ldown'); break;
        case Gdk.KEY_Up: keys.delete('rup'); break;
        case Gdk.KEY_Down: keys.delete('rdown'); break;
    }
}

let netPauseMenu = null;
function openNetPause(quit) {
    engine; // host uses net.engine
    net.engine.pause();
    netPauseMenu = new Menu('Paused', [
        { label: 'Resume', action: () => { net.engine.pause(); menu = null; } },
        { label: 'Restart', action: () => { net.restart(); menu = null; } },
        { label: 'Disconnect', action: openMain },
    ]);
    menu = netPauseMenu;
}

function applyLocalInput(dt) {
    if (engine.mode === C.Mode.ONE_PLAYER) {
        engine.setPaddleCenter(C.Side.LEFT, mouseVirtualY());
    } else if (engine.mode === C.Mode.TWO_PLAYER) {
        if (keys.has('lup')) engine.movePaddleBy(C.Side.LEFT, -C.PADDLE_SPEED * dt);
        if (keys.has('ldown')) engine.movePaddleBy(C.Side.LEFT, C.PADDLE_SPEED * dt);
        if (keys.has('rup')) engine.movePaddleBy(C.Side.RIGHT, -C.PADDLE_SPEED * dt);
        if (keys.has('rdown')) engine.movePaddleBy(C.Side.RIGHT, C.PADDLE_SPEED * dt);
    }
}

// --- App ---
const app = new Gtk.Application({ application_id: 'io.github.vanvonvan.GnomePongPreview' });

app.connect('activate', () => {
    const win = new Gtk.ApplicationWindow({
        application: app, title: 'GnomePong preview', default_width: 1000, default_height: 700,
    });
    const quit = () => win.close();

    mainMenu = new Menu(null, [
        { label: '1 Player  (vs AI)', action: () => startMatch(C.Mode.ONE_PLAYER) },
        { label: '2 Players  (local)', action: () => startMatch(C.Mode.TWO_PLAYER) },
        { label: 'Host game', action: () => startHost(quit) },
        { label: 'Join game', action: () => showJoin() },
        { label: 'Quit', action: quit },
    ]);
    pauseMenu = new Menu('Paused', [
        { label: 'Resume', action: resume },
        { label: 'Restart', action: () => startMatch(engine.mode) },
        { label: 'Main Menu', action: openMain },
        { label: 'Quit', action: quit },
    ]);
    openMain();

    area = new Gtk.DrawingArea({ hexpand: true, vexpand: true });
    area.set_draw_func((_a, cr, w, h) => {
        Render.draw(cr, w, h, view(), colors);
        if (info)
            Render.drawInfo(cr, w, h, info, colors);
        else if (menu)
            Render.drawMenu(cr, w, h, menu, colors, { scrim: view().state !== C.State.MENU });
    });

    const overlay = new Gtk.Overlay();
    overlay.set_child(area);
    overlay.add_overlay(buildJoinForm(quit));
    win.set_child(overlay);

    const blankCursor = Gdk.Cursor.new_from_name('none', null);
    let cursorHidden = false;
    const updateCursor = () => {
        const playing = !menu && !info && !joinVisible() &&
            (view().state === C.State.PLAYING || view().state === C.State.SERVING);
        if (playing !== cursorHidden) {
            area.set_cursor(playing ? blankCursor : null);
            cursorHidden = playing;
        }
    };

    const motion = new Gtk.EventControllerMotion();
    motion.connect('motion', (_c, x, y) => {
        pointerY = y;
        if (menu && !info) {
            const i = Render.menuHit(area.get_width(), area.get_height(), menu, x, y);
            if (i >= 0) menu.select(i);
        }
    });
    area.add_controller(motion);

    const click = new Gtk.GestureClick();
    click.connect('pressed', (_g, _n, x, y) => {
        if (!menu || info) return;
        const i = Render.menuHit(area.get_width(), area.get_height(), menu, x, y);
        if (i >= 0) { menu.select(i); menu.activate(); }
    });
    area.add_controller(click);

    const keyctl = new Gtk.EventControllerKey();
    keyctl.connect('key-pressed', (_c, keyval) => onKeyDown(keyval, quit));
    keyctl.connect('key-released', (_c, keyval) => { onKeyUp(keyval); });
    win.add_controller(keyctl);

    if (settings)
        settings.connect('changed', () => { colors = readColors(); });

    let last = GLib.get_monotonic_time();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
        const now = GLib.get_monotonic_time();
        let dt = (now - last) / 1e6;
        last = now;
        if (dt > 0.05) dt = 0.05;

        if (net) {
            if (!menu && !info)
                net.setLocalPaddle(mouseVirtualY());
            net.tick(dt);
            if (net.engine.state === C.State.GAME_OVER && !menu && !info) {
                if (netRole === 'host')
                    menu = gameOverMenu(quit, () => { net.restart(); menu = null; });
                else
                    info = { title: `${net.engine.winner === C.Side.LEFT ? 'Left' : 'Right'} player wins`,
                        lines: ['Match over'], hint: 'Esc — leave', scrim: true, esc: openMain };
            }
        } else if (engine.state === C.State.PLAYING || engine.state === C.State.SERVING) {
            if (!menu && !info) {
                applyLocalInput(dt);
                if (ai) ai.update(engine, dt);
            }
            engine.step(dt);
            if (engine.state === C.State.GAME_OVER)
                menu = gameOverMenu(quit, () => startMatch(engine.mode));
        }

        updateCursor();
        area.queue_draw();
        return GLib.SOURCE_CONTINUE;
    });

    win.present();

    if (autoHost)
        startHost(quit, autoHost);
    else if (autoJoin) {
        addrEntry.set_text(autoJoin.addr);
        secretEntry.set_text(autoJoin.secret);
        connectJoin(quit);
    }
});

app.run([]);