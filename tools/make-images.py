#!/usr/bin/env python3
"""Makes the Homey app image and the driver image from photos.

Sizes required by Homey:
  app image     250x175 / 500x350 / 1000x700 (lifestyle photo)
  driver image   75x75  / 500x500 / 1000x1000 (photo of the device on white)

Usage:
  python3 tools/make-images.py <app-dir> app-photo <photo>
  python3 tools/make-images.py <app-dir> driver-photo <photo-on-white>

For the driver image, first cut the Mac out of a photo:
  swift tools/cutout.swift <photo> driver.png

The icons are drawn by tools/make-icons.py.

Requires: pip install pillow
"""
import os
import sys

from PIL import Image


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


def main():
    builders = {"app-photo": (app_image, ("assets", "images")),
                "driver-photo": (driver_image, ("drivers", "mac", "assets", "images"))}
    if len(sys.argv) < 4 or sys.argv[2] not in builders:
        print(__doc__)
        sys.exit(1)

    root, part, photo = sys.argv[1], sys.argv[2], sys.argv[3]
    build, folder = builders[part]
    directory = os.path.join(root, *folder)
    os.makedirs(directory, exist_ok=True)

    img, sizes = build(photo)
    for name, size in sizes.items():
        out = os.path.join(directory, f"{name}.png")
        img.resize(size, Image.LANCZOS).save(out, "PNG", optimize=True)
        print(f"  {out}  {size[0]}x{size[1]}")


if __name__ == "__main__":
    main()
