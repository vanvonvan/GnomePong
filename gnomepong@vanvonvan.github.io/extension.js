// GnomePong — top-bar button that launches the full-screen Pong overlay.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { PongOverlay } from './lib/overlay.js';

const PongButton = GObject.registerClass(
class PongButton extends PanelMenu.Button {
    _init(onActivate) {
        super._init(0.0, 'GnomePong', true);
        this._onActivate = onActivate;
        this.add_child(new St.Label({
            text: 'PONG',
            style_class: 'gnomepong-panel-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
    }

    // Launch the game directly on click instead of opening a (empty) menu.
    vfunc_event(event) {
        const t = event.type();
        if (t === Clutter.EventType.BUTTON_PRESS || t === Clutter.EventType.TOUCH_BEGIN) {
            this._onActivate();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});

export default class GnomePongExtension extends Extension {
    enable() {
        this._overlay = new PongOverlay(this);
        this._button = new PongButton(() => this._overlay.open());
        Main.panel.addToStatusArea('gnomepong', this._button);
    }

    disable() {
        // Fully tear down — extensions must leave nothing behind on lock/disable.
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }
        if (this._button) {
            this._button.destroy();
            this._button = null;
        }
    }
}