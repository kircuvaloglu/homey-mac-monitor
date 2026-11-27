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


def ellipse(cx, cy, rx, ry, angle, cw=True):
    """Ellipse with its long axis along the given angle."""
    a = math.radians(angle)
    dx, dy = rx * math.cos(a), -rx * math.sin(a)
    arc = f"A{f(rx)},{f(ry)} {n(-angle)} 0 {1 if cw else 0}"
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


def gpu():
    """Graphics card: the board with its fan, cooling fins and connector."""
    return (frame(1.6, 5.0, 20.8, 12.6, 2.2) + ring(8.6, 11.3, 3.7, 1.7) + circle(8.6, 11.3, 1.1)
            + rect(14.4, 8.2, 1.7, 6.2, 0.6) + rect(17.4, 8.2, 1.7, 6.2, 0.6)
            + rect(5.6, 17.2, 9.0, 2.6, 0.5))


def internet():
    """Globe: outline, a meridian and the equator."""
    return (ring(12, 12, 9.2, 1.9) + ellipse(12, 12, 9.2, 4.4, 90)
            + ellipse(12, 12, 9.2 - 1.8, 4.4 - 1.8, 90, cw=False)
            + line((3.4, 12), (20.6, 12), 1.8, caps=False))


def latency():
    """Stopwatch."""
    return (ring(12, 13.6, 8.0, 1.9) + line((12, 13.6), (12, 9.4), 1.8) + circle(12, 13.6, 1.2)
            + rect(9.8, 2.0, 4.4, 2.2, 0.7) + rect(11.1, 3.8, 1.8, 2.2)
            + line(at(12, 13.6, 8.6, 45), at(12, 13.6, 10.2, 45), 1.9))


CAPABILITIES = {
    "backup": backup, "clock": clock, "cpu": cpu, "disk": disk, "display": display,
    "drive": drive, "fan": fan, "health": health, "lock": lock, "memory": memory,
    "network": network, "pressure": pressure, "thermometer": thermometer,
    "update": update, "user": user, "gpu": gpu, "internet": internet, "latency": latency,
}


# --- app and driver icon ---------------------------------------------------
#
# Homey wants device icons as line drawings seen from an angle, preferably from
# the right, so the Mac mini is modelled in 3D and projected. Its outlines are
# filled bands of an even width, like the capability icons.

MINI_HEIGHT = 0.394     # 5.0 cm tall on a 12.7 cm square footprint
MINI_RADIUS = 0.17      # corner radius, relative to the width
YAW, PITCH = 30, 33     # turned to show the right side, seen from slightly above
LINE = 34               # line width on the 960 x 960 canvas


def project(x, y, z):
    """Device coordinates (x to the right, y to the back, z up) to the drawing plane."""
    a, b = math.radians(YAW), math.radians(PITCH)
    across = x * math.cos(a) + y * math.sin(a)
    depth = -x * math.sin(a) + y * math.cos(a)
    return across, -(z * math.cos(b) + depth * math.sin(b))


def rounded_square(r, steps=12):
    """Outline of the unit square with rounded corners."""
    pts = []
    for cx, cy, a0 in [(1 - r, r, -90), (1 - r, 1 - r, 0), (r, 1 - r, 90), (r, r, 180)]:
        for k in range(steps + 1):
            a = math.radians(a0 + 90 * k / steps)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def hull(points):
    """Convex hull, used for the outline of the whole device."""
    pts = sorted(set((round(x, 5), round(y, 5)) for x, y in points))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for q in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], q) <= 0:
            lower.pop()
        lower.append(q)
    for q in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], q) <= 0:
            upper.pop()
        upper.append(q)
    return lower[:-1] + upper[:-1]


def band(points, t):
    """Closed convex outline drawn as a line of width t."""
    pts = list(points) if clockwise(list(points)) else list(points)[::-1]
    outer, inner = [], []
    for i, q in enumerate(pts):
        normals = []
        for a, b in ((pts[i - 1], q), (q, pts[(i + 1) % len(pts)])):
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy) or 1
            normals.append((dy / length, -dx / length))
        mx, my = normals[0][0] + normals[1][0], normals[0][1] + normals[1][1]
        length = math.hypot(mx, my) or 1
        mx, my = mx / length, my / length
        d = (t / 2) / max(mx * normals[0][0] + my * normals[0][1], 0.3)
        outer.append((q[0] + mx * d, q[1] + my * d))
        inner.append((q[0] - mx * d, q[1] - my * d))
    return poly(outer) + poly(inner, cw=False)


def mac_mini(box):
    """The Mac mini fitted into box (x0, y0, x1, y1) on the 960 canvas."""
    loop = rounded_square(MINI_RADIUS)
    top = [project(x, y, MINI_HEIGHT) for x, y in loop]
    outline = hull(top + [project(x, y, 0) for x, y in loop])

    def front(xc, zc, half, r):
        """Upright rounded slot on the front face; with half = 0 a round opening."""
        upper = [(xc + r * math.cos(math.radians(a)), zc + half + r * math.sin(math.radians(a)))
                 for a in range(0, 181, 15)]
        lower = [(xc + r * math.cos(math.radians(a)), zc - half + r * math.sin(math.radians(a)))
                 for a in range(180, 361, 15)]
        return [project(x, 0, z) for x, z in upper + lower]

    # Front of the M4 Mac mini: two upright USB-C ports on the left, the
    # headphone jack on the right.
    z = MINI_HEIGHT * 0.5
    openings = [front(0.23, z, 0.036, 0.028), front(0.325, z, 0.036, 0.028), front(0.78, z, 0, 0.034)]

    # The rounded corner between the front and the right side, drawn as an edge.
    a = math.radians(-45)
    cx, cy = 1 - MINI_RADIUS + MINI_RADIUS * math.cos(a), MINI_RADIUS + MINI_RADIUS * math.sin(a)
    edge = (project(cx, cy, 0), project(cx, cy, MINI_HEIGHT))

    xs, ys = [q[0] for q in outline], [q[1] for q in outline]
    scale = min((box[2] - box[0]) / (max(xs) - min(xs)), (box[3] - box[1]) / (max(ys) - min(ys)))
    ox = (box[0] + box[2]) / 2 - scale * (min(xs) + max(xs)) / 2
    oy = (box[1] + box[3]) / 2 - scale * (min(ys) + max(ys)) / 2
    fit = lambda pts: [(ox + scale * x, oy + scale * y) for x, y in pts]
    edge = fit(edge)
    return (band(fit(outline), LINE) + band(fit(top), LINE) + line(edge[0], edge[1], LINE, caps=False)
            + "".join(poly(fit(o)) for o in openings))


def app_icon():
    """The Mac mini with a pulse line above it, so it differs from the driver icon."""
    pulse = [(80, 205), (330, 205), (395, 85), (475, 330), (545, 160), (595, 205), (880, 205)]
    return chain(pulse, LINE) + mac_mini((110, 390, 850, 905))


def driver_icon():
    return mac_mini((40, 150, 920, 810))


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

    SCALE = 1.0  # the app and driver icon are drawn in pixels of the 960 canvas
    write(os.path.join(root, "assets", "icon.svg"), svg(app_icon(), 960))
    write(os.path.join(root, "drivers", "mac", "assets", "icon.svg"), svg(driver_icon(), 960))


if __name__ == "__main__":
    main()
