import math
from PIL import Image, ImageDraw

SIZE = 1024
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded-square background with gradient purple -> cyan
def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

purple = (124, 92, 255)   # 7c5cff
cyan   = (0, 202, 255)    # 00d2ff

# rounded rect mask
pad = SIZE * 0.06
radius = SIZE * 0.22
mask = Image.new("L", (SIZE, SIZE), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([pad, pad, SIZE - pad, SIZE - pad], radius=radius, fill=255)

# gradient background
bg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
bd = ImageDraw.Draw(bg)
steps = 256
for i in range(steps):
    t = i / (steps - 1)
    color = lerp(purple, cyan, t) + (255,)
    bd.rectangle([0, i * SIZE // steps, SIZE, (i + 1) * SIZE // steps], fill=color)
bg.putalpha(mask)
img.alpha_composite(bg)

# Draw a game controller silhouette (white)
# Center and proportions relative to size
cx = SIZE * 0.5
cy = SIZE * 0.52
W = SIZE * 0.62
H = SIZE * 0.34
left = cx - W / 2
top = cy - H / 2
right = cx + W / 2
bottom = cy + H / 2

# main body (rounded rectangle with flared grips) - approximate with rounded rect
body = [left, top, right, bottom]
draw.rounded_rectangle(body, radius=H * 0.42, fill=(255, 255, 255, 255))

# d-pad cross (left) in dark
dpx = left + W * 0.20
dpy = cy + (H * 0.02)
ds = W * 0.035   # arm width
draw.rounded_rectangle([dpx - ds, dpy - ds * 2.6, dpx + ds, dpy + ds * 2.6], radius=ds*0.3, fill=(30,25,60,255))  # vertical
draw.rounded_rectangle([dpx - ds * 2.6, dpy - ds, dpx + ds * 2.6, dpy + ds], radius=ds*0.3, fill=(30,25,60,255))  # horizontal

# face buttons (right) dark circles
bx = right - W * 0.18
by = cy + (H * 0.02)
br = W * 0.028
offs = W * 0.075
for ox, oy in [(0, -offs), (offs, 0), (0, offs), (-offs, 0)]:
    draw.ellipse([bx + ox - br, by + oy - br, bx + ox + br, by + oy + br], fill=(30, 25, 60, 255))

# panel line resolution
img = img.resize((1024, 1024), Image.LANCZOS)

# save multi-size ico
sizes = [(256,256),(128,128),(64,64),(48,48),(32,32),(24,24),(16,16)]
imgs_png = []
for s in sizes:
    imgs_png.append(img.resize(s, Image.LANCZOS))

import os
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.ico")
imgs_png[0].save(out, format="ICO", sizes=[(256,256),(128,128),(64,64),(48,48),(32,32),(24,24),(16,16)],
                 append_images=[])
print("icon.ico creado:", out)
