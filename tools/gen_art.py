#!/usr/bin/env python3
"""Generate GnomePong branding art (icon, logo, banner) with pycairo.

The wordmark reuses the game's OWN visual language — the blocky letter style and
7-segment score digits drawn by lib/render.js — so the branding matches exactly
what you see in-game. Outputs into ../assets/.

Run:  python3 tools/gen_art.py
"""

import math
import os

import cairo

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")
os.makedirs(ASSETS, exist_ok=True)

# --- Palette (matches the screenshot renderer) ---
BG      = (0.020, 0.024, 0.040)   # #05060a
BG_TOP  = (0.043, 0.055, 0.086)   # subtle top highlight for gradients
WHITE   = (0.918, 0.965, 1.000)   # #eaf6ff
CYAN    = (0.373, 0.843, 1.000)   # #5fd7ff
GREY    = (0.500, 0.690, 0.784)   # #7fb0c8 (court markings)
DIM     = (0.62, 0.70, 0.77)


def rgba(cr, c, a=1.0):
    cr.set_source_rgba(c[0], c[1], c[2], a)


def rounded_rect(cr, x, y, w, h, r):
    cr.new_sub_path()
    cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    cr.arc(x + r, y + r, r, math.pi, 1.5 * math.pi)
    cr.close_path()


# ---- Blocky wordmark glyphs (same construction as render.js drawGlyph) -------
def glyph(cr, ch, x, y, w, h):
    t = w * 0.22
    half = h / 2

    def R(a, b, c, d):
        cr.rectangle(a, b, c, d)
        cr.fill()

    if ch == "P":
        R(x, y, t, h); R(x, y, w, t); R(x + w - t, y, t, half); R(x, y + half - t, w, t)
    elif ch == "O":
        R(x, y, w, t); R(x, y + h - t, w, t); R(x, y, t, h); R(x + w - t, y, t, h)
    elif ch == "N":
        R(x, y, t, h); R(x + w - t, y, t, h); R(x, y, w, t)
    elif ch == "G":
        R(x, y, w, t); R(x, y, t, h); R(x, y + h - t, w, t)
        R(x + w - t, y + half, t, half); R(x + w / 2, y + half - t, w / 2, t)
    elif ch == "M":
        R(x, y, t, h); R(x + w - t, y, t, h); R(x, y, w, t)
        R(x + w / 2 - t / 2, y, t, half * 0.95)
    elif ch == "E":
        R(x, y, t, h); R(x, y, w, t); R(x, y + half - t, w, t); R(x, y + h - t, w, t)


def word_width(text, h):
    w = h * 0.62
    gap = w * 0.40
    return len(text) * w + (len(text) - 1) * gap, w, gap


def draw_word(cr, text, cx, top, h, colors):
    """Draw blocky word centered on cx. `colors` maps index->rgb (default WHITE)."""
    total, w, gap = word_width(text, h)
    x = cx - total / 2
    for i, ch in enumerate(text):
        rgba(cr, colors.get(i, WHITE))
        glyph(cr, ch, x, top, w, h)
        x += w + gap
    return total


# ---- 7-segment digits (same as render.js) -----------------------------------
DIGITS = {
    "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
    "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcfgd",
}


def digit(cr, d, x, y, w, h):
    t = w * 0.22
    midY = y + (h - t) / 2
    rects = {
        "a": (x, y, w, t), "b": (x + w - t, y, t, h / 2),
        "c": (x + w - t, y + h / 2, t, h / 2), "d": (x, y + h - t, w, t),
        "e": (x, y + h / 2, t, h / 2), "f": (x, y, t, h / 2), "g": (x, midY, w, t),
    }
    for s in DIGITS[d]:
        r = rects[s]
        cr.rectangle(*r)
        cr.fill()


def number(cr, n, cx, top, dh):
    s = str(n)
    dw = dh * 0.62
    gap = dw * 0.35
    total = len(s) * dw + (len(s) - 1) * gap
    x = cx - total / 2
    for ch in s:
        digit(cr, ch, x, top, dw, dh)
        x += dw + gap


# ---- Effects ----------------------------------------------------------------
def ball_glow(cr, cx, cy, r, glow=CYAN, glow_r=None, core=WHITE):
    glow_r = glow_r or r * 4.0
    g = cairo.RadialGradient(cx, cy, r * 0.4, cx, cy, glow_r)
    g.add_color_stop_rgba(0, glow[0], glow[1], glow[2], 0.75)
    g.add_color_stop_rgba(0.5, glow[0], glow[1], glow[2], 0.18)
    g.add_color_stop_rgba(1, glow[0], glow[1], glow[2], 0.0)
    cr.set_source(g)
    cr.arc(cx, cy, glow_r, 0, 2 * math.pi)
    cr.fill()
    # classic square ball core
    rgba(cr, core)
    cr.rectangle(cx - r, cy - r, r * 2, r * 2)
    cr.fill()


def dashed_net(cr, x, y0, y1, w, color=GREY, alpha=1.0, dash=26, gap=22):
    rgba(cr, color, alpha)
    y = y0
    while y < y1 - dash:
        cr.rectangle(x - w / 2, y, w, dash)
        cr.fill()
        y += dash + gap


def scanlines(cr, w, h, step=3, alpha=0.06):
    rgba(cr, (0, 0, 0), alpha)
    y = 0
    while y < h:
        cr.rectangle(0, y, w, 1)
        cr.fill()
        y += step


def vertical_gradient(cr, x, y, w, h, top, bottom):
    g = cairo.LinearGradient(0, y, 0, y + h)
    g.add_color_stop_rgb(0, *top)
    g.add_color_stop_rgb(1, *bottom)
    cr.set_source(g)
    cr.rectangle(x, y, w, h)
    cr.fill()


def text_glow(cr, s, size, cx, cy, color=WHITE, glow=CYAN, bold=True, mono=True):
    face = "monospace" if mono else "sans-serif"
    weight = cairo.FONT_WEIGHT_BOLD if bold else cairo.FONT_WEIGHT_NORMAL
    cr.select_font_face(face, cairo.FONT_SLANT_NORMAL, weight)
    cr.set_font_size(size)
    xb, yb, tw, th, _, _ = cr.text_extents(s)
    tx = cx - tw / 2 - xb
    ty = cy - th / 2 - yb
    # soft glow
    for (dx, dy, a) in [(0, 0, 0.20), (1.5, 0, 0.14), (-1.5, 0, 0.14), (0, 1.5, 0.14)]:
        rgba(cr, glow, a)
        cr.move_to(tx + dx, ty + dy)
        cr.show_text(s)
    rgba(cr, color)
    cr.move_to(tx, ty)
    cr.show_text(s)
    return tw


# =============================================================================
# ICON  512x512 — rounded tile with a compact Pong scene.
# =============================================================================
def make_icon():
    S = 512
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, S, S)
    cr = cairo.Context(surf)

    m = 22
    r = 104
    # tile
    rounded_rect(cr, m, m, S - 2 * m, S - 2 * m, r)
    cr.clip()
    vertical_gradient(cr, 0, 0, S, S, BG_TOP, BG)

    # faint top/bottom walls
    rgba(cr, GREY, 0.55)
    cr.rectangle(m + 46, 96, S - 2 * (m + 46), 12); cr.fill()
    cr.rectangle(m + 46, S - 96 - 12, S - 2 * (m + 46), 12); cr.fill()

    # dashed net
    dashed_net(cr, S / 2, 120, S - 120, 12, GREY, 0.85, dash=30, gap=24)

    # paddles: white left (lower), cyan right (upper)
    rgba(cr, WHITE)
    rounded_rect(cr, 96, 288, 26, 132, 8); cr.fill()
    rgba(cr, CYAN)
    rounded_rect(cr, S - 96 - 26, 150, 26, 132, 8); cr.fill()

    # ball with glow, mid-field heading toward the cyan paddle
    ball_glow(cr, 300, 250, 20, glow=CYAN, glow_r=96)

    cr.reset_clip()
    # subtle rim
    rgba(cr, CYAN, 0.28)
    cr.set_line_width(3)
    rounded_rect(cr, m + 1.5, m + 1.5, S - 2 * m - 3, S - 2 * m - 3, r - 2)
    cr.stroke()

    surf.write_to_png(os.path.join(ASSETS, "icon.png"))
    print("wrote assets/icon.png")


# =============================================================================
# LOGO  1280x380 — transparent wordmark lockup (paddles bookend GNOMEPONG).
# =============================================================================
def make_logo():
    W, H = 1280, 380
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    cr = cairo.Context(surf)

    # Self-contained rounded dark tile (Pong's identity is dark, and this keeps
    # the wordmark legible on any host background — light or dark).
    rounded_rect(cr, 0, 0, W, H, 48)
    cr.clip()
    vertical_gradient(cr, 0, 0, W, H, BG_TOP, BG)

    gh = 150
    cy = H / 2
    top = cy - gh / 2

    # "GNOME" dim white, "PONG" bright — cyan ball dots the baseline.
    colors = {}
    for i in range(5):      # GNOME
        colors[i] = (0.72, 0.80, 0.88)
    for i in range(5, 9):   # PONG
        colors[i] = WHITE
    total = draw_word(cr, "GNOMEPONG", W / 2, top, gh, colors)

    # bookend paddles
    ph = gh * 1.28
    py = cy - ph / 2
    x_left = W / 2 - total / 2 - 58
    x_right = W / 2 + total / 2 + 58 - 22
    rgba(cr, WHITE)
    rounded_rect(cr, x_left, py, 22, ph, 7); cr.fill()
    rgba(cr, CYAN)
    rounded_rect(cr, x_right, py, 22, ph, 7); cr.fill()

    # glowing ball on the baseline between the two words
    baseline = top + gh + 6
    ball_glow(cr, W / 2 - total * 0.02, baseline, 12, glow=CYAN, glow_r=54)

    cr.reset_clip()
    # subtle rim
    rgba(cr, CYAN, 0.22)
    cr.set_line_width(2)
    rounded_rect(cr, 1, 1, W - 2, H - 2, 47)
    cr.stroke()

    surf.write_to_png(os.path.join(ASSETS, "logo.png"))
    print("wrote assets/logo.png")


# =============================================================================
# BANNER  1280x640 — hero: atmospheric court + wordmark + tagline.
# =============================================================================
def make_banner():
    W, H = 1280, 640
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    cr = cairo.Context(surf)

    vertical_gradient(cr, 0, 0, W, H, BG_TOP, BG)

    # --- faint court backdrop ---
    rgba(cr, GREY, 0.22)
    cr.rectangle(60, 40, W - 120, 10); cr.fill()          # top wall
    cr.rectangle(60, H - 40 - 10, W - 120, 10); cr.fill()  # bottom wall
    dashed_net(cr, W / 2, 60, H - 60, 8, GREY, 0.14, dash=26, gap=22)

    # 7-seg scores near the top (dim, atmospheric)
    rgba(cr, WHITE)
    cr.push_group()
    number(cr, 2, W * 0.30, 78, 96)
    number(cr, 5, W * 0.70, 78, 96)
    grp = cr.pop_group()
    cr.set_source(grp)
    cr.paint_with_alpha(0.30)

    # backdrop paddles at the edges
    rgba(cr, WHITE, 0.35)
    rounded_rect(cr, 70, 300, 22, 150, 7); cr.fill()
    rgba(cr, CYAN, 0.40)
    rounded_rect(cr, W - 70 - 22, 180, 22, 150, 7); cr.fill()

    # ball with a short motion trail heading toward the cyan paddle, kept in the
    # upper band (between the scores and the wordmark) so it never fights the type
    for i, bx in enumerate([760, 880, 1000]):
        ball_glow(cr, bx, 168 + i * 8, 9 + i * 2,
                  glow=CYAN, glow_r=34 + i * 9,
                  core=(WHITE[0], WHITE[1], WHITE[2]))

    # --- wordmark (focal) ---
    gh = 132
    top = H * 0.44 - gh / 2
    colors = {}
    for i in range(5):
        colors[i] = (0.80, 0.87, 0.94)
    for i in range(5, 9):
        colors[i] = WHITE
    total = draw_word(cr, "GNOMEPONG", W / 2, top, gh, colors)

    # cyan underline with a dashed (net-like) center break
    uy = top + gh + 26
    rgba(cr, CYAN, 0.9)
    cr.rectangle(W / 2 - total / 2, uy, total, 5)
    cr.fill()

    # tagline
    text_glow(cr, "CLASSIC PONG FOR YOUR GNOME DESKTOP",
              27, W / 2, uy + 52, color=(0.86, 0.92, 0.98), glow=CYAN)
    text_glow(cr, "1P vs AI   ·   2P LOCAL   ·   LAN / ONLINE",
              22, W / 2, uy + 92, color=CYAN, glow=CYAN)

    # CRT scanlines + vignette on top
    scanlines(cr, W, H, step=3, alpha=0.05)
    vg = cairo.RadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, W * 0.62)
    vg.add_color_stop_rgba(0, 0, 0, 0, 0)
    vg.add_color_stop_rgba(1, 0, 0, 0, 0.55)
    cr.set_source(vg)
    cr.rectangle(0, 0, W, H)
    cr.fill()

    surf.write_to_png(os.path.join(ASSETS, "banner.png"))
    print("wrote assets/banner.png")


if __name__ == "__main__":
    make_icon()
    make_logo()
    make_banner()
