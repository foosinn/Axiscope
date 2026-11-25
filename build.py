#!/usr/bin/env python3
"""Inline the local JS and CSS files of index.html into one HTML file."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCRIPT = re.compile(r'<script src="\./([^"]+)"></script>')
STYLE = re.compile(r'<link rel="stylesheet" href="\./([^"]+)">')


def read(match):
    content = (ROOT / match.group(1)).read_text()
    if '</script' in content or '</style' in content:
        sys.exit(f'{match.group(1)} contains a closing tag and can not be inlined')
    return content


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'dist' / 'axiscope.html'
    html = (ROOT / 'index.html').read_text()
    html = SCRIPT.sub(lambda m: f'<script>\n{read(m)}\n</script>', html)
    html = STYLE.sub(lambda m: f'<style>\n{read(m)}\n</style>', html)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)
    print(f'wrote {out}')


if __name__ == '__main__':
    main()
