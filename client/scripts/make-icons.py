"""Build Harmony's app icons from the logo.

    python client/scripts/make-icons.py            # from the repo root

Reads media/iso.png -- the logo, white lines on transparent -- and writes:

    client/build/icon.ico       every Windows size; the .exe, taskbar, Start
                                menu and installer (electron-builder picks it
                                up from buildResources)
    client/build/icon.png       1024 px, for the Linux and macOS builds
    client/src/main/icon.ico    the window's own icon at runtime, so
    client/src/main/icon.png    `npm start` shows it too (build/ is not packaged)
    client/src/renderer/logo.png  the bare logo for the login screen, used there
                                as a CSS mask so it takes the palette's colour

The logo goes on a rounded tile rather than on transparency: white lines on
nothing disappear on a light taskbar, in Explorer and in the installer. The
tile is a gradient between two of the app's accents; change TILE_TOP and
TILE_BOTTOM to recolour it, then re-run.

Needs Pillow (pip install pillow). Not part of the build: the outputs are
committed, so building the app needs neither Python nor this script.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
LOGO = ROOT / 'media' / 'iso.png'

TILE_TOP = (139, 124, 255)     # violet, between the Onyx and Lavender accents
TILE_BOTTOM = (91, 140, 255)   # Midnight's blue
CORNER = 0.22                  # corner radius, as a fraction of the side
LOGO_SCALE = 0.68              # the logo's share of the tile

ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]


def tile(size: int) -> Image.Image:
    """The rounded gradient square, drawn large and scaled down for clean edges."""
    big = size * 4
    gradient = Image.new('RGBA', (big, big))
    draw = ImageDraw.Draw(gradient)
    for y in range(big):
        t = y / (big - 1)
        colour = tuple(round(a + (b - a) * t) for a, b in zip(TILE_TOP, TILE_BOTTOM))
        draw.line([(0, y), (big, y)], fill=(*colour, 255))

    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=round(big * CORNER), fill=255,
    )
    out = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    out.paste(gradient, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def icon(size: int, logo: Image.Image) -> Image.Image:
    base = tile(size)
    inner = round(size * LOGO_SCALE)
    mark = logo.resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    base.alpha_composite(mark, (offset, offset))
    return base


def main() -> None:
    logo = Image.open(LOGO).convert('RGBA')
    # Square it first, so a non-square logo is centred rather than stretched.
    side = max(logo.size)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.paste(logo, ((side - logo.width) // 2, (side - logo.height) // 2))

    build = ROOT / 'client' / 'build'
    runtime = ROOT / 'client' / 'src' / 'main'
    build.mkdir(parents=True, exist_ok=True)

    large = icon(1024, square)
    large.save(build / 'icon.png')
    icon(256, square).save(runtime / 'icon.png')

    # Each size rendered on its own rather than shrunk from one image, so the
    # small ones keep their edges.
    frames = [icon(size, square) for size in ICO_SIZES]
    for target in (build / 'icon.ico', runtime / 'icon.ico'):
        frames[-1].save(target, format='ICO', sizes=[(s, s) for s in ICO_SIZES],
                        append_images=frames[:-1])

    # The login screen's logo: just the mark, no tile. Only its alpha is
    # used (it is a CSS mask), so its colour does not matter here.
    renderer = ROOT / 'client' / 'src' / 'renderer'
    square.resize((256, 256), Image.LANCZOS).save(renderer / 'logo.png', optimize=True)

    for path in (build / 'icon.ico', build / 'icon.png', runtime / 'icon.ico', runtime / 'icon.png',
                 renderer / 'logo.png'):
        print(f'wrote {path.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
