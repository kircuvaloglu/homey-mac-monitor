#!/usr/bin/env python3
"""Draws the app icon, the driver icon and the capability icons.

Homey paints capability icons in its own colour and fills every shape it finds,
so an icon drawn with strokes ends up as a solid block. Everything here is
therefore drawn as filled outlines: a frame is one subpath for the outer edge
(clockwise) and one for the inner edge (counter-clockwise), which the non-zero
fill rule turns into a line of thickness T. Solid details are simply added as
further subpaths; overlapping shapes of the same direction merge.

Usage: python3 tools/make-icons.py <app-dir>
"""
import math
import os
import sys

T = 2.0        # thickness of the outlines, on a 24 x 24 grid
SCALE = 1.0    # set to 40 for the 960 x 960 app and driver icons


# --- numbers ---------------------------------------------------------------

def f(v):
    """Formats a coordinate or radius, scaled to the icon size."""
    s = f"{v * SCALE:.2f}".rstrip("0").rstrip(".")
    return s if s not in ("-0", "") else "0"


def n(v):
    """Formats a plain number (an angle or a flag), which is never scaled."""
    return f"{v:g}"


def p(point):
    return f"{f(point[0])},{f(point[1])}"


def at(cx, cy, r, angle):
    """Point on a circle. Angles are in degrees: 0 is right, 90 is up."""
    a = math.radians(angle)
    return cx + r * math.cos(a), cy - r * math.sin(a)


# --- shapes ----------------------------------------------------------------

def clockwise(points):
    """True when the ring of points runs clockwise (y grows downwards)."""
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2)
               in zip(points, points[1:] + points[:1])) > 0


def poly(points, cw=True):
    pts = list(points)
    if clockwise(pts) != cw:
        pts.reverse()
    return "M" + " ".join(p(q) for q in pts) + "Z"


def rect(x, y, w, h, r=0.0, cw=True):
    r = max(0.0, min(r, w / 2, h / 2))
    if r == 0:
        return poly([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], cw)
    c = lambda qx, qy: f"A{f(r)},{f(r)} 0 0 {1 if cw else 0} {f(qx)},{f(qy)}"
    if cw:
        return (f"M{f(x + r)},{f(y)}H{f(x + w - r)}{c(x + w, y + r)}V{f(y + h - r)}"
                f"{c(x + w - r, y + h)}H{f(x + r)}{c(x, y + h - r)}V{f(y + r)}{c(x + r, y)}Z")
    return (f"M{f(x + r)},{f(y)}{c(x, y + r)}V{f(y + h - r)}{c(x + r, y + h)}"
            f"H{f(x + w - r)}{c(x + w, y + h - r)}V{f(y + r)}{c(x + w - r, y)}Z")


def circle(cx, cy, r, cw=True):
    s = 1 if cw else 0
    return (f"M{f(cx - r)},{f(cy)}A{f(r)},{f(r)} 0 0 {s} {f(cx + r)},{f(cy)}"
            f"A{f(r)},{f(r)} 0 0 {s} {f(cx - r)},{f(cy)}Z")


def ellipse(cx, cy, rx, ry, angle):
    """Ellipse with its long axis along the given angle."""
    a = math.radians(angle)
    dx, dy = rx * math.cos(a), -rx * math.sin(a)
    arc = f"A{f(rx)},{f(ry)} {n(-angle)} 0 1"
    return (f"M{f(cx - dx)},{f(cy - dy)}{arc} {f(cx + dx)},{f(cy + dy)}"
            f"{arc} {f(cx - dx)},{f(cy - dy)}Z")


def half_disc(cx, cy, r):
    return f"M{f(cx - r)},{f(cy)}A{f(r)},{f(r)} 0 0 1 {f(cx + r)},{f(cy)}Z"


def frame(x, y, w, h, r, t=T):
    """Rectangular outline."""
    return rect(x, y, w, h, r) + rect(x + t, y + t, w - 2 * t, h - 2 * t, r - t, cw=False)


def ring(cx, cy, r, t=T):
    """Circular outline."""
    return circle(cx, cy, r) + circle(cx, cy, r - t, cw=False)


def line(a, b, t=T, caps=True):
    """Straight line of thickness t, with round ends."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    nx, ny = -dy / length * t / 2, dx / length * t / 2
    d = poly([(a[0] + nx, a[1] + ny), (b[0] + nx, b[1] + ny),
              (b[0] - nx, b[1] - ny), (a[0] - nx, a[1] - ny)])
    return d + circle(*a, t / 2) + circle(*b, t / 2) if caps else d


def arc(cx, cy, r, a0, a1, t=T):
    """Outline along a circular arc, from angle a0 to angle a1."""
    def sample(radius, start, end):
        steps = max(2, int(abs(end - start) / 10))
        return [at(cx, cy, radius, start + (end - start) * i / steps) for i in range(steps + 1)]

    if not clockwise(sample(r, a0, a1) + sample(r - t, a1, a0)):
        a0, a1 = a1, a0
    large, sweep = (1 if abs(a1 - a0) > 180 else 0), (0 if a1 > a0 else 1)
    return (f"M{p(at(cx, cy, r, a0))}A{f(r)},{f(r)} 0 {large} {sweep} {p(at(cx, cy, r, a1))}"
            f"L{p(at(cx, cy, r - t, a1))}"
            f"A{f(r - t)},{f(r - t)} 0 {large} {1 - sweep} {p(at(cx, cy, r - t, a0))}Z")


def arrow_head(cx, cy, r, angle, size, forward=True):
    """Triangle at the end of an arc, pointing along it."""
    tip = at(cx, cy, r, angle + (size * 1.7 / r) * (180 / math.pi) * (1 if forward else -1))
    return poly([at(cx, cy, r + size, angle), tip, at(cx, cy, r - size, angle)])


def wedge(cx, cy, r, a0, a1):
    """Filled sector of a circle."""
    steps = max(2, int(abs(a1 - a0) / 10))
    return poly([(cx, cy)] + [at(cx, cy, r, a0 + (a1 - a0) * i / steps) for i in range(steps + 1)])


def chain(points, t=T):
    """Open line through several points."""
    return "".join(line(a, b, t) for a, b in zip(points, points[1:]))


# --- capability icons ------------------------------------------------------

def cpu():
    d = frame(4.5, 4.5, 15, 15, 3.2) + rect(9.2, 9.2, 5.6, 5.6, 1.2)
    for q in (8.8, 13.5):
        d += rect(q, 1.9, 1.7, 2.8, 0.6) + rect(q, 19.3, 1.7, 2.8, 0.6)
        d += rect(1.9, q, 2.8, 1.7, 0.6) + rect(19.3, q, 2.8, 1.7, 0.6)
    return d


def memory():
    d = frame(2.0, 6.5, 20, 11, 2.2)
    for x in (6.6, 11.0, 15.4):
        d += rect(x, 10.2, 2.0, 3.6, 0.5)
    return d


def disk():
    return ring(12, 12, 8.6) + wedge(12, 12, 5.2, 74, -46)


def fan():
    d = ring(12, 12, 9.4, 1.9) + circle(12, 12, 1.9)
    for angle in (90, 0, -90, 180):
        cx, cy = at(12, 12, 4.0, angle)
        d += ellipse(cx, cy, 3.1, 1.9, angle)
    return d


def clock():
    return (ring(12, 12, 8.6) + line((12, 12), (12, 7.0), 1.8)
            + line((12, 12), (15.4, 13.8), 1.8))


def update():
    return (line((12, 3.4), (12, 11.6), 2.0, caps=False)
            + poly([(7.6, 10.6), (16.4, 10.6), (12, 16.6)])
            + line((5.2, 19.6), (18.8, 19.6), 2.0))


def backup():
    return (arc(12, 12, 8.6, 118, -205) + arrow_head(12, 12, 8.6 - T / 2, 118, 2.6)
            + line((12, 12), (12, 7.4), 1.7) + line((12, 12), (15.2, 13.6), 1.7))


def display():
    return (frame(2.0, 3.4, 20, 13.2, 2.2) + line((12, 16.6), (12, 19.4), 2.0, caps=False)
            + line((8.0, 20.4), (16.0, 20.4), 1.9))


def drive():
    return (frame(2.0, 7.4, 20, 9.2, 2.2) + rect(5.2, 11.0, 6.2, 2.0, 1.0)
            + circle(18.0, 12.0, 1.2))


def health():
    return frame(2.4, 4.4, 19.2, 15.2, 2.4) + chain(
        [(5.8, 12.0), (8.8, 12.0), (10.4, 8.4), (13.2, 15.6), (14.8, 12.0), (18.2, 12.0)], 1.7)


def lock():
    return (frame(4.0, 10.6, 16.0, 10.0, 2.4) + arc(12, 11.0, 5.0, 0, 180, 1.9)
            + circle(12, 15.6, 1.4))


def network():
    return (line((7.0, 3.6), (7.0, 13.4), 2.0, caps=False)
            + poly([(3.0, 12.2), (11.0, 12.2), (7.0, 19.0)])
            + line((17.0, 20.4), (17.0, 10.6), 2.0, caps=False)
            + poly([(13.0, 11.8), (21.0, 11.8), (17.0, 5.0)]))


def pressure():
    return (arc(12, 15.4, 8.4, 180, 0) + line((12, 15.4), at(12, 15.4, 6.4, 128), 1.9)
            + circle(12, 15.4, 1.7))


def thermometer():
    return rect(10.3, 2.6, 3.4, 13.4, 1.7) + circle(12, 17.3, 3.5)


def user():
    return circle(12, 8.2, 4.2) + half_disc(12, 21.4, 8.4)


CAPABILITIES = {
    "backup": backup, "clock": clock, "cpu": cpu, "disk": disk, "display": display,
    "drive": drive, "fan": fan, "health": health, "lock": lock, "memory": memory,
    "network": network, "pressure": pressure, "thermometer": thermometer,
    "update": update, "user": user,
}


# --- app and driver icon ---------------------------------------------------

def mac_mini(y, height=8.8):
    """Mac mini seen from the front: the case, the two front ports and the headphone jack."""
    middle = y + height / 2
    return (frame(1.8, y, 20.4, height, 2.6)
            + rect(5.6, middle - 0.7, 3.4, 1.4, 0.7) + rect(10.0, middle - 0.7, 3.4, 1.4, 0.7)
            + circle(16.4, middle, 1.0))


def app_icon():
    return (chain([(3.0, 6.6), (7.2, 6.6), (9.0, 2.6), (12.0, 10.4), (13.8, 6.6), (21.0, 6.6)], 1.9)
            + mac_mini(12.6))


def driver_icon():
    return mac_mini(7.6)


# --- writing ---------------------------------------------------------------

def svg(path, size=None):
    head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"'
    if size:
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}"'
                f' width="{size}" height="{size}"')
    return f'{head}>\n  <path d="{path}"/>\n</svg>\n'


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)
    print(f"  {path}")


def main():
    global SCALE
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    root = sys.argv[1]

    for name, draw in sorted(CAPABILITIES.items()):
        SCALE = 1.0
        write(os.path.join(root, "assets", "capabilities", f"{name}.svg"), svg(draw()))

    SCALE = 40.0
    write(os.path.join(root, "assets", "icon.svg"), svg(app_icon(), 960))
    write(os.path.join(root, "drivers", "mac", "assets", "icon.svg"), svg(driver_icon(), 960))


if __name__ == "__main__":
    main()
