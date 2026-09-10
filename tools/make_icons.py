#!/usr/bin/env python3
"""Render docs/icon.svg's design to PNGs without any image library.

The machine has no Pillow / rsvg / headless-screenshot pipeline available, so
the shape is re-drawn here from the same geometry using signed distance fields
and analytic anti-aliasing, then encoded as PNG with zlib.  Keep this in step
with docs/icon.svg -- both are the same 512-unit design.

Usage:  python tools/make_icons.py [outdir]
"""
from __future__ import annotations

import math
import os
import struct
import sys
import zlib

DESIGN = 512.0                      # the design grid, matching icon.svg

BG_TOP = (0x14, 0x91, 0x8A)
BG_BOTTOM = (0x0B, 0x5C, 0x56)
WHITE = (0xFF, 0xFF, 0xFF)
WAVE = (0x9D, 0xF0, 0xE8)

BARS = [                            # x, y, w, h, radius
    (104, 140, 200, 26, 13),
    (104, 196, 266, 26, 13),
    (104, 252, 304, 26, 13),
]
TRI = ((196.0, 322.0), (308.0, 322.0), (196.0, 454.0))
WAVES = [
    (344, 336, 20, 104, 10),
    (392, 306, 20, 164, 10),
]
CORNER = 112.0


def sd_round_box(px, py, x, y, w, h, r):
    dx = abs(px - (x + w / 2)) - w / 2 + r
    dy = abs(py - (y + h / 2)) - h / 2 + r
    ax, ay = max(dx, 0.0), max(dy, 0.0)
    return math.hypot(ax, ay) + min(max(dx, dy), 0.0) - r


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1]


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def sd_triangle(p, a, b, c):
    """Signed distance to a triangle (negative inside), iq's formulation."""
    e0, e1, e2 = _sub(b, a), _sub(c, b), _sub(a, c)
    v0, v1, v2 = _sub(p, a), _sub(p, b), _sub(p, c)

    def seg(v, e):
        t = max(0.0, min(1.0, _dot(v, e) / _dot(e, e)))
        return (v[0] - e[0] * t, v[1] - e[1] * t)

    p0, p1, p2 = seg(v0, e0), seg(v1, e1), seg(v2, e2)
    s = 1.0 if (e0[0] * e2[1] - e0[1] * e2[0]) > 0 else -1.0
    d = min(
        (_dot(p0, p0), s * (v0[0] * e0[1] - v0[1] * e0[0])),
        (_dot(p1, p1), s * (v1[0] * e1[1] - v1[1] * e1[0])),
        (_dot(p2, p2), s * (v2[0] * e2[1] - v2[1] * e2[0])),
    )
    return -math.sqrt(d[0]) * (1.0 if d[1] > 0 else -1.0)


def coverage(d):
    """Analytic 1px anti-aliasing from a signed distance in pixels."""
    return max(0.0, min(1.0, 0.5 - d))


def blend(dst, src, a):
    if a <= 0:
        return dst
    if a >= 1:
        return src
    return tuple(dst[i] + (src[i] - dst[i]) * a for i in range(3))


def render(size):
    scale = size / DESIGN
    buf = bytearray(size * size * 4)
    for y in range(size):
        dy = (y + 0.5) / scale
        ty = dy / DESIGN
        bg = tuple(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * ty for i in range(3))
        for x in range(size):
            dx = (x + 0.5) / scale
            # outside the rounded corner -> transparent
            a_bg = coverage(sd_round_box(dx, dy, 0, 0, DESIGN, DESIGN, CORNER) * scale)
            col = bg
            for (bx, by, bw, bh, br) in BARS:
                a = coverage(sd_round_box(dx, dy, bx, by, bw, bh, br) * scale)
                col = blend(col, WHITE, a)
            a = coverage(sd_triangle((dx, dy), *TRI) * scale)
            col = blend(col, WHITE, a)
            for (bx, by, bw, bh, br) in WAVES:
                a = coverage(sd_round_box(dx, dy, bx, by, bw, bh, br) * scale)
                col = blend(col, WAVE, a)
            o = (y * size + x) * 4
            buf[o] = int(col[0] + 0.5)
            buf[o + 1] = int(col[1] + 0.5)
            buf[o + 2] = int(col[2] + 0.5)
            buf[o + 3] = int(a_bg * 255 + 0.5)
    return bytes(buf)


def write_png(path, size, rgba):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)                       # filter byte: none
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs")
    os.makedirs(outdir, exist_ok=True)
    for size in (192, 512):
        data = render(size)
        path = os.path.join(outdir, f"icon-{size}.png")
        n = write_png(path, size, data)
        print(f"wrote {path} ({size}x{size}, {n/1024:.1f} KB)")


if __name__ == "__main__":
    main()
