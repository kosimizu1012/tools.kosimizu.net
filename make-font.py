#!/usr/bin/env python3
"""同梱フォントを unicode-range 分割して assets/font/ に書き出す。

日本語フォントは丸ごとだと数MBある。全部を1ファイルにすると、
「今回のご依頼」の6文字を出すためだけに数MBを落とすことになる。

そこで Google Fonts と同じやり方で、文字コードの範囲ごとに小さく割っておき、
@font-face の unicode-range でブラウザに「使う範囲だけ」取りに行かせる。
短い見出しなら数十KBで済む。

同梱フォントは複数あるので、assets/font.css は「書きつぶす」のではなく
「その書体のぶんだけ差し替える」。元のttfを手元に揃えていなくても、
1つだけ作り直せるようにするため。

使い方:
    python3 make-font.py path/to/Font.ttf FamilyName [font-weight]

font-weight は、その書体が持っている太さを書く（例：Black なら 900）。
書いておくと、太字を指定されたときにブラウザが「持っている中で一番近い太さ」
としてこの face を選ぶので、偽の太字（輪郭を太らせる処理）が掛からない。
省略すると 400 扱いになり、太字指定で偽の太字が掛かる。
"""
import os
import re
import sys

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


def write_css(path, family, blocks):
    """font.css のうち、この書体のぶんだけを差し替えて書き戻す。

    ほかの書体の @font-face はそのまま残す。全部を作り直す形にすると、
    1つ足すたびに全部の元ttfを揃え直さねばならなくなる。
    """
    keep, families = [], []
    if os.path.exists(path):
        for m in re.finditer(r"@font-face\{.*?\}", open(path, encoding="utf-8").read(), re.S):
            t = m.group(0)
            f = re.search(r"font-family:'([^']+)'", t)
            if f and f.group(1) != family:
                keep.append(t)
                if f.group(1) not in families:
                    families.append(f.group(1))
    families.append(family)

    head = [
        "/* 自動生成：make-font.py で作られます。直接編集しないでください。",
        "   同梱フォントを unicode-range で分割したものです。",
        "   ブラウザは実際に使う範囲のファイルだけを取りに行きます。",
        "   収録: " + " / ".join(families) + " */",
    ]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(head + keep + blocks) + "\n")


def main():
    src = sys.argv[1]
    family = sys.argv[2] if len(sys.argv) > 2 else "sitefont"
    weight = sys.argv[3] if len(sys.argv) > 3 else ""
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

    blocks = []
    for name, rng, _ in faces:
        lines = ["@font-face{", f"  font-family:'{family}';",
                 f"  src:url('font/{name}') format('woff2');"]
        if weight:
            lines.append(f"  font-weight:{weight};")
        lines += ["  font-display:swap;", f"  unicode-range:{rng};", "}"]
        blocks.append("\n".join(lines))
    write_css(os.path.join(HERE, "assets", "font.css"), family, blocks)

    print(f"{len(faces)}分割 / 合計 {total/1024/1024:.2f}MB")
    print(f"かな・英数の1つ目: {faces[0][2]/1024:.0f}KB "
          f"（短い見出しならこれ＋漢字1〜2個ぶんで済みます）")


if __name__ == "__main__":
    main()
