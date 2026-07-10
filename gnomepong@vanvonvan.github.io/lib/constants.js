// Shared constants for GnomePong. Pure data — no GNOME imports here so this
// file (and game.js) can be exercised with a plain `gjs` run if needed.

// Fixed virtual playfield. The renderer scales this to the monitor and
// letterboxes, so physics behave identically on any screen size.
export const VIRT_W = 1000;
export const VIRT_H = 700;

// Thickness of the top/bottom walls (the white bars in the classic look).
// The ball bounces on the inner edge of these.
export const WALL = 16;

// Paddle geometry (virtual units).
export const PADDLE_W = 16;
export const PADDLE_H = 110;
export const PADDLE_MARGIN = 40; // gap from side wall to paddle face
export const PADDLE_SPEED = 720; // human keyboard paddle speed (u/s)

// Ball geometry and speed.
export const BALL_SIZE = 16;
export const BALL_SPEED_START = 560; // initial speed (u/s)
export const BALL_SPEED_MAX = 1300;
export const BALL_SPEEDUP = 1.045; // multiplier per paddle hit
export const MAX_BOUNCE_ANGLE = (60 * Math.PI) / 180; // rad off horizontal

// Short freeze after a point before the next serve (seconds).
export const SERVE_DELAY = 0.8;

// Game states.
export const State = {
    MENU: 'menu',
    SERVING: 'serving', // ball parked at center, waiting for launch/delay
    PLAYING: 'playing',
    PAUSED: 'paused',
    GAME_OVER: 'game_over',
};

// Which side owns a paddle.
export const Side = { LEFT: 'left', RIGHT: 'right' };

// Game modes.
export const Mode = { ONE_PLAYER: '1p', TWO_PLAYER: '2p', NET: 'net' };

// GSettings keys (kept in one place so extension.js and prefs.js agree).
export const Keys = {
    COLOR_BG: 'color-background',
    COLOR_NET: 'color-net',
    COLOR_BALL: 'color-ball',
    COLOR_PADDLE_L: 'color-paddle-left',
    COLOR_PADDLE_R: 'color-paddle-right',
    COLOR_SCORE: 'color-score',
    WIN_SCORE: 'win-score',
    SOUND: 'sound-enabled',
};

// Parse '#rrggbb' (or '#rgb') into {r,g,b} floats in [0,1] for Cairo.
export function hexToRgb(hex) {
    let s = (hex || '').replace('#', '').trim();
    if (s.length === 3)
        s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (s.length !== 6)
        return { r: 1, g: 1, b: 1 };
    return {
        r: parseInt(s.slice(0, 2), 16) / 255,
        g: parseInt(s.slice(2, 4), 16) / 255,
        b: parseInt(s.slice(4, 6), 16) / 255,
    };
}
