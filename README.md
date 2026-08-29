# tools.kosimizu.net

イラスト投稿とフリマ出品のための小さな道具を3つ置いた静的サイト。GitHub Pages で公開します。

処理はすべてブラウザ内で完結し、**画像がサーバーに送られることはありません**。

## 構成

```
CNAME                     tools.kosimizu.net
index.html                入口（ツールを並べる）
assets/
  site.css                共通の見た目（kosimizu.net の配色に合わせてある）
  gif.js                  共通のGIFエンコーダ
  preset.js               共通のプリセット
  font.css                同梱フォントの @font-face（自動生成）
  font/                   同梱フォント本体（unicode-range で分割）
  fontpicker.js           書体の切り替えと、利用者フォントの読み込み
puru/
  index.html              画像動かすゾウ
  app.js
  backgrounds/            背景ライブラリ（manifest.json で目録を作る）
narabe/
  index.html              画像並べたらカックイイヤ
  app.js
  back.png                方眼の背景
masu/
  index.html              画像切り取りマス
  app.js
make-manifest.py          背景の目録を作り直す
```

`assets/preset.js` と `assets/fontpicker.js` は3つのツールで、
`assets/gif.js` と `assets/mp4.js` はGIFを作る2つのツールで共有しています。

## 公開のしかた

サブドメインで出すため、**このサイト専用のリポジトリ**が必要です。
GitHub Pages は1リポジトリにつき CNAME を1つしか持てないため、
本体（`kosimizu.net`）のリポジトリには同居できません。

1. GitHub で新しいリポジトリを作る（例：`tools.kosimizu.net`）
2. このフォルダの中身を push する

   ```bash
   git init
   git add -A
   git commit -m "tools.kosimizu.net"
   git branch -M main
   git remote add origin https://github.com/kosimizu1012/tools.kosimizu.net.git
   git push -u origin main
   ```

3. リポジトリの Settings → Pages で、Source を `main` ブランチのルートにする
4. DNS に CNAME レコードを1つ足す

   | ホスト名 | 種別 | 値 |
   |---|---|---|
   | `tools` | CNAME | `kosimizu1012.github.io` |

5. Settings → Pages の Custom domain が `tools.kosimizu.net` になっていることを確認し、
   証明書が発行されたら **Enforce HTTPS** を入れる

DNSが行き渡るまで数分〜1時間ほどかかります。

### 本体サイトからリンクする（任意）

`kosimizu.net` の `index.html` の Works に、次のようなカードを足すとつながります。
別リポジトリなので、そちらへの変更は別途 push が必要です。

```html
<div class="app-card">
  <div class="app-info">
    <h3>Tools</h3>
    <p>イラスト投稿のための小さな道具。ブラウザだけで動くGIF作成ツールです。</p>
  </div>
  <a class="app-link" href="https://tools.kosimizu.net/">ツールを見る</a>
</div>
```

## 素材の差し替え

### 背景ライブラリ（画像動かすゾウ）

`puru/backgrounds/` に画像を入れて、次を実行してから push します。

```bash
python3 make-manifest.py
```

### フォント

既定は **Hachi Maru Pop（はちまるポップ）**。SIL Open Font License で、
再配布が明示的に許諾されています（`assets/font/OFL.txt` に原文を同梱）。

日本語フォントは丸ごとだと数MBあるため、**unicode-range で47分割**してあります。
ブラウザは実際に使う文字の範囲だけを取りに行くので、
既定の「今回のご依頼＋@piyotto」なら **5ファイル・247KB** で済みます。

別のフォントに差し替えるときは次を実行してください。
`assets/font/` と `assets/font.css` が作り直されます。

```bash
python3 make-font.py path/to/Font.ttf familyname
```

`familyname` を変えた場合は `assets/fontpicker.js` の `BUILTIN.family` も合わせてください。

### 利用者が自分のフォントを追加する

ツールの「文字」→「フォントを追加…」から、手持ちの ttf / otf / woff / woff2 を
読み込んで使えます。ファイルは IndexedDB に保存され、次に開いたときは自動で戻ります。

**フォントファイルは端末の外に出ません。** サーバーに送られることも、
リポジトリに含まれることもありません。そのため、
再配布が許諾されていないフォントでも利用者ご自身の環境でなら使えます。

なお IndexedDB はブラウザの「Cookieと他のサイトデータ」を消すと一緒に消えます
（「キャッシュされた画像とファイル」だけの削除では消えません）。
プリセットも同じ扱いなので、大事な設定は「ファイルに書き出し」で控えを取ってください。

## ローカルで確認する

`file://` で直接開くと、`@font-face` と `fetch`（背景の目録）がブラウザに拒否されます。
簡易サーバーを立てて確認してください。

```bash
python3 -m http.server 8801
```

## 実装のメモ

### 切り抜きの持ち方（画像切り取りマス）

横位置・縦位置のつまみは、画面に対する割合ではなく **動かせる幅に対する割合** で持っています。
画面に対する割合にすると、拡大率を上げるほどつまみの端が余り、
逆に低い倍率では端まで動かしても足りない、という食い違いが出ます。
可動域に対する割合なら、どの倍率でもつまみの端から端までがちょうど可動域になります。

ピンチ・ドラッグ・ホイールも、最後は必ずこのつまみの値を書き換えます。
操作の入口は増やしても状態は1か所にしか置かない、という決まりにしてあるので、
見えている数字と絵がずれません。

文字は1枚ごとに書体・色・大きさ・場所・枠を持ち、プリセットはこの束をまるごと覚えます。
切り抜きだけは写真ごとの事情なので、あえて覚えません。

### GIFの書き出し

2つのツールで透過の使い道が違うので、`assets/gif.js` でそこを1つにまとめています。

- **画像動かすゾウの透過GIF** — 透過インデックスは「本当に透ける画素」。廃棄方法2で毎コマ消す
- **並べたらカックイイヤの差分最適化** — 透過インデックスは「前のコマと同じ」。廃棄方法1で前を残す

1つのインデックスに両方の意味は持たせられないため、
**本当の透過が要るときは差分最適化を切る**という規則にしてあります。

差分最適化は、静止部分が透過の連続になってLZWがよく潰すので効果が大きく、
実測で **べた書き448KB → 136KB（69.6%減）**、復元される絵は完全に同一です。

### Web版で消えた制約

`file://` 向けに入れていた回避策が、サーバー配信では不要になりました。

- フォントを base64 で同梱していた `assets.js`（2.57MB）を廃止。`@font-face` で普通に読めます
- 背景フォルダを開くたびに選ばせていた操作を廃止。目録を `fetch` して最初から並べます
- `back.png` を普通の `<img>` で読めます。同一オリジンなので canvas が汚染されません
