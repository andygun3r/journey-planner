#!/usr/bin/env python3
"""Render the Signaller app icon from the brand's own construction.

Regenerate with:  python3 apps/ios/Tools/generate-icon.py <output-dir>
then copy icon-1024.png into Signaller/Assets.xcassets/AppIcon.appiconset/.

Same geometry as SignalMark.swift and signal-mark.tsx: arm width 130% of disc
diameter, arm thickness 13%, rim 5%. Generated rather than hand-drawn so the
icon cannot drift from the mark it is supposed to be.

Two decisions worth knowing before editing:

1. **Navy ground.** iOS clips the icon to a squircle and sits it on wallpapers
   of every colour, so a white-ground icon dissolves into a light home screen.
   Navy also matches the app's own header band.

2. **The inverted lockup** (white rim and arm, navy disc interior). The brand's
   default is a navy arm on a white disc, which works on the website because
   the arm only ever crosses white. On a navy ground a navy arm merges with
   that ground and the mark collapses into a prohibition slash. The overhang
   matters for the same reason: clipping the arm at the disc edge produces an
   unmistakable "no entry" sign, and the bar continuing past the disc is what
   makes it read as a signal arm at clear.
"""
import math
import subprocess
import sys
from pathlib import Path

NAVY = (0x1C, 0x23, 0x40)
WHITE = (0xFF, 0xFF, 0xFF)
SS = 4  # supersample factor for antialiasing


def render(size: int) -> bytes:
    """Return raw RGB bytes for a size x size icon."""
    n = size * SS
    px = bytearray()

    # Mark occupies 62% of the icon width — enough clear space that the
    # squircle mask never crops the arm's overhang.
    # Disc sized so the arm's full 130% span (which reaches 0.65 * disc_d from
    # centre, on the diagonal) still clears the squircle mask. At 0.62 the
    # overhang crowded the icon's corners and the arm read as a wedge cutting a
    # circle rather than a bar passing behind it.
    disc_d = n * 0.50
    cx = cy = n / 2
    r_outer = disc_d / 2
    rim = disc_d * 0.05
    r_inner = r_outer - rim
    arm_half_len = disc_d * 0.65      # 130% of diameter, halved
    arm_half_thick = disc_d * 0.065   # 13% of diameter, halved

    # The arm rises to the upper right: the banner repeater's "off"/clear
    # position. Screen y grows downward, so clear is -45deg in maths terms.
    # Getting this backwards draws a prohibition slash — an icon that reads
    # "no entry" is the opposite of what a signal at clear means.
    theta = math.radians(-45)
    cos_t, sin_t = math.cos(theta), math.sin(theta)

    for y in range(n):
        dy = y + 0.5 - cy
        for x in range(n):
            dx = x + 0.5 - cx
            dist = math.hypot(dx, dy)

            # Rotate the point into the arm's own frame.
            ax = dx * cos_t + dy * sin_t
            ay = -dx * sin_t + dy * cos_t
            on_arm = abs(ax) <= arm_half_len and abs(ay) <= arm_half_thick

            # The inverted lockup: white mark on a navy ground.
            #
            # The handoff's default is a navy arm on a white disc, which works
            # on the website because the arm only ever crosses white. On a navy
            # icon ground a navy arm reads as one continuous bar joining the
            # ground through the disc — a prohibition slash, the exact opposite
            # of a signal at clear. The brand ships an inverted lockup for dark
            # grounds for this reason, so the icon uses it: white rim, white
            # arm, navy disc interior. The arm now contrasts everywhere it
            # travels and reads as a signal arm passing across the disc.
            if dist <= r_inner:
                colour = WHITE if on_arm else NAVY   # white arm on navy disc
            elif dist <= r_outer:
                colour = WHITE                       # white rim
            elif on_arm:
                colour = WHITE                       # overhang, on navy ground
            else:
                colour = NAVY                        # ground
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
                    r += px[i]
                    g += px[i + 1]
                    b += px[i + 2]
            k = SS * SS
            out += bytes((r // k, g // k, b // k))
    return bytes(out)


def write_png(path: Path, size: int, rgb: bytes) -> None:
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
    # 1024 for the App Store / asset catalog single-size slot.
    for size in (1024,):
        write_png(dest / f"icon-{size}.png", size, render(size))
        print(f"wrote icon-{size}.png")
