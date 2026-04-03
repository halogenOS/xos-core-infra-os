#!/usr/bin/env python3
"""
Generate halogenOS logo PNGs for Zitadel branding.

Produces:
  logo-dark.png  — for dark backgrounds (black bg)
  logo-light.png — for light backgrounds (transparent bg + drop shadow)
  icon.png       — square icon variant (dark, tighter crop)

Based on the halogenOS boot animation geometry.
"""

import os
import math
from PIL import Image, ImageDraw, ImageFilter

# Output
SIZE = int(os.getenv("LOGO_SIZE", "512"))
SUPERSAMPLE = 4
RENDER_SIZE = SIZE * SUPERSAMPLE

# Brand colors
BLUE_START = (0, 180, 231)    # #00B4E7
BLUE_END = (0, 120, 180)
WHITE_START = (200, 230, 255)
WHITE_END = (150, 200, 230)
BACKGROUND_DARK = (0, 0, 0)

# Triangle geometry (at render resolution)
TRIANGLE_SIZE = 275 * SUPERSAMPLE
OVERLAP_FRACTION = 0.10
CORNER_RADIUS = 30 * (TRIANGLE_SIZE / 350)

# Static frame from breathing animation (minimum scale, t=0.75)
FRAMES_LOOP = 180
T_STATIC = 135 / FRAMES_LOOP
SCALE_FACTOR = 1.03 + 0.03 * math.sin(T_STATIC * 2 * math.pi)


def interpolate_color(color1, color2, t):
    return tuple(int(c1 + (c2 - c1) * t) for c1, c2 in zip(color1, color2))


def create_rounded_triangle_mask(size, points, radius):
    mask = Image.new('L', size, 0)
    temp = Image.new('L', size, 0)
    draw = ImageDraw.Draw(temp)
    draw.polygon(points, fill=255)
    temp = temp.filter(ImageFilter.GaussianBlur(radius=radius))
    return Image.eval(temp, lambda x: 255 if x > 128 else 0)


def draw_triangle_with_gradient(img, points, color_start, color_end, opacity=255):
    mask = create_rounded_triangle_mask(
        (RENDER_SIZE, RENDER_SIZE), points, CORNER_RADIUS
    )
    gradient = Image.new('RGBA', (RENDER_SIZE, RENDER_SIZE))
    draw = ImageDraw.Draw(gradient)

    x_coords = [p[0] for p in points]
    y_coords = [p[1] for p in points]
    x_min, x_max = min(x_coords), max(x_coords)
    y_min, y_max = min(y_coords), max(y_coords)

    for y in range(int(y_min), int(y_max) + 1):
        for x in range(int(x_min), int(x_max) + 1):
            if x_max > x_min and y_max > y_min:
                t = ((x - x_min) / (x_max - x_min) + (y - y_min) / (y_max - y_min)) / 2
            else:
                t = 0
            color = interpolate_color(color_start, color_end, t)
            draw.point((x, y), fill=(*color, opacity))

    gradient.putalpha(mask)
    img.alpha_composite(gradient)


def scale_points(points, scale, center):
    cx, cy = center
    return [(cx + (x - cx) * scale, cy + (y - cy) * scale) for x, y in points]


def compute_triangles():
    cx, cy = RENDER_SIZE // 2, RENDER_SIZE // 2
    overlap = TRIANGLE_SIZE * OVERLAP_FRACTION

    blue_cx = cx + overlap // 2
    blue_points = [
        (blue_cx - TRIANGLE_SIZE, cy),
        (blue_cx + TRIANGLE_SIZE // 2, cy - TRIANGLE_SIZE * 0.8),
        (blue_cx + TRIANGLE_SIZE // 2, cy + TRIANGLE_SIZE * 0.8),
    ]

    white_cx = cx - overlap // 2
    white_points = [
        (white_cx + TRIANGLE_SIZE, cy),
        (white_cx - TRIANGLE_SIZE // 2, cy - TRIANGLE_SIZE * 0.8),
        (white_cx - TRIANGLE_SIZE // 2, cy + TRIANGLE_SIZE * 0.8),
    ]

    center = (cx, cy)
    return (
        scale_points(blue_points, SCALE_FACTOR, center),
        scale_points(white_points, SCALE_FACTOR, center),
    )


def render_logo():
    img = Image.new('RGBA', (RENDER_SIZE, RENDER_SIZE), (0, 0, 0, 0))
    blue_pts, white_pts = compute_triangles()
    draw_triangle_with_gradient(img, blue_pts, BLUE_START, BLUE_END, 255)
    draw_triangle_with_gradient(img, white_pts, WHITE_START, WHITE_END, 140)
    return img


def add_drop_shadow(img, radius=30, offset=(0, 8), opacity=0.4):
    """Add a drop shadow behind the logo content."""
    shadow_size = (RENDER_SIZE, RENDER_SIZE)
    shadow = Image.new('RGBA', shadow_size, (0, 0, 0, 0))

    # Create shadow from alpha channel
    _, _, _, alpha = img.split()
    shadow_layer = Image.new('RGBA', shadow_size, (0, 0, 0, int(255 * opacity)))
    shadow_layer.putalpha(alpha)

    # Offset
    ox, oy = int(offset[0] * SUPERSAMPLE), int(offset[1] * SUPERSAMPLE)
    offset_shadow = Image.new('RGBA', shadow_size, (0, 0, 0, 0))
    offset_shadow.paste(shadow_layer, (ox, oy))

    # Blur
    blurred = offset_shadow.filter(
        ImageFilter.GaussianBlur(radius=radius * SUPERSAMPLE)
    )

    # Composite: shadow behind logo
    result = Image.new('RGBA', shadow_size, (0, 0, 0, 0))
    result = Image.alpha_composite(result, blurred)
    result = Image.alpha_composite(result, img)
    return result


def finalize(img, background=None):
    if background:
        bg = Image.new('RGBA', (RENDER_SIZE, RENDER_SIZE), (*background, 255))
        img = Image.alpha_composite(bg, img)
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    out_dir = os.getenv("out", ".")

    logo = render_logo()

    # Dark: transparent background, no shadow needed
    dark = finalize(logo)
    dark.save(os.path.join(out_dir, "logo-dark.png"), "PNG")

    # Light: transparent background with drop shadow for contrast
    light = add_drop_shadow(logo)
    light = finalize(light)
    light.save(os.path.join(out_dir, "logo-light.png"), "PNG")

    # Icon: same as dark (works as favicon on both)
    dark.save(os.path.join(out_dir, "icon.png"), "PNG")

    print(f"Generated {SIZE}x{SIZE} logos in {out_dir}")


if __name__ == "__main__":
    main()
