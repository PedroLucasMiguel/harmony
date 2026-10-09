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
    client/android/app/src/main/res/
        mipmap-*/ic_launcher*.png   the Android launcher icon: an adaptive
                                    icon's foreground (the logo alone -- its
                                    background is the gradient in
                                    drawable/ic_launcher_background.xml), plus
                                    the square and round ones older Androids use
        drawable*/splash.png        the launch screen, the icon on the app's
                                    background colour

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

# Android: launcher sizes per density, and the adaptive foreground (108 dp,
# of which only the middle 66 dp is guaranteed to be visible).
ANDROID_DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
ADAPTIVE_LOGO_SCALE = 0.42      # of the 108 dp canvas: inside the safe zone
SPLASH_BACKGROUND = (15, 17, 22)  # Midnight's --bg, the default palette


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


def circle(image: Image.Image) -> Image.Image:
    size = image.width
    big = size * 4
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, big - 1, big - 1], fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(image, (0, 0), mask.resize((size, size), Image.LANCZOS))
    return out


def gradient_square(size: int) -> Image.Image:
    out = Image.new('RGBA', (size, size))
    draw = ImageDraw.Draw(out)
    for y in range(size):
        t = y / max(1, size - 1)
        colour = tuple(round(a + (b - a) * t) for a, b in zip(TILE_TOP, TILE_BOTTOM))
        draw.line([(0, y), (size, y)], fill=(*colour, 255))
    return out


def android(square: Image.Image) -> list:
    res = ROOT / 'client' / 'android' / 'app' / 'src' / 'main' / 'res'
    if not res.exists():
        return []
    written = []
    for density, scale in ANDROID_DENSITIES.items():
        folder = res / f'mipmap-{density}'
        legacy = round(48 * scale)
        icon(legacy, square).save(folder / 'ic_launcher.png')
        # The round one is the full-bleed gradient cut to a circle, so the
        # logo sits in the middle rather than in a rounded square in a circle.
        disc = gradient_square(legacy)
        inner = round(legacy * LOGO_SCALE * 0.9)
        disc.alpha_composite(square.resize((inner, inner), Image.LANCZOS),
                             ((legacy - inner) // 2, (legacy - inner) // 2))
        circle(disc).save(folder / 'ic_launcher_round.png')

        canvas = round(108 * scale)
        foreground = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
        inner = round(canvas * ADAPTIVE_LOGO_SCALE)
        foreground.alpha_composite(square.resize((inner, inner), Image.LANCZOS),
                                   ((canvas - inner) // 2, (canvas - inner) // 2))
        foreground.save(folder / 'ic_launcher_foreground.png')
        written += [folder / n for n in ('ic_launcher.png', 'ic_launcher_round.png',
                                         'ic_launcher_foreground.png')]

    for splash in sorted(res.glob('drawable*/splash.png')):
        width, height = Image.open(splash).size
        out = Image.new('RGBA', (width, height), (*SPLASH_BACKGROUND, 255))
        side = round(min(width, height) * 0.28)
        out.alpha_composite(icon(side, square), ((width - side) // 2, (height - side) // 2))
        out.convert('RGB').save(splash, optimize=True)
        written.append(splash)
    return written


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

    written = [build / 'icon.ico', build / 'icon.png', runtime / 'icon.ico', runtime / 'icon.png',
               renderer / 'logo.png', *android(square)]
    for path in written:
        print(f'wrote {path.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
