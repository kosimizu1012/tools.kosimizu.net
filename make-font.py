#!/usr/bin/env python3
"""既定フォントを unicode-range 分割して assets/font/ に書き出す。

日本語フォントは丸ごとだと数MBある。全部を1ファイルにすると、
「今回のご依頼」の6文字を出すためだけに数MBを落とすことになる。

そこで Google Fonts と同じやり方で、文字コードの範囲ごとに小さく割っておき、
@font-face の unicode-range でブラウザに「使う範囲だけ」取りに行かせる。
短い見出しなら数十KBで済む。

使い方:
    python3 make-font.py path/to/Font.ttf FamilyName
"""
import os
import sys
import json

from fontTools import subset
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "assets", "font")

# 日本語で普通に打てる文字＝cp932 で表現できる範囲。
# JIS第1・第2水準の漢字、かな、記号、英数がすべて入る。
def japanese_chars():
    out = set()
    for cp in range(0x20, 0x10000):
        try:
            chr(cp).encode("cp932")
            out.add(cp)
        except Exception:
            pass
    return out


def ranges_of(codepoints):
    """連続する符号位置を u+XXXX-YYYY の形にまとめる"""
    cps = sorted(codepoints)
    out, start, prev = [], cps[0], cps[0]
    for cp in cps[1:]:
        if cp != prev + 1:
            out.append((start, prev))
            start = cp
        prev = cp
    out.append((start, prev))
    return ", ".join(
        f"U+{a:04X}" if a == b else f"U+{a:04X}-{b:04X}" for a, b in out
    )


def main():
    src = sys.argv[1]
    family = sys.argv[2] if len(sys.argv) > 2 else "sitefont"
    os.makedirs(OUT, exist_ok=True)

    have = set(TTFont(src).getBestCmap().keys())
    want = sorted(japanese_chars() & have)

    # かな・英数・記号は必ず要るので1つ目にまとめ、漢字は等分する
    base = [c for c in want if c < 0x3400]
    kanji = [c for c in want if c >= 0x3400]
    CHUNK = 150
    groups = [base] + [kanji[i:i + CHUNK] for i in range(0, len(kanji), CHUNK)]

    faces = []
    total = 0
    for i, g in enumerate(groups):
        if not g:
            continue
        name = f"{family}-{i}.woff2"
        path = os.path.join(OUT, name)
        subset.main([
            src,
            "--unicodes=" + ",".join(f"U+{c:04X}" for c in g),
            "--flavor=woff2",
            "--output-file=" + path,
            "--layout-features=*",
            "--no-hinting",
            "--desubroutinize",
        ])
        size = os.path.getsize(path)
        total += size
        faces.append((name, ranges_of(g), size))

    css = [
        "/* 自動生成：make-font.py で作られます。直接編集しないでください。",
        f"   {os.path.basename(src)} を unicode-range で分割したものです。",
        "   ブラウザは実際に使う範囲のファイルだけを取りに行きます。 */",
    ]
    for name, rng, _ in faces:
        css.append("@font-face{")
        css.append(f"  font-family:'{family}';")
        css.append(f"  src:url('font/{name}') format('woff2');")
        css.append("  font-display:swap;")
        css.append(f"  unicode-range:{rng};")
        css.append("}")
    with open(os.path.join(HERE, "assets", "font.css"), "w", encoding="utf-8") as f:
        f.write("\n".join(css) + "\n")

    print(f"{len(faces)}分割 / 合計 {total/1024/1024:.2f}MB")
    print(f"かな・英数の1つ目: {faces[0][2]/1024:.0f}KB "
          f"（短い見出しならこれ＋漢字1〜2個ぶんで済みます）")


if __name__ == "__main__":
    main()
