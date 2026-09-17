#!/usr/bin/env python3
"""Renders the Homey app image, driver image and icons.

Sizes required by Homey:
  app image     250x175 / 500x350 / 1000x700
  driver image   75x75  / 500x500 / 1000x1000 (white background)
  icons         960x960 SVG, line drawing, transparent, no gradients

Usage: python3 tools/make-images.py <app-dir> [app-image|driver-image|icons ...]
Requires: pip install pillow resvg-py
"""
import io
import math
import os
import random
import sys

import resvg_py
from PIL import Image

FONT_DIRS = ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental"]
C30 = math.sqrt(3) / 2


def iso(ox, oy, s):
    """Isometric projection: x to the lower right, y to the lower left, z up."""
    ex, ey, ez = (C30 * s, 0.5 * s), (-C30 * s, 0.5 * s), (0, -s)

    def P(x, y, z=0.0):
        return (ox + x * ex[0] + y * ey[0], oy + x * ex[1] + y * ey[1] + z * ez[1])

    return P, ex, ey


def matrix(a, b, o):
    return f"matrix({a[0]:.4f} {a[1]:.4f} {b[0]:.4f} {b[1]:.4f} {o[0]:.2f} {o[1]:.2f})"


# Mac mini proportions: square footprint, height 0.39 of the width, rounded corners.
MINI_H, MINI_R = 0.39, 0.2


def mac_mini(uid, ox, oy, s, shadow=0.35, spread=1.0):
    """Shaded Mac mini (no logo). (ox, oy) is the back corner of the footprint."""
    P, ex, ey = iso(ox, oy, s)
    h, r = MINI_H, MINI_R
    out = [f"""<defs>
  <linearGradient id="{uid}side" gradientUnits="userSpaceOnUse" x1="{P(0, 1)[0]:.1f}" y1="0" x2="{P(1, 0)[0]:.1f}" y2="0">
    <stop offset="0" stop-color="#c9ced6"/><stop offset="0.52" stop-color="#dfe3e8"/>
    <stop offset="0.56" stop-color="#aeb4bd"/><stop offset="1" stop-color="#9aa0a9"/>
  </linearGradient>
  <linearGradient id="{uid}top" gradientUnits="userSpaceOnUse" x1="{P(0, 0, h)[0]:.1f}" y1="{P(0, 0, h)[1]:.1f}" x2="{P(1, 1, h)[0]:.1f}" y2="{P(1, 1, h)[1]:.1f}">
    <stop offset="0" stop-color="#f3f5f7"/><stop offset="0.55" stop-color="#e2e6ea"/><stop offset="1" stop-color="#cfd4da"/>
  </linearGradient>
  <filter id="{uid}blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="{s * 0.06:.1f}"/></filter>
</defs>"""]
    sc = P(0.62, 0.62)
    out.append(f'<ellipse cx="{sc[0]:.1f}" cy="{sc[1]:.1f}" rx="{s * 0.92 * spread:.1f}" ry="{s * 0.5 * spread:.1f}" '
               f'fill="#000" opacity="{shadow}" filter="url(#{uid}blur)"/>')
    out.append(f'<rect x="0.03" y="0.03" width="0.94" height="0.94" rx="{r}" fill="#23262b" '
               f'transform="{matrix(ex, ey, P(0, 0))}"/>')
    # The body is a stack of rounded rectangles, which gives rounded vertical edges.
    for i in range(41):
        z = 0.035 + (h - 0.035) * i / 40
        out.append(f'<rect width="1" height="1" rx="{r}" fill="url(#{uid}side)" transform="{matrix(ex, ey, P(0, 0, z))}"/>')
    out.append(f'<rect width="1" height="1" rx="{r}" fill="url(#{uid}top)" transform="{matrix(ex, ey, P(0, 0, h))}"/>')
    out.append(f'<rect x="0.012" y="0.012" width="0.976" height="0.976" rx="{r - 0.01}" fill="none" stroke="#fff" '
               f'stroke-opacity="0.8" stroke-width="0.006" transform="{matrix(ex, ey, P(0, 0, h))}"/>')
    # Front: two USB-C ports, headphone jack, status light.
    face = matrix(ex, (0, s), P(0, 1, h))
    for px in (0.26, 0.36):
        out.append(f'<rect x="{px}" y="0.17" width="0.075" height="0.03" rx="0.015" fill="#2d3036" transform="{face}"/>')
    out.append(f'<circle cx="0.48" cy="0.185" r="0.016" fill="#2d3036" transform="{face}"/>')
    out.append(f'<circle cx="0.82" cy="0.185" r="0.009" fill="#f4fff9" transform="{face}"/>')
    return "\n".join(out)


def centred(cx, cy, s):
    """Back-corner origin that centres the device (width 2*C30*s, height (1+h)*s) on (cx, cy)."""
    return cx, cy - (1 + MINI_H) * s / 2 + MINI_H * s


def svg(w, h, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
            f'font-family="Helvetica Neue, Helvetica, Arial, sans-serif">{body}</svg>')


def render(content):
    return Image.open(io.BytesIO(bytes(resvg_py.svg_to_bytes(svg_string=content, font_dirs=FONT_DIRS)))).convert("RGB")


def app_image():
    """A Mac mini on a desk in the evening, with a monitor showing its readings."""
    b = ["""<defs>
  <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#141b2b"/><stop offset="1" stop-color="#232d44"/></linearGradient>
  <radialGradient id="lamp" cx="0.82" cy="0.28" r="0.55"><stop offset="0" stop-color="#ffcf8a" stop-opacity="0.55"/><stop offset="1" stop-color="#ffcf8a" stop-opacity="0"/></radialGradient>
  <linearGradient id="desk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a5f3f"/><stop offset="1" stop-color="#5a3b26"/></linearGradient>
  <linearGradient id="screen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f1726"/><stop offset="1" stop-color="#16233a"/></linearGradient>
  <linearGradient id="arc" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#38d6e0"/><stop offset="0.6" stop-color="#8fd18a"/><stop offset="1" stop-color="#f2b457"/></linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#38d6e0" stop-opacity="0.35"/><stop offset="1" stop-color="#38d6e0" stop-opacity="0"/></radialGradient>
</defs>""",
         '<rect width="1000" height="700" fill="url(#wall)"/>',
         '<rect x="70" y="70" width="250" height="300" rx="8" fill="#0d1422" stroke="#39445c" stroke-width="6"/>',
         '<line x1="195" y1="70" x2="195" y2="370" stroke="#39445c" stroke-width="5"/>',
         '<line x1="70" y1="220" x2="320" y2="220" stroke="#39445c" stroke-width="5"/>']
    rnd = random.Random(7)
    for _ in range(46):
        x, y = rnd.uniform(82, 308), rnd.uniform(160, 362)
        if abs(x - 195) < 6 or abs(y - 220) < 6:
            continue
        c = rnd.choice(["#ffd27a", "#ffe9b8", "#7fb8ff", "#ffb36b"])
        b.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{rnd.uniform(1.5, 4):.1f}" fill="{c}" opacity="{rnd.uniform(0.35, 0.9):.2f}"/>')
    b.append('<rect width="1000" height="700" fill="url(#lamp)"/>')

    b.append('<polygon points="0,400 1000,400 1000,700 0,700" fill="url(#desk)"/>')
    for i in range(9):
        y = 424 + i * 31
        b.append(f'<path d="M0 {y} C 250 {y - 6}, 520 {y + 8}, 1000 {y - 2}" stroke="#4a3020" stroke-opacity="0.35" stroke-width="2" fill="none"/>')
    b.append('<rect x="0" y="396" width="1000" height="8" fill="#a67a55"/>')

    b += ['<rect x="468" y="120" width="410" height="262" rx="14" fill="#0a0d12"/>',
          '<rect x="480" y="132" width="386" height="238" rx="6" fill="url(#screen)"/>',
          '<rect x="655" y="382" width="36" height="56" fill="#9aa1ab"/>',
          '<path d="M 600 452 L 746 452 L 736 434 L 610 434 Z" fill="#b7bdc5"/>']
    cx, cy, rr = 580, 262, 62
    b.append(f'<path d="M {cx - rr} {cy + 34} A {rr} {rr} 0 1 1 {cx + rr} {cy + 34}" fill="none" stroke="#26344d" stroke-width="12" stroke-linecap="round"/>')
    b.append(f'<path d="M {cx - rr} {cy + 34} A {rr} {rr} 0 1 1 {cx + rr * 0.72:.1f} {cy - rr * 0.69:.1f}" fill="none" stroke="url(#arc)" stroke-width="12" stroke-linecap="round"/>')
    b.append(f'<text x="{cx}" y="{cy + 12}" font-size="34" font-weight="700" fill="#e8edf4" text-anchor="middle">58°</text>')
    b.append(f'<text x="{cx}" y="{cy + 36}" font-size="12" font-weight="600" fill="#7f8ca3" text-anchor="middle" letter-spacing="1">CPU</text>')
    pts = [(680, 300), (705, 288), (728, 296), (752, 262), (776, 272), (800, 238), (826, 250), (850, 226)]
    line = " ".join(f"{x},{y}" for x, y in pts)
    b.append(f'<polygon points="{line} 850,318 680,318" fill="#38d6e0" opacity="0.12"/>')
    b.append(f'<polyline points="{line}" fill="none" stroke="#38d6e0" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>')
    for i, hgt in enumerate([26, 40, 18, 34, 22]):
        b.append(f'<rect x="{688 + i * 34}" y="{350 - hgt}" width="20" height="{hgt}" rx="4" fill="#4c5d7a"/>')
    for i, wdt in enumerate([120, 80]):
        b.append(f'<rect x="680" y="{164 + i * 22}" width="{wdt}" height="10" rx="5" fill="#2a3a55"/>')

    b += ['<rect x="905" y="250" width="10" height="210" fill="#2c2f36"/>',
          '<path d="M 850 250 L 960 250 L 935 200 L 875 200 Z" fill="#2c2f36"/>',
          '<ellipse cx="905" cy="252" rx="52" ry="7" fill="#ffe2b0"/>',
          '<ellipse cx="910" cy="458" rx="46" ry="9" fill="#1d1f24"/>',
          '<path d="M 120 470 L 190 470 L 180 540 L 130 540 Z" fill="#d9d4cb"/>']
    for ang, ln in [(-60, 90), (-80, 120), (-100, 110), (-120, 85), (-40, 70), (-140, 70)]:
        a = math.radians(ang)
        x2, y2 = 155 + ln * math.cos(a), 470 + ln * math.sin(a)
        b.append(f'<path d="M155 470 Q {155 + ln * 0.3 * math.cos(a) - 12:.0f} {470 + ln * 0.6 * math.sin(a):.0f} {x2:.0f} {y2:.0f}" '
                 f'stroke="#3f8f5f" stroke-width="16" stroke-linecap="round" fill="none"/>')

    b.append('<ellipse cx="430" cy="600" rx="300" ry="110" fill="url(#glow)"/>')
    b.append(mac_mini("m", 430, 450, 220, shadow=0.4))
    img = render(svg(1000, 700, "\n".join(b)))
    return img, {"small": (250, 175), "large": (500, 350), "xlarge": (1000, 700)}


def driver_image():
    """The device on a white background."""
    ox, oy = centred(500, 480, 470)
    body = '<rect width="1000" height="1000" fill="#ffffff"/>' + mac_mini("d", ox, oy, 470, shadow=0.18, spread=0.85)
    img = render(svg(1000, 1000, body))
    return img, {"small": (75, 75), "large": (500, 500), "xlarge": (1000, 1000)}


def rounded_square(r, n=12):
    """Outline of a unit square with rounded corners, counter-clockwise."""
    pts = []
    for cx, cy, a0 in [(1 - r, r, -90), (1 - r, 1 - r, 0), (r, 1 - r, 90), (r, r, 180)]:
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def hull(points):
    pts = sorted(set((round(x, 3), round(y, 3)) for x, y in points))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def path(points, closed=True):
    d = "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in points)
    return d + (" Z" if closed else "")


def mini_outline(ox, oy, s):
    """Line drawing of the Mac mini: silhouette and top edge, plus a helper for the front face."""
    P, ex, ey = iso(ox, oy, s)
    loop = rounded_square(MINI_R)
    top = [P(x, y, MINI_H) for x, y in loop]
    bottom = [P(x, y, 0) for x, y in loop]

    def face(u, v):
        """Point on the front face: u along the width, v down from the top edge."""
        x, y = P(u, 1, MINI_H)
        return x, y + v * s

    return [path(hull(top + bottom)), path(top)], face


def icon(kind):
    if kind == "app":
        s = 400
        ox, oy = centred(480, 610, s)
    else:
        s = 470
        ox, oy = centred(480, 480, s)
    paths, face = mini_outline(ox, oy, s)
    body = [f'<path d="{p}"/>' for p in paths]
    for u in (0.24, 0.40):
        body.append(f'<path d="{path([face(u, 0.185), face(u + 0.04, 0.185)], closed=False)}"/>')
    led = face(0.82, 0.185)
    body.append(f'<circle cx="{led[0]:.1f}" cy="{led[1]:.1f}" r="14" fill="#1f2530" stroke="none"/>')
    if kind == "app":
        # Pulse line above the device.
        body.append('<path d="M 150 170 L 360 170 L 410 80 L 480 250 L 540 130 L 580 170 L 810 170"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960" width="960" height="960">\n'
            f'<g fill="none" stroke="#1f2530" stroke-width="36" stroke-linecap="round" stroke-linejoin="round">\n'
            + "\n".join(body) + "\n</g>\n</svg>\n")


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    parts = sys.argv[2:] or ["app-image", "driver-image", "icons"]
    targets = {"app-image": (app_image, os.path.join(root, "assets", "images")),
               "driver-image": (driver_image, os.path.join(root, "drivers", "mac", "assets", "images"))}
    for part in parts:
        if part == "icons":
            for kind, adir in (("app", os.path.join(root, "assets")),
                               ("driver", os.path.join(root, "drivers", "mac", "assets"))):
                os.makedirs(adir, exist_ok=True)
                out = os.path.join(adir, "icon.svg")
                with open(out, "w") as f:
                    f.write(icon(kind))
                print(f"  {out}")
            continue
        build, adir = targets[part]
        os.makedirs(adir, exist_ok=True)
        img, sizes = build()
        for name, size in sizes.items():
            out = os.path.join(adir, f"{name}.png")
            img.resize(size, Image.LANCZOS).save(out, "PNG", optimize=True)
            print(f"  {out}  {size[0]}x{size[1]}")


if __name__ == "__main__":
    main()
