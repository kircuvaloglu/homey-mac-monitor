#!/usr/bin/env python3
"""Renders the 1024x1024 widget previews (preview-light.png, preview-dark.png).

The drawing follows the layout of app/widgets/macs/public/index.html.

Usage: python3 tools/make-widget-preview.py app/widgets/macs
Requires: pip install pillow resvg-py
"""
import io
import os
import sys

import resvg_py
from PIL import Image

FONT_DIRS = ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental"]
FONT = "Helvetica Neue, Helvetica, Arial, sans-serif"

THEMES = {
    "light": dict(bg="#eef1f5", card="#ffffff", ink="#16181d", ink2="#6b7482", tile="#f4f6f9",
                  line="#e3e7ec", track="#e1e5ea", button="#eceff3",
                  purple="#7c6cf2", blue="#3d9bf0", green="#35b374", amber="#e0962b", red="#e0573f",
                  tint=0.14, shadow=0.08),
    "dark": dict(bg="#07090b", card="#121619", ink="#eef2f6", ink2="#9aa5b1", tile="#1a1f23",
                 line="#2d343a", track="#2b3238", button="#242a2f",
                 purple="#8b7cff", blue="#4aa8ff", green="#4cc98a", amber="#f2b457", red="#f07a63",
                 tint=0.2, shadow=0.5),
}

# Same icon paths as the widget (24x24, stroked).
ICONS = {
    "cpu": '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/>'
           '<path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    "memory": '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 11v2M10 11v2M14 11v2M18 11v2M5 17v2M19 17v2"/>',
    "temperature": '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 11v6"/>',
    "fan": '<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 1-7 4-7 2 0 2.5 3 0 5l-2.3 2.6"/>'
           '<path d="M14 12c4 0 7 1 7 4 0 2-3 2.5-5 0l-2.6-2.3"/><path d="M12 14c0 4-1 7-4 7-2 0-2.5-3 0-5l2.3-2.6"/>'
           '<path d="M10 12c-4 0-7-1-7-4 0-2 3-2.5 5 0l2.6 2.3"/>',
    "storage": '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/>'
               '<path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    "refresh": '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
}

# Sample Mac shown in the preview.
TILES = [
    dict(icon="cpu", color="purple", value="4", unit="%", label="CPU", percent=4),
    dict(icon="memory", color="blue", value="26", unit="%", label="Memory", percent=26),
    dict(icon="temperature", color="green", value="55", unit=" °C", label="Temperature", percent=44, gradient=True),
    dict(icon="fan", color="blue", value="1000", unit=" RPM", label="Fan", percent=20),
    dict(icon="storage", color="green", value="52", unit="%", label="Storage", extra="96.8 GB free", percent=52, wide=True),
]


def hex_rgba(color, alpha):
    c = color.lstrip("#")
    return f"rgba({int(c[0:2], 16)},{int(c[2:4], 16)},{int(c[4:6], 16)},{alpha})"


def icon(name, x, y, size, color):
    k = size / 24
    return (f'<g transform="translate({x} {y}) scale({k})" fill="none" stroke="{color}" stroke-width="2" '
            f'stroke-linecap="round" stroke-linejoin="round">{ICONS[name]}</g>')


def build(theme):
    T = THEMES[theme]
    S = 1024
    k = 2.2                      # widget px -> preview px
    card_w, card_h = 360 * k, 378 * k
    ox, oy = (S - card_w) / 2, (S - card_h) / 2
    px = lambda v: v * k

    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}" font-family="{FONT}">',
           '<defs><filter id="blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="18"/></filter>',
           '<linearGradient id="heat" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#38d6e0"/>'
           '<stop offset="0.45" stop-color="#4cc98a"/><stop offset="0.75" stop-color="#f2b457"/>'
           '<stop offset="1" stop-color="#f07a63"/></linearGradient></defs>',
           f'<rect width="{S}" height="{S}" fill="{T["bg"]}"/>',
           f'<rect x="{ox}" y="{oy + 14}" width="{card_w}" height="{card_h}" rx="{px(18)}" fill="#000" '
           f'opacity="{T["shadow"]}" filter="url(#blur)"/>',
           f'<rect x="{ox}" y="{oy}" width="{card_w}" height="{card_h}" rx="{px(18)}" fill="{T["card"]}"/>']

    g = lambda x, y: (ox + px(x), oy + px(y))

    # header
    x, y = g(16, 36)
    out.append(f'<text x="{x}" y="{y}" font-size="{px(20)}" font-weight="700" fill="{T["ink"]}">Office Mac mini</text>')
    x, y = g(16, 58)
    out.append(f'<circle cx="{x + px(4.5)}" cy="{y - px(4.5)}" r="{px(4.5)}" fill="{T["green"]}"/>')
    out.append(f'<text x="{x + px(15)}" y="{y}" font-size="{px(14)}" fill="{T["ink2"]}">Online · Updated 00:24</text>')
    x, y = g(304, 22)
    out.append(f'<rect x="{x}" y="{y}" width="{px(40)}" height="{px(40)}" rx="{px(10)}" fill="{T["button"]}"/>')
    out.append(icon("refresh", x + px(10), y + px(10), px(20), T["ink"]))

    # tiles
    col_w, tile_h, gap = 160, 80, 8
    for i, t in enumerate(TILES):
        row, col = divmod(i, 2)
        tx, ty = 16 + (0 if t.get("wide") else col * (col_w + gap)), 74 + row * (tile_h + gap)
        tw = 328 if t.get("wide") else col_w
        x, y = g(tx, ty)
        color = T[t["color"]]
        out.append(f'<rect x="{x}" y="{y}" width="{px(tw)}" height="{px(tile_h)}" rx="{px(12)}" '
                   f'fill="{T["tile"]}" stroke="{T["line"]}" stroke-width="{k}"/>')
        ix, iy = x + px(12), y + px(12)
        out.append(f'<rect x="{ix}" y="{iy}" width="{px(38)}" height="{px(38)}" rx="{px(10)}" fill="{hex_rgba(color, T["tint"])}"/>')
        out.append(icon(t["icon"], ix + px(8), iy + px(8), px(22), color))
        vx = ix + px(48)
        long_value = len(t["value"]) + len(t["unit"]) > 7
        vsize, usize = (20, 13) if long_value else (24, 15)
        out.append(f'<text x="{vx}" y="{iy + px(20)}" font-size="{px(vsize)}" font-weight="700" fill="{T["ink"]}">'
                   f'{t["value"]}<tspan font-size="{px(usize)}" dx="{px(5 if t["unit"].startswith(" ") else 2)}">{t["unit"].strip()}</tspan></text>')
        label = t["label"] + (f' · {t["extra"]}' if t.get("extra") else "")
        out.append(f'<text x="{vx}" y="{iy + px(36)}" font-size="{px(13)}" fill="{T["ink2"]}">{label}</text>')
        bx, by, bw = x + px(12), y + px(62), px(tw - 24)
        out.append(f'<rect x="{bx}" y="{by}" width="{bw}" height="{px(6)}" rx="{px(3)}" fill="{T["track"]}"/>')
        fill = "url(#heat)" if t.get("gradient") else color
        out.append(f'<rect x="{bx}" y="{by}" width="{max(px(6), bw * t["percent"] / 100)}" height="{px(6)}" rx="{px(3)}" fill="{fill}"/>')

    # footer
    x, y = g(16, 356)
    out.append(f'<text x="{x}" y="{y}" font-size="{px(13)}" fill="{T["ink2"]}">Power 9.4 W<tspan dx="{px(14)}">Uptime 5h 18m</tspan></text>')
    out.append("</svg>")
    return "\n".join(out)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    for name in ("light", "dark"):
        data = bytes(resvg_py.svg_to_bytes(svg_string=build(name), font_dirs=FONT_DIRS))
        p = os.path.join(out, f"preview-{name}.png")
        Image.open(io.BytesIO(data)).convert("RGB").save(p, "PNG", optimize=True)
        print(f"  {p}  1024x1024")


if __name__ == "__main__":
    main()
