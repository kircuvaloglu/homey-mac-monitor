#!/usr/bin/env python3
"""Renders the 1024x1024 widget previews (preview-light.png, preview-dark.png).

Homey wants previews made of simple shapes, without text and on a transparent
background, so the layout of app/widgets/macs/public/index.html is drawn with
placeholder bars.

Usage: python3 tools/make-widget-preview.py app/widgets/macs
Requires: pip install pillow resvg-py
"""
import io
import os
import sys

import resvg_py
from PIL import Image

THEMES = {
    "light": dict(card="#ffffff", line="#e3e7ec", tile="#f4f6f9", text="#c9cfd8", text2="#dde2e8",
                  track="#e1e5ea", button="#eceff3",
                  purple="#7c6cf2", blue="#3d9bf0", green="#35b374", tint=0.16),
    "dark": dict(card="#15191c", line="#2d343a", tile="#1f2429", text="#4a535c", text2="#353d45",
                 track="#2e353b", button="#2a3035",
                 purple="#8b7cff", blue="#4aa8ff", green="#4cc98a", tint=0.22),
}

# color, bar fill (0..1), wide
TILES = [
    ("purple", 0.12, False),
    ("blue", 0.34, False),
    ("green", 0.46, False),
    ("blue", 0.22, False),
    ("purple", 0.40, True),
    ("green", 0.55, True),
]


def hex_rgba(color, alpha):
    c = color.lstrip("#")
    return f"rgba({int(c[0:2], 16)},{int(c[2:4], 16)},{int(c[4:6], 16)},{alpha})"


def build(theme):
    T = THEMES[theme]
    S = 1024
    k = 1.95                     # widget px -> preview px
    card_w, card_h = 360 * k, 452 * k
    ox, oy = (S - card_w) / 2, (S - card_h) / 2
    px = lambda v: v * k
    g = lambda x, y: (ox + px(x), oy + px(y))
    bar = lambda x, y, w, h, fill: (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{h / 2}" fill="{fill}"/>')

    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">',
           f'<rect x="{ox}" y="{oy}" width="{card_w}" height="{card_h}" rx="{px(18)}" fill="{T["card"]}"/>']

    # header: name, status, refresh button
    x, y = g(16, 20)
    out.append(bar(x, y, px(150), px(16), T["text"]))
    x, y = g(16, 46)
    out.append(f'<circle cx="{x + px(4.5)}" cy="{y + px(5)}" r="{px(4.5)}" fill="{T["green"]}"/>')
    out.append(bar(x + px(16), y, px(110), px(10), T["text2"]))
    x, y = g(304, 18)
    out.append(f'<rect x="{x}" y="{y}" width="{px(40)}" height="{px(40)}" rx="{px(10)}" fill="{T["button"]}"/>')

    # tiles
    col_w, tile_h, gap = 160, 80, 8
    row = 0
    col = 0
    for color_name, fill, wide in TILES:
        if wide and col:
            row, col = row + 1, 0
        tw = 328 if wide else col_w
        x, y = g(16 + col * (col_w + gap), 74 + row * (tile_h + gap))
        color = T[color_name]
        out.append(f'<rect x="{x}" y="{y}" width="{px(tw)}" height="{px(tile_h)}" rx="{px(12)}" '
                   f'fill="{T["tile"]}" stroke="{T["line"]}" stroke-width="{k}"/>')
        ix, iy = x + px(12), y + px(12)
        out.append(f'<rect x="{ix}" y="{iy}" width="{px(38)}" height="{px(38)}" rx="{px(10)}" fill="{hex_rgba(color, T["tint"])}"/>')
        out.append(f'<circle cx="{ix + px(19)}" cy="{iy + px(19)}" r="{px(7)}" fill="{color}"/>')
        out.append(bar(ix + px(48), iy + px(4), px(48 if not wide else 70), px(14), T["text"]))
        out.append(bar(ix + px(48), iy + px(25), px(66 if not wide else 130), px(9), T["text2"]))
        bx, by, bw = x + px(12), y + px(62), px(tw - 24)
        out.append(bar(bx, by, bw, px(6), T["track"]))
        out.append(bar(bx, by, max(px(6), bw * fill), px(6), color))
        if wide:
            row, col = row + 1, 0
        else:
            col += 1
            if col == 2:
                row, col = row + 1, 0

    # footer
    x, y = g(16, 426)
    out.append(bar(x, y, px(70), px(9), T["text2"]))
    out.append(bar(x + px(84), y, px(90), px(9), T["text2"]))
    out.append("</svg>")
    return "\n".join(out)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    for name in ("light", "dark"):
        data = bytes(resvg_py.svg_to_bytes(svg_string=build(name)))
        p = os.path.join(out, f"preview-{name}.png")
        Image.open(io.BytesIO(data)).convert("RGBA").save(p, "PNG", optimize=True)
        print(f"  {p}  1024x1024")


if __name__ == "__main__":
    main()
