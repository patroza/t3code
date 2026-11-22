#!/usr/bin/env python3
"""Pull a real SVG document out of a nested getConfluenceContent payload."""

import json
import sys
from pathlib import Path


def find_svg(node):
    if isinstance(node, str):
        stripped = node.strip()
        if stripped[:1] in "{[\"'":
            try:
                return find_svg(json.loads(stripped))
            except json.JSONDecodeError:
                pass
        if "<svg" in node and "</svg>" in node and '\\"' not in node[:400]:
            start = node.find("<svg")
            end = node.rfind("</svg>")
            return node[start : end + len("</svg>")]
        return None
    if isinstance(node, dict):
        for value in node.values():
            found = find_svg(value)
            if found:
                return found
    if isinstance(node, list):
        for value in node:
            found = find_svg(value)
            if found:
                return found
    return None


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: extract_svg.py <tool-output> <out.svg>", file=sys.stderr)
        return 2
    raw = Path(sys.argv[1]).read_text()
    svg = find_svg(raw) or ""
    if "<svg" not in svg or "</svg>" not in svg or '\\"' in svg[:400]:
        print("no decoded svg", file=sys.stderr)
        return 1
    Path(sys.argv[2]).write_text(svg)
    print(Path(sys.argv[2]).stat().st_size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
