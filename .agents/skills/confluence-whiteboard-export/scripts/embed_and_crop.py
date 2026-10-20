#!/usr/bin/env python3
"""Embed pasted whiteboard images by SVG id and crop the canvas.

Text nodes are copied through unchanged. Image geometry is copied through
unchanged. Only hrefs and the root viewBox change.
"""

import base64
import re
import sys
from pathlib import Path

PAD = 80
IMAGE_RE = re.compile(r"<image\b(?:[^>]*/>|[^>]*>.*?</image>)", re.S)
ATTR_RE = re.compile(r'([\w:-]+)="([^"]*)"')
TAG_RE = re.compile(r"<(?:rect|image|ellipse)\b([^>]*)/?>")


def attrs(fragment: str) -> dict[str, str]:
    return dict(ATTR_RE.findall(fragment))


def load_files(directory: Path) -> dict[str, Path]:
    files: dict[str, Path] = {}
    for path in directory.iterdir():
        if not path.is_file():
            continue
        match = re.fullmatch(r"img-\d+-(.+)\.(png|jpe?g|webp)", path.name, re.I)
        if match is None:
            match = re.fullmatch(r"(.+)\.(png|jpe?g|webp)", path.name, re.I)
        if match:
            files[match.group(1)] = path
    return files


def data_url(path: Path) -> str:
    suffix = path.suffix.lower()
    mime = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(suffix, "image/png")
    encoded = base64.b64encode(path.read_bytes()).decode()
    return f"data:{mime};base64,{encoded}"


def number(value: str | None, default: float = 0) -> float:
    if value is None or value == "":
        return default
    return float(value)


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: embed_and_crop.py <in.svg> <image-dir> <out.svg>", file=sys.stderr)
        return 2
    source = Path(sys.argv[1]).read_text()
    files = load_files(Path(sys.argv[2]))
    missing: list[str] = []
    embedded = 0

    def replace_image(match: re.Match[str]) -> str:
        nonlocal embedded
        element = match.group(0)
        open_end = element.find(">")
        open_tag = element[: open_end + 1]
        values = attrs(open_tag)
        image_id = values.get("id", "")
        path = files.get(image_id)
        if path is None:
            if image_id:
                missing.append(image_id)
            return element
        url = data_url(path)
        body = re.sub(r'\s(?:xlink:)?href="[^"]*"', "", open_tag)
        self_closing = body.rstrip().endswith("/>")
        body = body.rstrip()[:-2].rstrip() if self_closing else body.rstrip()[:-1]
        embedded += 1
        closer = "/>" if self_closing else ">"
        return f'{body} href="{url}" xlink:href="{url}"{closer}' + element[open_end + 1 :]

    text = IMAGE_RE.sub(replace_image, source)
    xs: list[float] = []
    ys: list[float] = []

    def add_box(x: float, y: float, w: float = 0, h: float = 0) -> None:
        xs.extend((x, x + w))
        ys.extend((y, y + h))

    for match in TAG_RE.finditer(text):
        values = attrs(match.group(1))
        try:
            if "x" in values and "y" in values:
                add_box(
                    number(values["x"]),
                    number(values["y"]),
                    number(values.get("width")),
                    number(values.get("height")),
                )
            if "cx" in values and "cy" in values:
                radius = number(values.get("r"), number(values.get("rx")))
                ry = number(values.get("ry"), radius)
                add_box(number(values["cx"]) - radius, number(values["cy"]) - ry, radius * 2, ry * 2)
        except ValueError:
            continue

    for match in re.finditer(r'\bpoints="([^"]+)"', text):
        nums = [float(item) for item in re.findall(r"-?\d+(?:\.\d+)?", match.group(1))]
        for index in range(0, len(nums) - 1, 2):
            add_box(nums[index], nums[index + 1])

    for match in re.finditer(r"<line\b([^>]*)/?>", text):
        values = attrs(match.group(1))
        try:
            if {"x1", "y1", "x2", "y2"} <= values.keys():
                add_box(number(values["x1"]), number(values["y1"]))
                add_box(number(values["x2"]), number(values["y2"]))
        except ValueError:
            continue

    for match in re.finditer(r"<text\b([^>]*)>(.*?)</text>", text, re.S):
        values = attrs(match.group(1))
        try:
            x = number(values.get("x"))
            y = number(values.get("y"))
            width = number(values.get("width"))
            size = number(values.get("font-size", "").removesuffix("px"), 16)
        except ValueError:
            continue
        lines = max(1, len(re.findall(r"<tspan\b", match.group(2))))
        height = size * 1.25 * lines
        anchor = values.get("text-anchor", "start")
        if anchor == "middle":
            add_box(x - width / 2, y - size, width, height + size)
        elif anchor == "end":
            add_box(x - width, y - size, width, height + size)
        else:
            add_box(x, y - size, width, height + size)

    if not xs or not ys:
        print("no geometry to crop", file=sys.stderr)
        return 1

    min_x, max_x = min(xs) - PAD, max(xs) + PAD
    min_y, max_y = min(ys) - PAD, max(ys) + PAD
    width = max_x - min_x
    height = max_y - min_y
    opening = (
        '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" '
        'xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{width:.2f}" height="{height:.2f}" '
        f'viewBox="{min_x:.2f} {min_y:.2f} {width:.2f} {height:.2f}">'
        f'<rect x="{min_x:.2f}" y="{min_y:.2f}" width="{width:.2f}" height="{height:.2f}" fill="#ffffff"/>'
    )
    text, count = re.subn(r"<svg\b[^>]*>", opening, text, count=1)
    if count != 1:
        print("missing svg root", file=sys.stderr)
        return 1
    out = Path(sys.argv[3])
    out.write_text(text)
    print(f"embedded {embedded} files {len(files)} missing {len(missing)}")
    if missing:
        print("missing " + " ".join(missing))
    print(f"viewBox {min_x:.2f} {min_y:.2f} {width:.2f} {height:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
