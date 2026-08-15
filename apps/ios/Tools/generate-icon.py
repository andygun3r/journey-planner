#!/usr/bin/env python3
"""Render the Signaller app icon and launch mark.

Regenerate with:  python3 apps/ios/Tools/generate-icon.py <output-dir>
then copy the results into Signaller/Assets.xcassets/.

The mark is three block sections of a running line with the middle one
occupied — the signaller's core mental model. Geometry matches
SignalMark.swift and signal-mark.tsx exactly, so the icon can never drift from
the mark it is supposed to be:

  - three blocks, vertically centred, 34 units tall on a 100-unit grid
  - clear blocks 13 wide at x=15 and x=78; occupied block 26 wide at x=41
  - corner radius 4 units

The icon puts the mark on Rail Navy: iOS clips to a squircle and sits the icon
on wallpapers of every colour, so a white-ground icon would dissolve into a
light home screen. Navy also matches the app's own header band.

Note the mark is 100x34, but an icon is square. The mark is centred at 62% of
the icon's width, which keeps it clear of the squircle mask while staying large
enough that the three blocks separate cleanly at 40px — the smallest an iOS
icon is ever displayed.
"""
import math
import subprocess
import sys
from pathlib import Path

NAVY = (0x1C, 0x23, 0x40)
WHITE = (0xFF, 0xFF, 0xFF)
RED = (0xD6, 0x35, 0x2C)
SS = 4  # supersample factor for antialiasing

# x-centre, width, occupied — the mark's construction, on a 100-unit grid.
BLOCKS = ((15, 13, False), (41, 26, True), (78, 13, False))
BLOCK_HEIGHT = 34
CORNER_RADIUS = 4


def rounded_rect_contains(px, py, cx, cy, w, h, r):
    """Whether a point falls inside a rounded rectangle."""
    x0, x1 = cx - w / 2, cx + w / 2
    y0, y1 = cy - h / 2, cy + h / 2
    if not (x0 <= px <= x1 and y0 <= py <= y1):
        return False
    r = min(r, w / 2, h / 2)
    if r <= 0:
        return True
    qx = min(max(px, x0 + r), x1 - r)
    qy = min(max(py, y0 + r), y1 - r)
    return math.hypot(px - qx, py - qy) <= r


def render(size, mark_fraction=0.62):
    """Return raw RGB bytes for a size x size icon."""
    n = size * SS
    unit = (n * mark_fraction) / 100      # one grid unit, in pixels
    origin_x = (n - 100 * unit) / 2       # centre the 100-wide mark
    centre_y = n / 2

    px = bytearray()
    for y in range(n):
        py = y + 0.5
        for x in range(n):
            pxx = x + 0.5
            colour = NAVY
            for bx, bw, occupied in BLOCKS:
                if rounded_rect_contains(
                    pxx, py,
                    origin_x + bx * unit, centre_y,
                    bw * unit, BLOCK_HEIGHT * unit,
                    CORNER_RADIUS * unit,
                ):
                    colour = RED if occupied else WHITE
                    break
            px += bytes(colour)

    # Box-downsample the supersampled buffer.
    out = bytearray()
    for y in range(size):
        for x in range(size):
            r = g = b = 0
            for sy in range(SS):
                row = ((y * SS + sy) * n + x * SS) * 3
                for sx in range(SS):
                    i = row + sx * 3
                    r += px[i]; g += px[i + 1]; b += px[i + 2]
            k = SS * SS
            out += bytes((r // k, g // k, b // k))
    return bytes(out)


def write_png(path, size, rgb):
    """Write a PNG without PIL: build a PPM and convert with sips."""
    ppm = path.with_suffix(".ppm")
    ppm.write_bytes(f"P6\n{size} {size}\n255\n".encode() + rgb)
    subprocess.run(
        ["sips", "-s", "format", "png", str(ppm), "--out", str(path)],
        check=True, capture_output=True,
    )
    ppm.unlink()


if __name__ == "__main__":
    dest = Path(sys.argv[1])
    dest.mkdir(parents=True, exist_ok=True)

    # App icon: one 1024 slot, which Xcode downsamples for every use.
    write_png(dest / "icon-1024.png", 1024, render(1024))
    print("wrote icon-1024.png")

    # Launch mark: smaller within its frame, since the launch screen shows it
    # centred on a full navy field rather than clipped to an icon.
    for scale, size in ((1, 180), (2, 360), (3, 540)):
        write_png(dest / f"mark-{scale}x.png", size, render(size, mark_fraction=0.78))
        print(f"wrote mark-{scale}x.png")
