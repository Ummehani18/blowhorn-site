#!/usr/bin/env python3
"""Fail if the default Open Graph image is missing, the wrong size, or not
wired as the site-wide default, or if article and video pages lack their
specific social metadata (issue #703, #699).

Checks the built site:

- static file assets/brand/marketing/blowhorn-og-1200x630.png is 1200x630
- the home page, a docs page, a compare page, a legal page and a Field Manual
  page each have og:type website, one og:image pointing at that file with width 1200,
  height 630, og:image:type image/png, twitter:card summary_large_image,
  twitter:site, and twitter:image
- a role page keeps its own art as og:image (not the default)
- an article page has og:type article, article:published_time, author meta,
  and article:tag
- a video page has og:type video.other and uses its poster for og:image with
  og:image:type image/webp

Usage: check_og_image.py BUILD_DIR
"""

from __future__ import annotations

import struct
import sys
from html.parser import HTMLParser
from pathlib import Path

DEFAULT_PATH = "assets/brand/marketing/blowhorn-og-1200x630.png"
DEFAULT_WIDTH = 1200
DEFAULT_HEIGHT = 630
TWITTER_CARD = "summary_large_image"
TWITTER_SITE = "@blowhorn_ai"

# Pages that should use the site-wide default image.
DEFAULT_PAGES = (
    "index.html",
    "docs/how-to/set-up/install-the-app/index.html",
    "compare/taplio/index.html",
    "legal/privacy/index.html",
    "field-manual/youtube/index.html",
)

# A role page must keep its own art. The slug is stable in data/roles.json.
ROLE_PAGE = "for/devrel/index.html"

# Sample article and video pages to verify specific metadata.
ARTICLE_PAGE = "resources/articles/failed-posts-are-data/index.html"
VIDEO_PAGE = "resources/videos/getting-started/battalion-thunder/index.html"


class MetaCollector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.props = []  # (attr, name, content)

    def handle_starttag(self, tag, attrs):
        if tag != "meta":
            return
        attrs = dict(attrs)
        content = attrs.get("content") or ""
        if "property" in attrs:
            self.props.append(("property", attrs["property"], content))
        if "name" in attrs:
            self.props.append(("name", attrs["name"], content))

    def values(self, kind, name):
        return [content for k, n, content in self.props if k == kind and n == name]


def png_size(path: Path) -> tuple[int, int]:
    """Width and height from the PNG IHDR chunk. Avoids a Pillow dependency in CI."""
    with path.open("rb") as handle:
        if handle.read(8) != b"\x89PNG\r\n\x1a\n":
            raise ValueError(f"{path} is not a PNG")
        length, typ = struct.unpack(">I4s", handle.read(8))
        if typ != b"IHDR":
            raise ValueError(f"{path} has no IHDR chunk")
        width, height = struct.unpack(">II", handle.read(8))
    return width, height


def image_ok(path: Path) -> list[str]:
    if not path.is_file():
        return [f"{DEFAULT_PATH}: not published"]
    try:
        size = png_size(path)
    except ValueError as exc:
        return [str(exc)]
    if size != (DEFAULT_WIDTH, DEFAULT_HEIGHT):
        return [
            f"{DEFAULT_PATH}: {size[0]}x{size[1]}, "
            f"expected {DEFAULT_WIDTH}x{DEFAULT_HEIGHT}"
        ]
    return []


def page_meta(root: Path, rel: str) -> tuple[MetaCollector | None, str | None]:
    path = root / rel
    if not path.is_file():
        return None, f"{rel}: not built"
    parser = MetaCollector()
    parser.feed(path.read_text(encoding="utf-8"))
    return parser, None


def default_errors(rel: str, parser: MetaCollector, base: str) -> list[str]:
    errors = []
    og_types = parser.values("property", "og:type")
    if og_types != ["website"]:
        errors.append(f"{rel}: og:type is {og_types}, expected ['website']")
    tw_sites = parser.values("name", "twitter:site")
    if tw_sites != [TWITTER_SITE]:
        errors.append(f"{rel}: twitter:site is {tw_sites}, expected [{TWITTER_SITE!r}]")
    img_types = parser.values("property", "og:image:type")
    if img_types != ["image/png"]:
        errors.append(f"{rel}: og:image:type is {img_types}, expected ['image/png']")
    images = parser.values("property", "og:image")
    if len(images) != 1:
        errors.append(f"{rel}: expected one og:image, found {len(images)}: {images}")
        return errors
    if not images[0].endswith("/" + DEFAULT_PATH) and images[0] != base + DEFAULT_PATH:
        # Accept any absolute URL whose path is the default file.
        if not images[0].rstrip("/").endswith(DEFAULT_PATH):
            errors.append(f"{rel}: og:image is {images[0]}, expected {DEFAULT_PATH}")
    widths = parser.values("property", "og:image:width")
    heights = parser.values("property", "og:image:height")
    if widths != [str(DEFAULT_WIDTH)]:
        errors.append(f"{rel}: og:image:width is {widths}, expected [{DEFAULT_WIDTH}]")
    if heights != [str(DEFAULT_HEIGHT)]:
        errors.append(f"{rel}: og:image:height is {heights}, expected [{DEFAULT_HEIGHT}]")
    cards = parser.values("name", "twitter:card")
    if cards != [TWITTER_CARD]:
        errors.append(f"{rel}: twitter:card is {cards}, expected [{TWITTER_CARD}]")
    tw_images = parser.values("name", "twitter:image")
    if tw_images != images:
        errors.append(f"{rel}: twitter:image is {tw_images}, expected {images}")
    return errors


def role_errors(rel: str, parser: MetaCollector) -> list[str]:
    errors = []
    images = parser.values("property", "og:image")
    if len(images) != 1:
        errors.append(f"{rel}: expected one og:image, found {len(images)}: {images}")
        return errors
    if images[0].rstrip("/").endswith(DEFAULT_PATH):
        errors.append(f"{rel}: og:image used the default lockup; role pages keep their own art")
    cards = parser.values("name", "twitter:card")
    if cards != [TWITTER_CARD]:
        errors.append(f"{rel}: twitter:card is {cards}, expected [{TWITTER_CARD}]")
    tw_images = parser.values("name", "twitter:image")
    if tw_images != images:
        errors.append(f"{rel}: twitter:image is {tw_images}, expected {images}")
    tw_sites = parser.values("name", "twitter:site")
    if tw_sites != [TWITTER_SITE]:
        errors.append(f"{rel}: twitter:site is {tw_sites}, expected [{TWITTER_SITE!r}]")
    return errors


def article_errors(rel: str, parser: MetaCollector) -> list[str]:
    errors = []
    og_types = parser.values("property", "og:type")
    if og_types != ["article"]:
        errors.append(f"{rel}: og:type is {og_types}, expected ['article']")
    published = parser.values("property", "article:published_time")
    if not published or not published[0]:
        errors.append(f"{rel}: missing article:published_time")
    authors = parser.values("name", "author")
    if not authors or not authors[0]:
        errors.append(f"{rel}: missing author meta tag")
    tags = parser.values("property", "article:tag")
    if not tags:
        errors.append(f"{rel}: expected article:tag tags, found none")
    tw_sites = parser.values("name", "twitter:site")
    if tw_sites != [TWITTER_SITE]:
        errors.append(f"{rel}: twitter:site is {tw_sites}, expected [{TWITTER_SITE!r}]")
    return errors


def video_errors(rel: str, parser: MetaCollector) -> list[str]:
    errors = []
    og_types = parser.values("property", "og:type")
    if og_types != ["video.other"]:
        errors.append(f"{rel}: og:type is {og_types}, expected ['video.other']")
    images = parser.values("property", "og:image")
    if len(images) != 1:
        errors.append(f"{rel}: expected one og:image, found {len(images)}: {images}")
        return errors
    if images[0].rstrip("/").endswith(DEFAULT_PATH):
        errors.append(f"{rel}: og:image used the default lockup; video pages keep their poster")
    img_types = parser.values("property", "og:image:type")
    if img_types != ["image/webp"]:
        errors.append(f"{rel}: og:image:type is {img_types}, expected ['image/webp']")
    tw_sites = parser.values("name", "twitter:site")
    if tw_sites != [TWITTER_SITE]:
        errors.append(f"{rel}: twitter:site is {tw_sites}, expected [{TWITTER_SITE!r}]")
    return errors


def check(build_dir) -> list[str]:
    root = Path(build_dir)
    errors = image_ok(root / DEFAULT_PATH)
    for rel in DEFAULT_PAGES:
        parser, missing = page_meta(root, rel)
        if missing:
            errors.append(missing)
            continue
        errors.extend(default_errors(rel, parser, ""))
    parser, missing = page_meta(root, ROLE_PAGE)
    if missing:
        errors.append(missing)
    else:
        errors.extend(role_errors(ROLE_PAGE, parser))
    parser, missing = page_meta(root, ARTICLE_PAGE)
    if missing:
        errors.append(missing)
    else:
        errors.extend(article_errors(ARTICLE_PAGE, parser))
    parser, missing = page_meta(root, VIDEO_PAGE)
    if missing:
        errors.append(missing)
    else:
        errors.extend(video_errors(VIDEO_PAGE, parser))
    return errors


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check_og_image.py BUILD_DIR", file=sys.stderr)
        return 2
    errors = check(sys.argv[1])
    for item in errors:
        print(item, file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
