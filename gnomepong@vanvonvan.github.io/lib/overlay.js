// The full-screen game overlay: owns the St actors, the input grab, the frame
// loop, and the wiring between the engine, the AI, the renderer, sound, and
// direct-connect multiplayer.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as C from './constants.js';
import * as Render from './render.js';
import { GameEngine } from './game.js';
import { AIController } from './ai.js';
import { SoundPlayer } from './sound.js';
import { Menu } from './menu.js';
import { HostGame, ClientGame } from './netgame.js';
import { guessLocalIP, parseAddress, DEFAULT_PORT } from './net.js';

const FRAME_MS = 16; // ~60 fps
const MAX_DT = 0.05; // clamp after stalls so the ball can't teleport

export class PongOverlay {
    constructor(extension) {
        this._settings = extension.getSettings();
        this._sound = new SoundPlayer(extension.path, this._settings);
        this._engine = new GameEngine();
        this._ai = null;
        this._menu = null;
        this._info = null;          // non-interactive info screen (host wait / connecting / error)
        this._net = null;           // HostGame | ClientGame while networking
        this._netRole = null;       // 'host' | 'client'
        this._keys = new Set();
        this._pointerY = 0;         // last pointer stage-y, mapped by _mouseVirtualY
        this._prevPointerY = null;  // previous poll's stage-y, for motion detection
        this._lastInput = null;     // 'mouse' | 'key' — which drives the 1P paddle
        this._btnDown = false;      // last-frame primary-button state (edge detect)
        this._lastTime = 0;
        this._cursorHidden = false;
        this._blurEffect = null;    // Shell.BlurEffect on _area while a menu is up
        this._blurOn = false;
        this._colors = this._readColors();
        this._colorsId = this._settings.connect('changed', () => {
            this._colors = this._readColors();
            this._queueRepaint();
        });
        this._isOpen = false;
    }

    _readColors() {
        const g = (k) => C.hexToRgb(this._settings.get_string(k));
        return {
            bg: g(C.Keys.COLOR_BG),
            net: g(C.Keys.COLOR_NET),
            ball: g(C.Keys.COLOR_BALL),
            paddleL: g(C.Keys.COLOR_PADDLE_L),
            paddleR: g(C.Keys.COLOR_PADDLE_R),
            score: g(C.Keys.COLOR_SCORE),
        };
    }

    _cursorTracker() {
        try {
            return global.backend.get_cursor_tracker();
        } catch (_e) {
            try {
                return Meta.CursorTracker.get_for_display(global.display);
            } catch (_e2) {
                return null;
            }
        }
    }

    // The engine currently being rendered (net game while connected, else local).
    _view() {
        return this._net ? this._net.engine : this._engine;
    }

    open() {
        if (this._isOpen)
            return;
        this._isOpen = true;
        this._buildUI();
        this._buildMenus();

        this._grab = Main.pushModal(this._container, { actionMode: Shell.ActionMode.SYSTEM_MODAL });
        // On GNOME 50 the object returned by pushModal does not expose
        // get_seat_state(), so only consult it when it actually exists;
        // otherwise a non-null grab is treated as success (matches the
        // sibling GnomeOver/GnomeClimber extensions on this same shell).
        const grabFailed = !this._grab ||
            (typeof this._grab.get_seat_state === 'function' &&
             this._grab.get_seat_state() === Clutter.GrabState.NONE);
        if (grabFailed) {
            if (this._grab)
                Main.popModal(this._grab);
            this._grab = null;
            this.close();
            Main.notify('GnomePong', 'Could not grab input (is another modal open?).');
            return;
        }
        this._container.grab_key_focus();

        this._openMain();
        this._lastTime = GLib.get_monotonic_time();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    close() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._teardownNet();
        this._setCursorHidden(false);
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (this._container) {
            this._container.destroy();
            this._container = null;
        }
        // The effect belonged to the now-destroyed _area; drop our refs so a
        // re-open builds a fresh one.
        this._blurEffect = null;
        this._blurOn = false;
        this._area = null;
        this._overlayArea = null;
        this._menu = null;
        this._info = null;
        this._joinBox = null;
        this._isOpen = false;
    }

    destroy() {
        this.close();
        if (this._colorsId) {
            this._settings.disconnect(this._colorsId);
            this._colorsId = 0;
        }
    }

    // ---- UI construction -------------------------------------------------

    _buildUI() {
        const m = Main.layoutManager.primaryMonitor;
        this._monitor = m;
        this._container = new St.Widget({
            style_class: 'gnomepong-overlay',
            reactive: true,
            can_focus: true,
            track_hover: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._container.set_position(m.x, m.y);
        this._container.set_size(m.width, m.height);

        // The court is drawn on its own actor so a blur effect can be applied to
        // ONLY the playfield while a menu/info screen is up (see _setBlur); the
        // menu/info is drawn on a sibling actor stacked on top so it stays crisp.
        this._area = new St.DrawingArea({ x_expand: true, y_expand: true });
        this._area.connect('repaint', () => this._repaintGame());
        this._container.add_child(this._area);

        this._overlayArea = new St.DrawingArea({ x_expand: true, y_expand: true });
        this._overlayArea.connect('repaint', () => this._repaintOverlay());
        this._container.add_child(this._overlayArea);

        this._container.add_child(this._buildJoinForm());

        // Keyboard IS delivered to the key-focused actor under the modal grab,
        // so key signals are reliable. Clutter pointer events (motion / button)
        // are NOT reliably delivered under pushModal on this shell, so all
        // pointer input is polled from global.get_pointer() in _tick() (see
        // _pollPointer). This mirrors the sibling GnomeShot aim-trainer, whose
        // whole game is mouse-driven and uses exactly this poll under the grab.
        this._container.connect('key-press-event', (_a, ev) => this._onKeyPress(ev));
        this._container.connect('key-release-event', (_a, ev) => this._onKeyRelease(ev));

        // The overlay must be on the stage before pushModal can grab it (a modal
        // grab attaches to an on-stage actor). uiGroup stacks it above the rest.
        Main.layoutManager.uiGroup.add_child(this._container);
    }

    _buildMenus() {
        this._mainMenu = new Menu(null, [
            { label: '1 Player  (vs AI)', action: () => this._startMatch(C.Mode.ONE_PLAYER) },
            { label: '2 Players  (local)', action: () => this._startMatch(C.Mode.TWO_PLAYER) },
            { label: 'Host game', action: () => this._startHost() },
            { label: 'Join game', action: () => this._showJoin() },
            { label: 'Quit', action: () => this.close() },
        ], [
            '1 Player:  move the mouse  ·  or  W / S',
            '2 Players:  W / S   vs   ↑ / ↓',
            'Space serves early  ·  P or Esc for the menu',
        ]);
        this._pauseMenu = new Menu('Paused', [
            { label: 'Resume', action: () => this._resume() },
            { label: 'Restart', action: () => this._startMatch(this._engine.mode) },
            { label: 'Main Menu', action: () => this._openMain() },
            { label: 'Quit', action: () => this.close() },
        ]);
    }

    // St-actor join form (address + secret). Kept hidden until "Join game".
    _buildJoinForm() {
        this._joinBox = new St.BoxLayout({
            style_class: 'gnomepong-joinform',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._joinBox.add_child(new St.Label({
            style_class: 'gnomepong-join-title', text: 'Join game',
        }));
        this._joinBox.add_child(new St.Label({
            style_class: 'gnomepong-join-label', text: 'Host address (ip:port)',
        }));
        this._addrEntry = new St.Entry({
            style_class: 'gnomepong-entry',
            hint_text: '192.168.1.5:7777',
            can_focus: true,
        });
        this._joinBox.add_child(this._addrEntry);
        this._joinBox.add_child(new St.Label({
            style_class: 'gnomepong-join-label', text: 'Secret',
        }));
        this._secretEntry = new St.Entry({
            style_class: 'gnomepong-entry',
            hint_text: 'secret',
            can_focus: true,
        });
        this._joinBox.add_child(this._secretEntry);

        this._addrEntry.clutter_text.connect('activate', () => this._secretEntry.grab_key_focus());
        this._secretEntry.clutter_text.connect('activate', () => this._connectJoin());

        const row = new St.BoxLayout({
            style_class: 'gnomepong-join-row',
            x_align: Clutter.ActorAlign.CENTER,
        });
        const connectBtn = new St.Button({
            style_class: 'gnomepong-menu-button', label: 'Connect', can_focus: true,
        });
        const cancelBtn = new St.Button({
            style_class: 'gnomepong-menu-button', label: 'Cancel', can_focus: true,
        });
        connectBtn.connect('clicked', () => this._connectJoin());
        cancelBtn.connect('clicked', () => this._openMain());
        row.add_child(connectBtn);
        row.add_child(cancelBtn);
        this._joinBox.add_child(row);

        this._joinBox.visible = false;
        return this._joinBox;
    }

    _joinVisible() {
        return this._joinBox && this._joinBox.visible;
    }

    _showJoin() {
        this._teardownNet();
        this._engine.state = C.State.MENU;
        this._menu = null;
        this._info = null;
        this._joinBox.visible = true;
        this._addrEntry.grab_key_focus();
        this._syncHint();
    }

    _hideJoin() {
        if (this._joinBox)
            this._joinBox.visible = false;
        if (this._container)
            this._container.grab_key_focus();
    }

    // ---- Flow ------------------------------------------------------------

    _startMatch(mode) {
        this._teardownNet();
        this._hideJoin();
        this._engine.start(mode, this._settings.get_int(C.Keys.WIN_SCORE));
        this._ai = mode === C.Mode.ONE_PLAYER ? new AIController(C.Side.RIGHT) : null;
        this._keys.clear();
        this._lastInput = null;     // paddle holds center until mouse/keys move it
        this._prevPointerY = null;
        this._menu = null;
        this._info = null;
        this._syncHint();
    }

    _openMain() {
        this._teardownNet();
        this._hideJoin();
        this._engine.state = C.State.MENU;
        this._ai = null;
        this._menu = this._mainMenu;
        this._menu.selected = 0;
        this._info = null;
        this._syncHint();
    }

    _openPause() {
        const s = this._engine.state;
        if (s === C.State.PLAYING || s === C.State.SERVING) {
            this._engine.pause();
            this._menu = this._pauseMenu;
            this._menu.selected = 0;
            this._syncHint();
        }
    }

    _resume() {
        if (this._engine.state === C.State.PAUSED) {
            this._engine.pause();
            this._menu = null;
            this._syncHint();
        }
    }

    _gameOverMenu() {
        const who = this._engine.winner === C.Side.LEFT ? 'Left' : 'Right';
        return new Menu(`${who} player wins`, [
            { label: 'Play Again', action: () => this._startMatch(this._engine.mode) },
            { label: 'Main Menu', action: () => this._openMain() },
            { label: 'Quit', action: () => this.close() },
        ]);
    }

    // ---- Networking flow -------------------------------------------------

    _teardownNet() {
        if (this._net) {
            this._net.stop();
            this._net = null;
        }
        this._netRole = null;
    }

    _randomSecret() {
        const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        let s = '';
        for (let i = 0; i < 5; i++)
            s += alphabet[Math.floor(Math.random() * alphabet.length)];
        return s;
    }

    _errorInfo(message) {
        return {
            title: 'Disconnected',
            lines: [message],
            hint: 'Enter / Esc — back to menu',
            scrim: true,
            esc: () => this._openMain(),
            enter: () => this._openMain(),
        };
    }

    _startHost(forcedSecret) {
        this._teardownNet();
        this._hideJoin();
        const secret = forcedSecret || this._randomSecret();
        this._net = new HostGame({
            secret,
            winScore: this._settings.get_int(C.Keys.WIN_SCORE),
            port: DEFAULT_PORT,
            handlers: {
                connected: () => { this._info = null; this._menu = null; this._syncHint(); },
                closed: () => {
                    if (this._netRole === 'host' && this._net) {
                        this._teardownNet();
                        this._info = this._errorInfo('Player disconnected');
                        this._syncHint();
                    }
                },
                error: (e) => logError(e, 'GnomePong host'),
            },
        });
        this._netRole = 'host';
        this._menu = null;
        let port;
        try {
            port = this._net.start();
        } catch (e) {
            this._teardownNet();
            this._info = this._errorInfo(`Could not host: ${e.message || e}`);
            this._syncHint();
            return;
        }
        const ip = guessLocalIP() || 'your-LAN-IP';
        this._info = {
            title: 'Hosting — waiting for player',
            lines: [`Address:   ${ip}:${port}`, `Secret:    ${secret}`],
            hint: 'Esc to cancel',
            scrim: true,
            esc: () => this._openMain(),
        };
        this._syncHint();
    }

    _connectJoin() {
        const parsed = parseAddress(this._addrEntry.get_text());
        if (!parsed) {
            this._hideJoin();
            this._info = this._errorInfo('Enter an address like 192.168.1.5:7777');
            this._syncHint();
            return;
        }
        this._hideJoin();
        this._teardownNet();
        this._net = new ClientGame({
            host: parsed.host,
            port: parsed.port,
            secret: this._secretEntry.get_text(),
            handlers: {
                welcome: () => { this._info = null; this._menu = null; this._syncHint(); },
                rejected: (r) => {
                    this._teardownNet();
                    this._info = this._errorInfo(`Rejected: ${r}`);
                    this._syncHint();
                },
                closed: (r) => {
                    const welcomed = this._net && this._net.welcomed;
                    this._teardownNet();
                    this._info = this._errorInfo(welcomed ? 'Host disconnected' : `Could not connect (${r})`);
                    this._syncHint();
                },
                error: (e) => logError(e, 'GnomePong client'),
                events: (list) => this._handleEvents(list),
            },
        });
        this._netRole = 'client';
        this._info = {
            title: 'Connecting…',
            lines: [`${parsed.host}:${parsed.port}`],
            hint: 'Esc to cancel',
            scrim: true,
            esc: () => this._openMain(),
        };
        this._net.connect();
        this._syncHint();
    }

    _openNetPause() {
        this._net.engine.pause();
        this._menu = new Menu('Paused', [
            { label: 'Resume', action: () => { this._net.engine.pause(); this._menu = null; this._syncHint(); } },
            { label: 'Restart', action: () => { this._net.restart(); this._menu = null; this._syncHint(); } },
            { label: 'Disconnect', action: () => this._openMain() },
        ]);
        this._syncHint();
    }

    _netGameOverMenu() {
        const who = this._view().winner === C.Side.LEFT ? 'Left' : 'Right';
        return new Menu(`${who} player wins`, [
            { label: 'Play Again', action: () => { this._net.restart(); this._menu = null; this._syncHint(); } },
            { label: 'Main Menu', action: () => this._openMain() },
            { label: 'Quit', action: () => this.close() },
        ]);
    }

    // Formerly updated an on-screen hint label; now just requests a repaint.
    // There is intentionally NO text drawn over the playfield during a match —
    // the controls legend lives on the main menu (see _buildMenus). Kept under
    // the old name because it's called from every state transition.
    _syncHint() {
        this._updateBlur();
        this._queueRepaint();
    }

    // ---- Frame loop ------------------------------------------------------

    _tick() {
        const now = GLib.get_monotonic_time();
        let dt = (now - this._lastTime) / 1e6;
        this._lastTime = now;
        if (dt > MAX_DT)
            dt = MAX_DT;

        this._pollPointer();

        if (this._net) {
            if (!this._menu && !this._info)
                this._net.setLocalPaddle(this._mouseVirtualY());
            const events = this._net.tick(dt); // host returns events; client returns undefined
            if (events && events.length)
                this._handleEvents(events);
            if (this._net.engine.state === C.State.GAME_OVER && !this._menu && !this._info) {
                if (this._netRole === 'host') {
                    this._menu = this._netGameOverMenu();
                } else {
                    const who = this._net.engine.winner === C.Side.LEFT ? 'Left' : 'Right';
                    this._info = {
                        title: `${who} player wins`,
                        lines: ['Match over'],
                        hint: 'Esc — leave',
                        scrim: true,
                        esc: () => this._openMain(),
                    };
                }
                this._syncHint();
            }
        } else {
            const e = this._engine;
            const playing = !this._menu &&
                (e.state === C.State.PLAYING || e.state === C.State.SERVING);
            if (playing) {
                this._applyInput(dt);
                if (this._ai)
                    this._ai.update(e, dt);
                const events = e.step(dt);
                this._handleEvents(events);
                if (e.state === C.State.GAME_OVER) {
                    this._menu = this._gameOverMenu();
                    this._syncHint();
                }
            }
        }

        const view = this._view();
        const playingNow = !this._menu && !this._info && !this._joinVisible() &&
            (view.state === C.State.PLAYING || view.state === C.State.SERVING);
        this._setCursorHidden(playingNow);
        this._queueRepaint();
    }

    _mouseVirtualY() {
        // Map against the monitor's LOGICAL size, not the drawing area's
        // surface size. global.get_pointer() returns logical stage coords, and
        // the area fills the monitor-sized container, so this is the matching
        // space; it also avoids the surface being transiently 0-sized (which
        // used to make vp.scale 0 and pin the paddle to dead center on every
        // key release) and stays correct under fractional display scaling.
        const vp = Render.viewport(this._monitor.width, this._monitor.height);
        const localY = this._pointerY - this._monitor.y;
        return vp.scale > 0 ? (localY - vp.offY) / vp.scale : C.VIRT_H / 2;
    }

    _applyInput(dt) {
        const e = this._engine;
        if (e.mode === C.Mode.ONE_PLAYER) {
            // The lone human drives the left paddle with EITHER the mouse or the
            // keyboard; whichever was used most recently wins (_lastInput, set
            // by _onKeyPress and by motion detected in _pollPointer). While a
            // W/S/↑/↓ key is held the paddle moves; on release it HOLDS its
            // position (it no longer snaps back to the mouse/center). Moving the
            // mouse hands control back to the mouse.
            const up = this._keys.has('lup') || this._keys.has('rup');
            const down = this._keys.has('ldown') || this._keys.has('rdown');
            if (up || down) {
                if (up)
                    e.movePaddleBy(C.Side.LEFT, -C.PADDLE_SPEED * dt);
                if (down)
                    e.movePaddleBy(C.Side.LEFT, C.PADDLE_SPEED * dt);
            } else if (this._lastInput === 'mouse') {
                e.setPaddleCenter(C.Side.LEFT, this._mouseVirtualY());
            }
        } else if (e.mode === C.Mode.TWO_PLAYER) {
            if (this._keys.has('lup'))
                e.movePaddleBy(C.Side.LEFT, -C.PADDLE_SPEED * dt);
            if (this._keys.has('ldown'))
                e.movePaddleBy(C.Side.LEFT, C.PADDLE_SPEED * dt);
            if (this._keys.has('rup'))
                e.movePaddleBy(C.Side.RIGHT, -C.PADDLE_SPEED * dt);
            if (this._keys.has('rdown'))
                e.movePaddleBy(C.Side.RIGHT, C.PADDLE_SPEED * dt);
        }
    }

    _handleEvents(events) {
        for (const ev of events) {
            if (ev === 'wall')
                this._sound.play('wall');
            else if (ev === 'paddle')
                this._sound.play('paddle');
            else if (typeof ev === 'object' && ev.score)
                this._sound.play('score');
        }
    }

    _setCursorHidden(hidden) {
        if (hidden === this._cursorHidden)
            return;
        // GNOME 49+ dropped set_pointer_visible(); use the balanced inhibit API.
        // The state guard above keeps inhibit/uninhibit calls paired.
        //
        // CRUCIAL: pair the cursor-visibility inhibit with a seat *unfocus*
        // inhibit, exactly as GNOME Shell's own magnifier (and the sibling
        // GnomeShot aim-trainer) does. Without the unfocus inhibit the
        // compositor slips the hardware cursor back the instant the pointer
        // moves — which for a mouse-driven paddle is precisely when you're
        // playing, so the cursor was showing over the game the whole time.
        const tracker = this._cursorTracker();
        if (!tracker || !tracker.inhibit_cursor_visibility) {
            this._cursorHidden = hidden; // API absent (Shell < 49): nothing to do
            return;
        }
        let seat = null;
        try {
            seat = Clutter.get_default_backend().get_default_seat();
        } catch (_e) {
            seat = null;
        }
        if (hidden) {
            seat?.inhibit_unfocus();
            tracker.inhibit_cursor_visibility();
        } else {
            tracker.uninhibit_cursor_visibility();
            seat?.uninhibit_unfocus();
        }
        this._cursorHidden = hidden;
    }

    // ---- Rendering -------------------------------------------------------

    _repaintGame() {
        const cr = this._area.get_context();
        const [w, h] = this._area.get_surface_size();
        Render.draw(cr, w, h, this._view(), this._colors);
        cr.$dispose();
    }

    _repaintOverlay() {
        const cr = this._overlayArea.get_context();
        const [w, h] = this._overlayArea.get_surface_size();
        if (this._info)
            Render.drawInfo(cr, w, h, this._info, this._colors);
        else if (this._menu)
            Render.drawMenu(cr, w, h, this._menu, this._colors,
                { scrim: this._view().state !== C.State.MENU });
        cr.$dispose();
    }

    _queueRepaint() {
        if (this._area)
            this._area.queue_repaint();
        if (this._overlayArea)
            this._overlayArea.queue_repaint();
    }

    // Blur the court (only) whenever a menu / info / join screen is showing, so
    // the playfield reads as a soft backdrop instead of a distracting live
    // scene. Actor-mode Shell.BlurEffect blurs this actor's own painted content;
    // the menu is on a sibling actor above, so it stays crisp. GnomePong has no
    // bake/undo pipeline (unlike Kapodopera), so the actor-based effect is a
    // clean fit here.
    _makeBlur() {
        try {
            return new Shell.BlurEffect({
                radius: 24,
                brightness: 0.55, // also darkens the court so menu text reads well
                mode: Shell.BlurMode.ACTOR,
            });
        } catch (_e) {
            // Older Shell builds took `sigma` instead of `radius`.
            try {
                return new Shell.BlurEffect({
                    sigma: 12,
                    brightness: 0.55,
                    mode: Shell.BlurMode.ACTOR,
                });
            } catch (_e2) {
                return null; // no blur available; court just shows unblurred
            }
        }
    }

    _updateBlur() {
        this._setBlur(!!(this._menu || this._info || this._joinVisible()));
    }

    _setBlur(on) {
        if (on === this._blurOn || !this._area)
            return;
        this._blurOn = on;
        if (on) {
            if (!this._blurEffect)
                this._blurEffect = this._makeBlur();
            if (this._blurEffect)
                this._area.add_effect(this._blurEffect);
        } else if (this._blurEffect) {
            this._area.remove_effect(this._blurEffect);
        }
    }

    // ---- Input handlers --------------------------------------------------

    // Poll the pointer once per frame. Under the modal grab Clutter does not
    // reliably deliver motion/button events to the overlay, so this drives
    // everything pointer-related: the mouse-controlled paddle (via _pointerY,
    // read by _mouseVirtualY), menu hover highlighting, and menu clicks (rising
    // edge of the primary button). global.get_pointer() returns stage coords
    // plus a modifier mask carrying the button state. This is the exact pattern
    // the GnomeShot sibling uses to run an entirely mouse-driven game.
    _pollPointer() {
        if (!this._area)
            return;
        const [px, py, mods] = global.get_pointer();
        // A real change in pointer position means the human is using the mouse;
        // hand paddle control to it (see _applyInput). Actual motion only — so a
        // motionless mouse never overrides the keyboard.
        if (this._prevPointerY !== null && Math.abs(py - this._prevPointerY) > 0.5)
            this._lastInput = 'mouse';
        this._prevPointerY = py;
        this._pointerY = py; // stage y, mapped to virtual in _mouseVirtualY
        const localX = px - this._monitor.x;
        const localY = py - this._monitor.y;

        // Hover-highlight the menu item under the pointer. Hit-test in the same
        // logical monitor space the pointer coords live in (see _mouseVirtualY).
        if (this._menu && !this._info) {
            const w = this._monitor.width;
            const h = this._monitor.height;
            const i = Render.menuHit(w, h, this._menu, localX, localY);
            if (i >= 0 && i !== this._menu.selected) {
                this._menu.select(i);
                this._queueRepaint();
            }
        }

        // Primary-button click = rising edge of BUTTON1 in the modifier mask.
        const down = (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
        if (down && !this._btnDown)
            this._onPointerClick(localX, localY);
        this._btnDown = down;
    }

    _onPointerClick(localX, localY) {
        if (!this._menu || this._info)
            return;
        const i = Render.menuHit(this._monitor.width, this._monitor.height,
            this._menu, localX, localY);
        if (i >= 0) {
            this._menu.select(i);
            this._menu.activate();
        }
    }

    _keyToken(sym) {
        switch (sym) {
            case Clutter.KEY_w:
            case Clutter.KEY_W:
                return 'lup';
            case Clutter.KEY_s:
            case Clutter.KEY_S:
                return 'ldown';
            case Clutter.KEY_Up:
                return 'rup';
            case Clutter.KEY_Down:
                return 'rdown';
        }
        return null;
    }

    _onKeyPress(ev) {
        const sym = ev.get_key_symbol();

        // Join form is open: let the entries type; only intercept Escape.
        if (this._joinVisible()) {
            if (sym === Clutter.KEY_Escape) {
                this._openMain();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        // Non-interactive info screen (host wait / connecting / error).
        if (this._info) {
            if (sym === Clutter.KEY_Escape)
                this._info.esc?.();
            else if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter)
                (this._info.enter || this._info.esc)?.();
            return Clutter.EVENT_STOP;
        }

        // Menu navigation takes priority when a menu is open.
        if (this._menu) {
            switch (sym) {
                case Clutter.KEY_Up:
                    this._menu.move(-1); this._queueRepaint(); return Clutter.EVENT_STOP;
                case Clutter.KEY_Down:
                    this._menu.move(1); this._queueRepaint(); return Clutter.EVENT_STOP;
                case Clutter.KEY_Return:
                case Clutter.KEY_KP_Enter:
                case Clutter.KEY_space:
                    this._menu.activate(); return Clutter.EVENT_STOP;
                case Clutter.KEY_1:
                    if (this._menu === this._mainMenu) this._startMatch(C.Mode.ONE_PLAYER);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_2:
                    if (this._menu === this._mainMenu) this._startMatch(C.Mode.TWO_PLAYER);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Escape:
                    if (this._menu === this._pauseMenu)
                        this._resume();
                    else if (this._menu === this._mainMenu)
                        this.close();
                    else
                        this._openMain();
                    return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_STOP;
        }

        // Networked play.
        if (this._net) {
            switch (sym) {
                case Clutter.KEY_Escape:
                case Clutter.KEY_p:
                case Clutter.KEY_P:
                    if (this._netRole === 'host')
                        this._openNetPause();
                    else
                        this._openMain(); // client leaves
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_space:
                    if (this._netRole === 'host')
                        this._net.serve();
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_r:
                case Clutter.KEY_R:
                    if (this._netRole === 'host')
                        this._net.restart();
                    return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_STOP;
        }

        // Local in-play controls.
        const token = this._keyToken(sym);
        if (token) {
            this._keys.add(token);
            this._lastInput = 'key'; // keyboard now owns the 1P paddle
            return Clutter.EVENT_STOP;
        }
        const e = this._engine;
        switch (sym) {
            case Clutter.KEY_space:
                if (e.state === C.State.SERVING)
                    e.launch();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_p:
            case Clutter.KEY_P:
            case Clutter.KEY_Escape:
                this._openPause();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_r:
            case Clutter.KEY_R:
                this._startMatch(e.mode);
                return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onKeyRelease(ev) {
        const token = this._keyToken(ev.get_key_symbol());
        if (token) {
            this._keys.delete(token);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
}
