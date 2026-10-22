#!/usr/bin/env python3
"""Makes media/icon.png, the extension's icon in the Marketplace, Open VSX and the editor.

The Raycast lane's icon recipe (2026-10-21-raycast-design.md, "Icon recipe"),
at 256 x 256: Wisply's app icon (RGB, full-bleed), with rounded corners and a
transparent margin, so it reads on light and dark backgrounds. vsce needs a
PNG of at least 128 x 128; test/manifest.test.mjs checks the size.

    python3 scripts/make-icon.py <wisply-ai>/Wisply/Assets.xcassets/AppIcon.appiconset/AppIcon-1024x1024@1x.png

The committed icon was made on 2026-10-22 from wisply-ai 885cc75 (the app
icon last changed in 38562a0). Needs Pillow. Run it again only when the app
icon changes.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 256
INNER = 224  # 448/512 of the Raycast recipe
RADIUS = 50  # 100/512
MARGIN = (SIZE - INNER) // 2
OUT = Path(__file__).resolve().parent.parent / "media" / "icon.png"


def main(source: str) -> None:
    art = Image.open(source).convert("RGBA").resize((INNER, INNER), Image.LANCZOS)
    mask = Image.new("L", (INNER, INNER), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, INNER - 1, INNER - 1), radius=RADIUS, fill=255)
    art.putalpha(mask)
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(art, (MARGIN, MARGIN), art)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    icon.save(OUT, optimize=True)
    print(f"wrote {OUT.relative_to(OUT.parent.parent)} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
