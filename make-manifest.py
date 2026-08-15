#!/usr/bin/env python3
"""puru/backgrounds/ の中身から manifest.json を作る。

Webページは勝手にフォルダの中身を一覧できないので、
どのファイルがあるかを書いた目録を置いておく。
背景画像を足したり消したりしたら、これを実行してから push すること。

    python3 make-manifest.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
BG = os.path.join(HERE, "puru", "backgrounds")
EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

names = sorted(
    f for f in os.listdir(BG)
    if os.path.splitext(f)[1].lower() in EXTS
)

out = os.path.join(BG, "manifest.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(names, f, ensure_ascii=False, indent=2)
    f.write("\n")

print(f"{len(names)}件を manifest.json に書き出しました")
for n in names:
    print("  -", n)
