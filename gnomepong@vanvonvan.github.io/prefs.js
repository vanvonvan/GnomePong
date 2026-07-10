// GnomePong preferences — recolor everything, set the winning score, toggle
// sound. All backed by GSettings and applied to the running game live.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/prefs.js';

const COLORS = [
    ['color-background', 'Background'],
    ['color-net', 'Net & walls'],
    ['color-ball', 'Ball'],
    ['color-paddle-left', 'Left paddle'],
    ['color-paddle-right', 'Right paddle'],
    ['color-score', 'Score'],
];

const WIN_SCORES = [5, 11, 21];

function rgbaToHex(rgba) {
    const to = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${to(rgba.red)}${to(rgba.green)}${to(rgba.blue)}`;
}

function hexToRgba(hex) {
    const rgba = new Gdk.RGBA();
    rgba.parse(hex || '#ffffff');
    return rgba;
}

export default class GnomePongPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: 'GnomePong',
            icon_name: 'applications-games-symbolic',
        });

        // --- Colors ---
        const colorGroup = new Adw.PreferencesGroup({
            title: 'Colors',
            description: 'Recolor every element of the court.',
        });
        for (const [key, label] of COLORS)
            colorGroup.add(this._colorRow(settings, key, label));
        page.add(colorGroup);

        // --- Game rules ---
        const gameGroup = new Adw.PreferencesGroup({ title: 'Game' });

        const winRow = new Adw.ComboRow({
            title: 'Winning score',
            subtitle: 'First player to reach this score wins.',
            model: Gtk.StringList.new(WIN_SCORES.map(String)),
        });
        const current = settings.get_int('win-score');
        const idx = WIN_SCORES.indexOf(current);
        winRow.selected = idx >= 0 ? idx : 1; // default to 11
        winRow.connect('notify::selected', () =>
            settings.set_int('win-score', WIN_SCORES[winRow.selected]));
        gameGroup.add(winRow);

        const soundRow = new Adw.SwitchRow({
            title: 'Sound effects',
            subtitle: 'Classic paddle, wall and score blips.',
        });
        settings.bind('sound-enabled', soundRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        gameGroup.add(soundRow);
        page.add(gameGroup);

        // --- Reset ---
        const resetGroup = new Adw.PreferencesGroup();
        const resetRow = new Adw.ActionRow({ title: 'Reset to defaults' });
        const resetBtn = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        resetBtn.connect('clicked', () => {
            for (const [key] of COLORS)
                settings.reset(key);
            settings.reset('win-score');
            settings.reset('sound-enabled');
            window.close();
        });
        resetRow.add_suffix(resetBtn);
        resetGroup.add(resetRow);
        page.add(resetGroup);

        window.add(page);
    }

    _colorRow(settings, key, label) {
        const row = new Adw.ActionRow({ title: label });
        const button = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({ with_alpha: false }),
            valign: Gtk.Align.CENTER,
            rgba: hexToRgba(settings.get_string(key)),
        });
        button.connect('notify::rgba', () =>
            settings.set_string(key, rgbaToHex(button.get_rgba())));
        // Keep the button in sync if the setting changes elsewhere.
        settings.connect(`changed::${key}`, () => {
            const want = hexToRgba(settings.get_string(key));
            if (!button.get_rgba().equal(want))
                button.set_rgba(want);
        });
        row.add_suffix(button);
        return row;
    }
}