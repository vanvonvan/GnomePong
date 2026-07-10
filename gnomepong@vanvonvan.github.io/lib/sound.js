// Plays the blip WAVs through GNOME Shell's built-in (canberra-backed) sound
// player. Cheap and fire-and-forget; respects the sound-enabled setting.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class SoundPlayer {
    constructor(extensionPath, settings) {
        this._settings = settings;
        const f = (name) =>
            Gio.File.new_for_path(GLib.build_filenamev([extensionPath, 'sounds', name]));
        this._files = {
            paddle: f('paddle.wav'),
            wall: f('wall.wav'),
            score: f('score.wav'),
        };
        // MetaSoundPlayer, shared with the rest of the shell.
        try {
            this._player = global.display.get_sound();
        } catch (_e) {
            this._player = null;
        }
    }

    play(name) {
        if (!this._player || !this._settings.get_boolean('sound-enabled'))
            return;
        const file = this._files[name];
        if (!file)
            return;
        try {
            this._player.play_from_file(file, `gnomepong-${name}`, null);
        } catch (_e) {
            // Never let an audio hiccup disturb the game loop.
        }
    }
}