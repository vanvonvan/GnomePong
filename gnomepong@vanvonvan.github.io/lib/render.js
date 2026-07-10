// Cairo rendering of the playfield onto a St.DrawingArea. Stateless w.r.t. the
// game: given an engine and the current colors, it draws one frame. Uses a
// fixed virtual field scaled + letterboxed into the widget so the look is
// identical on any monitor.

import cairo from 'gi://cairo';

import * as C from './constants.js';

const MENU_FONT = 'monospace';

// 7-segment layout: which segments (a..g) light up for each digit.
// segments: a top, b top-right, c bottom-right, d bottom, e bottom-left,
//           f top-left, g middle.
const DIGITS = {
    0: 'abcdef',
    1: 'bc',
    2: 'abged',
    3: 'abgcd',
    4: 'fgbc',
    5: 'afgcd',
    6: 'afgedc',
    7: 'abc',
    8: 'abcdefg',
    9: 'abcfgd',
};

// Compute the scale/offset that maps virtual coords into the widget.
export function viewport(w, h) {
    const scale = Math.min(w / C.VIRT_W, h / C.VIRT_H);
    return {
        scale,
        offX: (w - C.VIRT_W * scale) / 2,
        offY: (h - C.VIRT_H * scale) / 2,
    };
}

function setColor(cr, rgb) {
    cr.setSourceRGB(rgb.r, rgb.g, rgb.b);
}

function fillRect(cr, vp, x, y, w, h) {
    cr.rectangle(vp.offX + x * vp.scale, vp.offY + y * vp.scale, w * vp.scale, h * vp.scale);
    cr.fill();
}

// Draw one 7-segment digit inside the virtual box (x,y,w,h).
function drawDigit(cr, vp, digit, x, y, w, h) {
    const t = w * 0.22;          // segment thickness
    const segs = DIGITS[digit] || '';
    const midY = y + (h - t) / 2;
    const rects = {
        a: [x, y, w, t],
        b: [x + w - t, y, t, h / 2],
        c: [x + w - t, y + h / 2, t, h / 2],
        d: [x, y + h - t, w, t],
        e: [x, y + h / 2, t, h / 2],
        f: [x, y, t, h / 2],
        g: [x, midY, w, t],
    };
    for (const s of segs) {
        const r = rects[s];
        fillRect(cr, vp, r[0], r[1], r[2], r[3]);
    }
}

// Draw a whole number centered horizontally around cx (virtual units).
function drawNumber(cr, vp, n, cx, top, digitH) {
    const str = String(n);
    const digitW = digitH * 0.62;
    const gap = digitW * 0.35;
    const totalW = str.length * digitW + (str.length - 1) * gap;
    let x = cx - totalW / 2;
    for (const ch of str) {
        drawDigit(cr, vp, Number(ch), x, top, digitW, digitH);
        x += digitW + gap;
    }
}

// Main entry: paint one frame.
export function draw(cr, w, h, engine, colors) {
    const vp = viewport(w, h);

    // Background fills the whole widget (letterbox included).
    setColor(cr, colors.bg);
    cr.rectangle(0, 0, w, h);
    cr.fill();

    // Court markings (walls + net + center) use the net color.
    setColor(cr, colors.net);
    // Top / bottom walls.
    fillRect(cr, vp, 0, 0, C.VIRT_W, C.WALL);
    fillRect(cr, vp, 0, C.VIRT_H - C.WALL, C.VIRT_W, C.WALL);
    // Dashed center net.
    const dashH = 26;
    const dashGap = 22;
    const netW = 8;
    const netX = C.VIRT_W / 2 - netW / 2;
    for (let y = C.WALL + 6; y < C.VIRT_H - C.WALL - dashH; y += dashH + dashGap)
        fillRect(cr, vp, netX, y, netW, dashH);

    if (engine.state === C.State.MENU) {
        // Attract screen: big "PONG" title near the top.
        setColor(cr, colors.score);
        drawTitle(cr, vp);
        return;
    }

    // Scores.
    setColor(cr, colors.score);
    const digitH = 90;
    drawNumber(cr, vp, engine.scoreL, C.VIRT_W * 0.28, C.WALL + 40, digitH);
    drawNumber(cr, vp, engine.scoreR, C.VIRT_W * 0.72, C.WALL + 40, digitH);

    // Paddles.
    setColor(cr, colors.paddleL);
    fillRect(cr, vp, engine.left.x, engine.left.y, engine.left.w, engine.left.h);
    setColor(cr, colors.paddleR);
    fillRect(cr, vp, engine.right.x, engine.right.y, engine.right.w, engine.right.h);

    // Ball (drawn as the classic square).
    setColor(cr, colors.ball);
    const b = engine.ball;
    fillRect(cr, vp, b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
}

// A blocky "PONG" wordmark built from the 7-segment style, minus the 'O' which
// we draw as a full box outline so it reads as a letter, not a zero digit.
function drawTitle(cr, vp) {
    const h = 120;
    const w = h * 0.62;
    const gap = w * 0.4;
    const total = 4 * w + 3 * gap;
    let x = C.VIRT_W / 2 - total / 2;
    const y = 70;
    // P
    drawGlyph(cr, vp, 'P', x, y, w, h); x += w + gap;
    // O
    drawGlyph(cr, vp, 'O', x, y, w, h); x += w + gap;
    // N
    drawGlyph(cr, vp, 'N', x, y, w, h); x += w + gap;
    // G
    drawGlyph(cr, vp, 'G', x, y, w, h);
}

// Minimal blocky letters for the title.
function drawGlyph(cr, vp, ch, x, y, w, h) {
    const t = w * 0.22;
    const half = h / 2;
    const R = (a, b, c, d) => fillRect(cr, vp, a, b, c, d);
    switch (ch) {
        case 'P':
            R(x, y, t, h);
            R(x, y, w, t);
            R(x + w - t, y, t, half);
            R(x, y + half - t, w, t);
            break;
        case 'O':
            R(x, y, w, t);
            R(x, y + h - t, w, t);
            R(x, y, t, h);
            R(x + w - t, y, t, h);
            break;
        case 'N':
            R(x, y, t, h);
            R(x + w - t, y, t, h);
            R(x, y, w, t);
            break;
        case 'G':
            R(x, y, w, t);
            R(x, y, t, h);
            R(x, y + h - t, w, t);
            R(x + w - t, y + half, t, half);
            R(x + w / 2, y + half - t, w / 2, t);
            break;
    }
}

// ---- Menus (drawn on the same canvas so the extension and preview match) ----

// Draw `s` centered at (cx, cy).
function centerText(cr, s, size, cx, cy, rgb) {
    cr.selectFontFace(MENU_FONT, cairo.FontSlant.NORMAL, cairo.FontWeight.BOLD);
    cr.setFontSize(size);
    const e = cr.textExtents(s);
    cr.setSourceRGB(rgb.r, rgb.g, rgb.b);
    cr.moveTo(cx - e.width / 2 - e.xBearing, cy - e.height / 2 - e.yBearing);
    cr.showText(s);
}

// Geometry for a menu's items, in widget pixels. Shared by draw + hit-test so
// the mouse lands exactly on what's painted.
export function menuLayout(w, h, menu) {
    const scale = Math.min(w / C.VIRT_W, h / C.VIRT_H);
    const itemW = 400 * scale;
    const itemH = 58 * scale;
    const gap = 16 * scale;
    const n = menu.items.length;
    const footerLines = menu.footer ? menu.footer.length : 0;
    const footerLead = 34 * scale;  // gap from the last item to the first footer line
    const footerStep = 30 * scale;  // line-to-line footer spacing

    let startY = menu.heading ? h * 0.44 : h * 0.46;
    if (footerLines) {
        // Center the items+footer as one block in the area below the title, so
        // the extra lines never push the last items off the bottom edge.
        const itemsH = n * itemH + (n - 1) * gap;
        const footerH = footerLead + footerLines * footerStep;
        const top = h * 0.30;
        const region = h * 0.95 - top;
        startY = top + Math.max(0, (region - (itemsH + footerH)) / 2);
    }

    const items = [];
    for (let i = 0; i < n; i++) {
        items.push({
            x: w / 2 - itemW / 2,
            y: startY + i * (itemH + gap),
            w: itemW,
            h: itemH,
        });
    }
    return {
        items,
        scale,
        headingY: h * 0.30,
        headingSize: 48 * scale,
        itemFont: 26 * scale,
        footerStart: startY + n * itemH + (n - 1) * gap + footerLead,
        footerStep,
        footerSize: 18 * scale,
    };
}

// Index of the item under (px, py), or -1.
export function menuHit(w, h, menu, px, py) {
    const L = menuLayout(w, h, menu);
    for (let i = 0; i < L.items.length; i++) {
        const b = L.items[i];
        if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h)
            return i;
    }
    return -1;
}

// A non-interactive info screen (hosting/connecting/error). `info` =
// { title, lines: [..], hint, scrim }.
export function drawInfo(cr, w, h, info, colors) {
    const scale = Math.min(w / C.VIRT_W, h / C.VIRT_H);
    if (info.scrim) {
        cr.setSourceRGBA(0, 0, 0, 0.62);
        cr.rectangle(0, 0, w, h);
        cr.fill();
    }
    if (info.title)
        centerText(cr, info.title, 44 * scale, w / 2, h * 0.34, colors.score);
    let y = h * 0.47;
    for (const line of info.lines || []) {
        centerText(cr, line, 28 * scale, w / 2, y, colors.score);
        y += 46 * scale;
    }
    if (info.hint)
        centerText(cr, info.hint, 22 * scale, w / 2, h * 0.84, colors.net);
}

// Paint a menu over the current frame. `scrim` dims the game behind it.
export function drawMenu(cr, w, h, menu, colors, opts = {}) {
    const L = menuLayout(w, h, menu);
    if (opts.scrim) {
        cr.setSourceRGBA(0, 0, 0, 0.62);
        cr.rectangle(0, 0, w, h);
        cr.fill();
    }
    if (menu.heading)
        centerText(cr, menu.heading, L.headingSize, w / 2, L.headingY, colors.score);

    menu.items.forEach((item, i) => {
        const b = L.items[i];
        const cx = w / 2;
        const cy = b.y + b.h / 2;
        if (i === menu.selected) {
            cr.setSourceRGB(colors.score.r, colors.score.g, colors.score.b);
            cr.rectangle(b.x, b.y, b.w, b.h);
            cr.fill();
            centerText(cr, item.label, L.itemFont, cx, cy, colors.bg);
        } else {
            cr.setSourceRGB(colors.net.r, colors.net.g, colors.net.b);
            cr.setLineWidth(Math.max(1, 2 * L.scale));
            cr.rectangle(b.x, b.y, b.w, b.h);
            cr.stroke();
            centerText(cr, item.label, L.itemFont, cx, cy, colors.score);
        }
    });

    // Optional footer lines (e.g. the controls legend on the main menu), drawn
    // below the items in the dim net color. This is the ONLY place the controls
    // are shown — there is no on-screen hint during play.
    if (menu.footer && menu.footer.length) {
        let fy = L.footerStart;
        for (const line of menu.footer) {
            centerText(cr, line, L.footerSize, w / 2, fy, colors.net);
            fy += L.footerStep;
        }
    }
}