#!/usr/bin/env python3
"""Makes the Homey app image, driver image and icons.

Sizes required by Homey:
  app image     250x175 / 500x350 / 1000x700 (lifestyle photo)
  driver image   75x75  / 500x500 / 1000x1000 (photo of the device on white)
  icons         960x960 SVG, line drawing, transparent, no gradients

Usage:
  python3 tools/make-images.py <app-dir> icons
  python3 tools/make-images.py <app-dir> app-photo <photo>
  python3 tools/make-images.py <app-dir> driver-photo <photo-on-white>

For the driver image, first cut the Mac out of a photo:
  swift tools/cutout.swift <photo> driver.png

Requires: pip install pillow
"""
import math
import os
import sys

from PIL import Image

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


def centred(cx, cy, s):
    """Back-corner origin that centres the device (width 2*C30*s, height (1+h)*s) on (cx, cy)."""
    return cx, cy - (1 + MINI_H) * s / 2 + MINI_H * s


def cover(img, size):
    """Scales and centre-crops a photo to fill the given size."""
    w, h = size
    scale = max(w / img.width, h / img.height)
    img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    left, top = (img.width - w) // 2, (img.height - h) // 2
    return img.crop((left, top, left + w, top + h))


def app_image(photo):
    """Lifestyle photo, centre-cropped to 10:7."""
    img = Image.open(photo).convert("RGB")
    return cover(img, (1000, 700)), {"small": (250, 175), "large": (500, 350), "xlarge": (1000, 700)}


def driver_image(photo):
    """Photo of the device on white, made with tools/cutout.swift."""
    img = Image.open(photo).convert("RGB")
    side = min(img.width, img.height)
    img = cover(img, (side, side))
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
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    root, part = sys.argv[1], sys.argv[2]
    if part == "icons":
        for kind, adir in (("app", os.path.join(root, "assets")),
                           ("driver", os.path.join(root, "drivers", "mac", "assets"))):
            os.makedirs(adir, exist_ok=True)
            out = os.path.join(adir, "icon.svg")
            with open(out, "w") as f:
                f.write(icon(kind))
            print(f"  {out}")
        return

    builders = {"app-photo": (app_image, os.path.join(root, "assets", "images")),
                "driver-photo": (driver_image, os.path.join(root, "drivers", "mac", "assets", "images"))}
    if part not in builders or len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    build, adir = builders[part]
    os.makedirs(adir, exist_ok=True)
    img, sizes = build(sys.argv[3])
    for name, size in sizes.items():
        out = os.path.join(adir, f"{name}.png")
        img.resize(size, Image.LANCZOS).save(out, "PNG", optimize=True)
        print(f"  {out}  {size[0]}x{size[1]}")


if __name__ == "__main__":
    main()
