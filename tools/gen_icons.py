#!/usr/bin/env python3
"""Single source of truth for Questboard's icon set.

Generates:
  extension/icons/qb-<name>-symbolic.svg   (GNOME recolours fills to the text colour)
  android/app/src/main/res/drawable/qb_<name>.xml   (VectorDrawables, tinted in Compose)

All shapes are filled paths on a 16x16 grid (GNOME's symbolic recolouring only
touches fills, not strokes).
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def circle(cx, cy, r):
    return f"M{cx - r},{cy}a{r},{r} 0 1,0 {2 * r},0a{r},{r} 0 1,0 {-2 * r},0z"


def ring(cx, cy, r_out, r_in):
    return circle(cx, cy, r_out) + circle(cx, cy, r_in)


def rect(x, y, w, h, r=0):
    if not r:
        return f"M{x},{y}h{w}v{h}h{-w}z"
    return (f"M{x + r},{y}h{w - 2 * r}a{r},{r} 0 0 1 {r},{r}v{h - 2 * r}a{r},{r} 0 0 1 {-r},{r}"
            f"h{-(w - 2 * r)}a{r},{r} 0 0 1 {-r},{-r}v{-(h - 2 * r)}a{r},{r} 0 0 1 {r},{-r}z")


# name -> (path data, evenodd?)
ICONS = {
    "flame": ("M8,0.8C8.6,3.8 12.8,5.6 12.8,9.8A4.8,4.8 0 0 1 3.2,9.8C3.2,7.4 4.6,5.8 5.6,4.9"
              "C5.6,6.6 6.4,7.7 7.3,8C6.6,5.6 7.4,3 8,0.8z", False),
    "coin": (ring(8, 8, 7, 5.6) + ring(8, 8, 4.2, 2.6), True),
    "check": ("M6.4,11.6L2.9,8.1L1.7,9.3L6.4,14L14.3,6.1L13.1,4.9z", False),
    "stopwatch": (ring(8, 9.2, 6.3, 4.8) + rect(7.25, 5.6, 1.5, 4.4, 0.75) + rect(6, 0.6, 4, 1.7, 0.8)
                  + "M12.6,2.9l1.4,1.4l-1.1,1.1l-1.4,-1.4z", True),
    "target": (ring(8, 8, 7, 5.5) + ring(8, 8, 4, 2.6) + circle(8, 8, 1.2), True),
    "coffee": ("M1.8,6.2h9.4v3.6a4.2,4.2 0 0 1 -4.2,4.2h-1a4.2,4.2 0 0 1 -4.2,-4.2z"
               "M11.2,7h1.4a2.2,2.2 0 0 1 0,4.4h-1.5v-1.4h1.5a0.8,0.8 0 0 0 0,-1.6h-1.4z"
               + rect(4.4, 1.2, 1.3, 3.6, 0.65) + rect(7.3, 1.2, 1.3, 3.6, 0.65), False),
    "gift": (rect(1.2, 4.6, 5.9, 2.6, 0.5) + rect(8.9, 4.6, 5.9, 2.6, 0.5) + rect(2.2, 8, 4.9, 6.4, 0.6)
             + rect(8.9, 8, 4.9, 6.4, 0.6) + ring(5.6, 2.8, 1.8, 0.8) + ring(10.4, 2.8, 1.8, 0.8), True),
    "trophy": ("M4,1h8v4.2a4,4 0 0 1 -8,0z" + rect(7.1, 9, 1.8, 3, 0) + rect(4.4, 12.4, 7.2, 2.4, 1)
               + "M1.6,2h2.2v4H3A1.4,1.4 0 0 1 1.6,4.6zM14.4,2h-2.2v4H13a1.4,1.4 0 0 0 1.4,-1.4z", False),
    "star": ("M8,0.9L10.1,5.3L14.9,5.9L11.4,9.2L12.3,14L8,11.7L3.7,14L4.6,9.2L1.1,5.9L5.9,5.3z", False),
    "heart": ("M8,14.4L2.4,8.9A3.6,3.6 0 0 1 8,4.1A3.6,3.6 0 0 1 13.6,8.9z", False),
    "book": ("M0.8,2.8C3.3,1.8 5.8,1.9 7.3,3.3V14C5.8,12.9 3.3,12.8 0.8,13.6z"
             "M15.2,2.8C12.7,1.8 10.2,1.9 8.7,3.3V14C10.2,12.9 12.7,12.8 15.2,13.6z", False),
    "dumbbell": (rect(4, 7.2, 8, 1.6) + rect(2.2, 3.8, 2.2, 8.4, 0.6) + rect(11.6, 3.8, 2.2, 8.4, 0.6)
                 + rect(0.4, 5.8, 1.6, 4.4, 0.5) + rect(14, 5.8, 1.6, 4.4, 0.5), False),
    "drop": ("M8,1.2C8,1.2 2.8,7.1 2.8,10.2A5.2,5.2 0 0 0 13.2,10.2C13.2,7.1 8,1.2 8,1.2z", False),
    "moon": ("M10.2,1.2A6.8,6.8 0 1 0 14.8,11.2A5.6,5.6 0 0 1 10.2,1.2z", False),
    "music": (circle(4.6, 12, 2.6) + rect(6, 1.8, 1.6, 10.2) + "M6,1.8L13.6,0.4V3.6L7.6,4.8z", False),
    "game": ("M4.6,3.6h6.8a3.6,3.6 0 0 1 3.5,4.4l-0.7,3.3a1.9,1.9 0 0 1 -3.1,1L9.6,11H6.4l-1.5,1.3"
             "a1.9,1.9 0 0 1 -3.1,-1L1.1,8A3.6,3.6 0 0 1 4.6,3.6z"
             "M4.1,5.9v1.2H2.9v1.4h1.2v1.2h1.4V8.5h1.2V7.1H5.5V5.9z" + circle(11, 6.6, 0.85) + circle(12.4, 8.6, 0.85), True),
    "film": (rect(1, 2, 14, 12, 1) + rect(4.4, 4, 7.2, 8) + rect(2, 3.4, 1.4, 1.6) + rect(2, 7.2, 1.4, 1.6)
             + rect(2, 11, 1.4, 1.6) + rect(12.6, 3.4, 1.4, 1.6) + rect(12.6, 7.2, 1.4, 1.6) + rect(12.6, 11, 1.4, 1.6), True),
    "pizza": ("M1.4,3.4C5.6,1.2 10.4,1.2 14.6,3.4L8,15.2z" + circle(6.4, 5.6, 1.1) + circle(9.8, 7, 1)
              + circle(7.8, 9.8, 0.9), True),
    "leaf": ("M14.4,1.6C6.4,1.6 1.8,5.4 1.8,10.8c0,1.1 0.2,2.1 0.6,3l1.2,-1.1C4.2,9.2 6.8,6.8 10,5.2"
             "C7.4,7.2 5.4,9.6 4.4,12.6C11,13.2 14.4,9.2 14.4,1.6z", False),
    "bolt": ("M9.4,0.8L2.8,9.2H7.2L6.4,15.2L13.2,6.6H8.8z", False),
    "sparkle": ("M7,1C7.6,4.6 8.6,5.6 12.2,6.2C8.6,6.8 7.6,7.8 7,11.4C6.4,7.8 5.4,6.8 1.8,6.2C5.4,5.6 6.4,4.6 7,1z"
                "M12.4,9.6C12.7,11.3 13.2,11.8 14.9,12.1C13.2,12.4 12.7,12.9 12.4,14.6C12.1,12.9 11.6,12.4 9.9,12.1"
                "C11.6,11.8 12.1,11.3 12.4,9.6z", False),
    "shield": ("M8,0.8L2,3.3v4.2C2,11.1 4.6,14.1 8,15.2c3.4,-1.1 6,-4.1 6,-7.7V3.3z", False),
    "repeat": (ring(8, 8.6, 6, 4.4) + "M7.2,0.6L11.6,2.8L7.2,5z", True),
    "grid": (rect(1, 1, 6.2, 6.2, 1.2) + rect(8.8, 1, 6.2, 6.2, 1.2) + rect(1, 8.8, 6.2, 6.2, 1.2)
             + rect(8.8, 8.8, 6.2, 6.2, 1.2), False),
    "list": (rect(1, 2, 2.4, 2.4, 1.2) + rect(5, 2.4, 10, 1.6, 0.8) + rect(1, 6.8, 2.4, 2.4, 1.2)
             + rect(5, 7.2, 10, 1.6, 0.8) + rect(1, 11.6, 2.4, 2.4, 1.2) + rect(5, 12, 10, 1.6, 0.8), False),
    "shop": ("M2.2,5.2h11.6l-1,8.6a1.4,1.4 0 0 1 -1.4,1.2H4.6a1.4,1.4 0 0 1 -1.4,-1.2z"
             "M5,5.2V4.4a3,3 0 0 1 6,0v0.8h-1.5V4.4a1.5,1.5 0 0 0 -3,0v0.8z", False),
    "cloud": ("M4.4,13.4A3.4,3.4 0 0 1 3.8,6.6A4.6,4.6 0 0 1 12.4,6A3.7,3.7 0 0 1 12,13.4z", False),
    "cloud-off": ("M4.4,13.4A3.4,3.4 0 0 1 3.8,6.6A4.6,4.6 0 0 1 12.4,6A3.7,3.7 0 0 1 12,13.4z"
                  "M2.2,1.4L14.6,13.8L13.6,14.8L1.2,2.4z", True),
    "bug": ("M5,5.4h6a1,1 0 0 1 1,1v3.6a4,4 0 0 1 -8,0V6.4a1,1 0 0 1 1,-1z" + circle(8, 3.6, 2.2)
            + rect(0.8, 7, 2.6, 1.3, 0.6) + rect(12.6, 7, 2.6, 1.3, 0.6)
            + rect(1.2, 11, 2.6, 1.3, 0.6) + rect(12.2, 11, 2.6, 1.3, 0.6), False),
    "undo": ("M5.4,2.2L1,6.2L5.4,10.2V7.4H9.2a2.8,2.8 0 0 1 0,5.6H6.6v1.8h2.6a4.6,4.6 0 0 0 0,-9.2H5.4z", False),
    "plus": (rect(7.1, 1.8, 1.8, 12.4, 0.9) + rect(1.8, 7.1, 12.4, 1.8, 0.9), False),
    "play": ("M4.5,2.2L13.5,8L4.5,13.8z", False),
    "pause": (rect(3.6, 2.4, 3, 11.2, 0.8) + rect(9.4, 2.4, 3, 11.2, 0.8), False),
    "inbox": ("M1,9.4L3.2,2.6h9.6L15,9.4V13a1.4,1.4 0 0 1 -1.4,1.4H2.4A1.4,1.4 0 0 1 1,13z"
              "M2.9,9.2h3.4a1.7,1.7 0 0 0 3.4,0h3.4L11.6,4.2H4.4z", True),
}

# Icons a user can pick for habits and rewards (order = picker order).
PICKABLE = ["star", "heart", "book", "dumbbell", "drop", "moon", "music", "game", "film", "pizza",
            "leaf", "bolt", "coffee", "gift", "target", "trophy", "sparkle", "flame", "shield", "repeat"]


def main():
    ext_dir = os.path.join(ROOT, "extension", "icons")
    and_dir = os.path.join(ROOT, "android", "app", "src", "main", "res", "drawable")
    os.makedirs(ext_dir, exist_ok=True)
    os.makedirs(and_dir, exist_ok=True)
    for name, (d, evenodd) in ICONS.items():
        rule = ' fill-rule="evenodd"' if evenodd else ""
        with open(os.path.join(ext_dir, f"qb-{name}-symbolic.svg"), "w") as f:
            f.write(f'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">'
                    f'<path fill="#2e3436"{rule} d="{d}"/></svg>\n')
        ft = ' android:fillType="evenOdd"' if evenodd else ""
        with open(os.path.join(and_dir, f"qb_{name.replace('-', '_')}.xml"), "w") as f:
            f.write('<?xml version="1.0" encoding="utf-8"?>\n'
                    '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
                    '    android:width="24dp" android:height="24dp" android:viewportWidth="16" android:viewportHeight="16">\n'
                    f'  <path android:fillColor="#FFFFFFFF"{ft} android:pathData="{d}"/>\n</vector>\n')
    kt = os.path.join(ROOT, "android", "app", "src", "main", "java", "com", "questboard", "app", "ui", "QbIcons.kt")
    os.makedirs(os.path.dirname(kt), exist_ok=True)
    with open(kt, "w") as f:
        f.write("// Generated by tools/gen_icons.py — do not edit.\npackage com.questboard.app.ui\n\nimport com.questboard.app.R\n\n")
        f.write("val QB_ICONS: Map<String, Int> = mapOf(\n")
        for name in ICONS:
            f.write(f'    "{name}" to R.drawable.qb_{name.replace("-", "_")},\n')
        f.write(")\n")
    print(f"generated {len(ICONS)} icons")


if __name__ == "__main__":
    main()
