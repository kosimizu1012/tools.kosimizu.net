"use strict";

/* =========================================================================
   画像切り取りマス

   フリマの出品写真を正方形に切り抜き、値札のような文字を載せる。

   切り抜きは「拡大率・横位置・縦位置」の3本のつまみで決まる。
   プレビューの上でのピンチやドラッグも、最後は必ずこのつまみの値へ落とす。
   操作の入口を増やしても、状態は1か所にしか無いようにしておくと、
   見えている数字と絵が食い違わない。

   横位置・縦位置は「画面に対する割合」ではなく「動かせる幅に対する割合」。
   拡大率を上げると動かせる幅も広がるので、割合で持っておけば
   どの倍率でもつまみの端から端までが可動域になる。

   文字は何枚でも重ねられる。書体・色・大きさ・場所・枠はすべて1枚ごとの持ち物で、
   プリセットはこの束をまるごと覚える。切り抜きは写真ごとの事情なので含めない。
   ========================================================================= */

const PREVIEW = 900;

const els = {};
[ "view","meta","status","warn","dl",
  "shelf","addBtn","clearBtn","file",
  "fitMode","zoom","cropX","cropY","panNote","rotL","rotR","cropReset","bgColor",
  "layers","layerAdd","layerDup","layerDel",
  "tText","fontSel","fontAdd","fontFile","fontDel","fontInfo",
  "tSize","tColor","tBold","tLineH","tAlign","tX","tY","tRot",
  "sOn","sW","sColor","sAlpha",
  "bOn","bColor","bAlpha","bPadX","bPadY","bRad","bbOn","bbColor","bbW","bbAlpha",
  "outSize","outFmt","quality","qualityRow","savePng","saveAll",
  "presetSel","presetSave","presetDel","presetExport","presetImport","presetFile","presetInfo"
].forEach(id => els[id] = document.getElementById(id));

const view = els.view, vctx = view.getContext("2d");

let shots = [];        // { name, url, img, zoom, cx, cy, rot }
let cur = -1;
let layers = [];       // 文字の束
let sel = -1;

function warn(msg){
  els.warn.textContent = msg || "";
  els.warn.classList.toggle("on", !!msg);
}

/* =========================================================================
   文字の1枚

   つまみのidと持ち物の名前を1つの表で結んでおく。
   読み書きの両方をこの表から作れば、片方だけ足して取りこぼす事故が起きない。
   ========================================================================= */
const FIELDS = {
  tText:["text","s"], tSize:["size","n"], tColor:["color","s"], tBold:["bold","b"],
  tLineH:["lineH","n"], tAlign:["align","s"], tX:["x","n"], tY:["y","n"], tRot:["rot","n"],
  sOn:["sOn","b"], sW:["sW","n"], sColor:["sColor","s"], sAlpha:["sAlpha","n"],
  bOn:["bOn","b"], bColor:["bColor","s"], bAlpha:["bAlpha","n"], bPadX:["bPadX","n"],
  bPadY:["bPadY","n"], bRad:["bRad","n"], bbOn:["bbOn","b"], bbColor:["bbColor","s"],
  bbW:["bbW","n"], bbAlpha:["bbAlpha","n"]
};
const FIELD_IDS = Object.keys(FIELDS);
const CROP_IDS = ["zoom","cropX","cropY"];

/* 出品用に決めた既定の見た目。
   実際に使っているプリセット（masu-presets.json の「デフォルト用」）を
   そのまま持ってきてある。追加した文字もこの見た目で出るので、
   毎回つまみを合わせ直さずに文言だけ変えれば済む。 */
function newLayer(over){
  return Object.assign({
    text:"新しい文字", fontId: FontPicker.id,
    size:9, color:"#f97171", bold:true, lineH:1.2, align:"center",
    x:50, y:12, rot:0,
    sOn:true, sW:1.5, sColor:"#ffffff", sAlpha:82,
    bOn:false, bColor:"#ffffff", bAlpha:100, bPadX:40, bPadY:24, bRad:14,
    bbOn:false, bbColor:"#ffffff", bbW:0.6, bbAlpha:100
  }, over || {});
}

/* 開いた直後に載っている文字。文言まで含めて既定にしてある。 */
const FIRST_TEXT = "24時間以内発送\n新品未開封";

/* 版が違うプリセットや、手で直した書き出しファイルが来ても落ちないように、
   欠けている項目は既定値で埋め、数は数として読み直す。 */
function tidyLayer(o){
  const L = newLayer();
  if (!o || typeof o !== "object") return L;
  FIELD_IDS.forEach(id => {
    const [key, kind] = FIELDS[id];
    if (!(key in o)) return;
    if (kind === "n"){ const v = +o[key]; if (isFinite(v)) L[key] = v; }
    else if (kind === "b") L[key] = !!o[key];
    else L[key] = String(o[key]);
  });
  if (o.fontId) L.fontId = o.fontId;
  return L;
}

function readControlsIntoLayer(){
  const L = layers[sel];
  if (!L) return;
  FIELD_IDS.forEach(id => {
    const [key, kind] = FIELDS[id], el = els[id];
    L[key] = kind === "b" ? el.checked : (kind === "n" ? +el.value : el.value);
  });
}

function writeLayerIntoControls(){
  const L = layers[sel];
  const on = !!L;
  FIELD_IDS.forEach(id => {
    const [key, kind] = FIELDS[id], el = els[id];
    if (on){
      if (kind === "b") el.checked = L[key];
      else el.value = L[key];
    }
    el.disabled = !on;
  });
  els.layerDup.disabled = !on;
  els.layerDel.disabled = !on;
  if (on) FontPicker.id = L.fontId;
  refreshLabels();
}

function renderLayerList(){
  els.layers.innerHTML = "";
  if (!layers.length){
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "「追加」を押すと文字を載せられます。";
    els.layers.appendChild(d);
    return;
  }
  layers.forEach((L, i) => {
    const row = document.createElement("div");
    row.className = "lay" + (i === sel ? " on" : "");
    const t = document.createElement("button");
    t.type = "button"; t.className = "t";
    t.style.cssText = "background:none;border:none;color:inherit;font:inherit;padding:0;text-align:left";
    t.textContent = (L.text || "（空）").replace(/\n/g, " ");
    t.addEventListener("click", () => { sel = i; renderLayerList(); writeLayerIntoControls(); draw(); });
    row.appendChild(t);

    const up = document.createElement("button");
    up.type = "button"; up.className = "u"; up.textContent = "▲"; up.disabled = i === 0;
    up.title = "後ろへ";
    up.addEventListener("click", e => { e.stopPropagation(); move(i, -1); });
    const dn = document.createElement("button");
    dn.type = "button"; dn.className = "d"; dn.textContent = "▼"; dn.disabled = i === layers.length - 1;
    dn.title = "手前へ";
    dn.addEventListener("click", e => { e.stopPropagation(); move(i, 1); });
    row.appendChild(up); row.appendChild(dn);
    els.layers.appendChild(row);
  });
}

function move(i, d){
  const j = i + d;
  if (j < 0 || j >= layers.length) return;
  const t = layers[i]; layers[i] = layers[j]; layers[j] = t;
  if (sel === i) sel = j; else if (sel === j) sel = i;
  renderLayerList(); draw();
}

/* =========================================================================
   目盛りの表示
   ========================================================================= */
const LABELS = {
  zoom: v => (+v).toFixed(0) + " %",
  cropX: v => (+v).toFixed(1),
  cropY: v => (+v).toFixed(1),
  tSize: v => (+v).toFixed(1) + " %",
  tLineH: v => (+v).toFixed(2),
  tX: v => (+v).toFixed(1) + " %",
  tY: v => (+v).toFixed(1) + " %",
  tRot: v => (+v).toFixed(1) + "°",
  sW: v => (+v).toFixed(1) + " %",
  sAlpha: v => (+v).toFixed(0) + " %",
  bAlpha: v => (+v).toFixed(0) + " %",
  bbAlpha: v => (+v).toFixed(0) + " %",
  bPadX: v => (+v).toFixed(0) + " %",
  bPadY: v => (+v).toFixed(0) + " %",
  bRad: v => (+v).toFixed(0) + " %",
  bbW: v => (+v).toFixed(1) + " %",
  quality: v => (+v).toFixed(0)
};
function refreshLabels(){
  Object.keys(LABELS).forEach(k => {
    const out = document.getElementById("v-" + k);
    if (out && els[k]) out.textContent = LABELS[k](els[k].value);
  });
}

/* =========================================================================
   書体

   同梱フォントは unicode-range で細かく分けてあるので、
   canvas に描く前に「実際に使う文字」を渡して読み込みを待つ。
   これを怠ると初回だけ代替フォントで描かれてしまう。
   ========================================================================= */
async function ensureGlyphs(){
  await Promise.all(layers.map(L => FontPicker.ensureFor(L.fontId, L.text)));
}

/* =========================================================================
   切り抜き
   ========================================================================= */
function shotGeom(sh, S){
  const w = sh.img.naturalWidth, h = sh.img.naturalHeight;
  const swap = (sh.rot % 180) !== 0;
  const ew = swap ? h : w, eh = swap ? w : h;
  const base = els.fitMode.value === "contain"
    ? Math.min(S / ew, S / eh)
    : Math.max(S / ew, S / eh);
  const k = base * (sh.zoom / 100);
  return { w, h, k, maxX: Math.max(0, (ew * k - S) / 2), maxY: Math.max(0, (eh * k - S) / 2) };
}

function drawShot(ctx, S, sh){
  const g = shotGeom(sh, S);
  ctx.save();
  ctx.translate(S / 2 + (sh.cx / 50) * g.maxX, S / 2 + (sh.cy / 50) * g.maxY);
  ctx.rotate(sh.rot * Math.PI / 180);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sh.img, -g.w * g.k / 2, -g.h * g.k / 2, g.w * g.k, g.h * g.k);
  ctx.restore();
}

/* =========================================================================
   文字を描く

   座布団と縁取りは同じ寸法から出す必要があるので、
   まず「1枚ぶんの寸法」をまとめて測ってから描き始める。
   当たり判定も同じ関数を使うので、見えている枠とつかめる場所がずれない。
   ========================================================================= */
function metrics(ctx, L, S){
  const px = Math.max(1, L.size / 100 * S);
  const font = `${L.bold ? "bold " : ""}${px}px ${FontPicker.cssFamilyOf(L.fontId)}`;
  ctx.font = font;
  const lines = String(L.text == null ? "" : L.text).split("\n");
  const lh = px * L.lineH;
  let w = 0;
  lines.forEach(t => { w = Math.max(w, ctx.measureText(t).width); });
  const padX = px * L.bPadX / 100, padY = px * L.bPadY / 100;
  return {
    px, font, lines, lh, w, h: lh * lines.length, padX, padY,
    boxW: w + padX * 2, boxH: lh * lines.length + padY * 2,
    cx: L.x / 100 * S, cy: L.y / 100 * S
  };
}

function roundRect(ctx, x, y, w, h, r){
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (ctx.roundRect){ ctx.beginPath(); ctx.roundRect(x, y, w, h, rr); return; }
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* 縁取りを1枚の絵にまとめるための下書きの紙。
   出来上がりと同じ大きさで1枚だけ持ち回して使う。 */
let scratchCanvas = null;
function scratch(S){
  if (!scratchCanvas) scratchCanvas = document.createElement("canvas");
  if (scratchCanvas.width !== S || scratchCanvas.height !== S){
    scratchCanvas.width = scratchCanvas.height = S;
  }
  return scratchCanvas;
}

function setTextStyle(g, m){
  g.font = m.font;
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.lineJoin = "round";
  g.miterLimit = 2;
}

function drawLayer(ctx, S, L, marked){
  const m = metrics(ctx, L, S);
  ctx.save();
  ctx.translate(m.cx, m.cy);
  ctx.rotate(L.rot * Math.PI / 180);

  /* 中身と枠線で濃さを別に持つ。
     ひとつの濃さで両方を薄めてしまうと、
     「写真を透かしつつ枠線だけはっきり残す」ができない。 */
  if (L.bOn){
    ctx.save();
    roundRect(ctx, -m.boxW / 2, -m.boxH / 2, m.boxW, m.boxH, m.px * L.bRad / 100);
    ctx.globalAlpha = L.bAlpha / 100;
    ctx.fillStyle = L.bColor;
    ctx.fill();
    if (L.bbOn){
      ctx.globalAlpha = L.bbAlpha / 100;
      ctx.lineWidth = Math.max(0.5, L.bbW / 100 * S);
      ctx.strokeStyle = L.bbColor;
      ctx.stroke();
    }
    ctx.restore();
  }

  setTextStyle(ctx, m);
  const place = (g, t, i) => {
    const lw = g.measureText(t).width;
    return {
      x: L.align === "left" ? -m.w / 2
       : L.align === "right" ? m.w / 2 - lw
       : -lw / 2,
      y: -m.h / 2 + m.lh * (i + 0.5)
    };
  };
  const strokeAll = g => {
    g.lineWidth = L.sW / 100 * S * 2;   // 縁は輪郭の内外に半分ずつ乗るので倍で指定する
    g.strokeStyle = L.sColor;
    m.lines.forEach((t, i) => { const q = place(g, t, i); g.strokeText(t, q.x, q.y); });
  };

  /* 縁取りは字ごと・行ごとに引くので、隣り合う縁は必ず重なる。
     薄くしたいからと globalAlpha を掛けたまま引くと、
     重なったところだけ二度塗りになって濃く出てしまう。
     いったん別の紙に不透明で引いて1枚の絵にしてから、
     まとめて薄くして貼れば、どこも同じ濃さになる。
     透けさせないとき（100%）は重なっても見た目が変わらないので、そのまま引く。 */
  if (L.sOn && L.sW > 0 && L.sAlpha > 0){
    if (L.sAlpha >= 100){
      strokeAll(ctx);
    } else {
      const sc = scratch(S), g = sc.getContext("2d");
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, S, S);
      g.translate(m.cx, m.cy);
      g.rotate(L.rot * Math.PI / 180);
      setTextStyle(g, m);
      strokeAll(g);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = L.sAlpha / 100;
      ctx.drawImage(sc, 0, 0);
      ctx.restore();
    }
  }

  ctx.fillStyle = L.color;
  m.lines.forEach((t, i) => { const q = place(ctx, t, i); ctx.fillText(t, q.x, q.y); });

  if (marked){
    // 選んでいる1枚の目印。明るい背景でも暗い背景でも見えるよう、
    // 黒い破線の上に青い破線をずらして重ねる。
    const w = Math.max(1.5, S / 450);
    ctx.setLineDash([S / 60, S / 60]);
    ctx.lineWidth = w * 2;
    ctx.strokeStyle = "rgba(0,0,0,.45)";
    ctx.strokeRect(-m.boxW / 2, -m.boxH / 2, m.boxW, m.boxH);
    ctx.lineWidth = w;
    ctx.strokeStyle = "rgba(122,162,255,.95)";
    ctx.strokeRect(-m.boxW / 2, -m.boxH / 2, m.boxW, m.boxH);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function drawScene(ctx, S, sh, opts){
  const o = opts || {};
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = els.bgColor.value;
  ctx.fillRect(0, 0, S, S);
  if (sh && sh.img) drawShot(ctx, S, sh);
  layers.forEach((L, i) => drawLayer(ctx, S, L, o.mark === i));
}

function draw(){
  drawScene(vctx, PREVIEW, shots[cur], { mark: sel });
  const sh = shots[cur];
  const S = els.outSize.value;
  els.meta.textContent = sh
    ? `${sh.name} ／ 元 ${sh.img.naturalWidth}×${sh.img.naturalHeight} → ${S}×${S}　文字 ${layers.length}枚`
    : `写真を追加すると、ここに正方形の仕上がりが出ます（${S}×${S}）。`;
  els.panNote.textContent = sh
    ? (shotGeom(sh, PREVIEW).maxX + shotGeom(sh, PREVIEW).maxY > 0.5
        ? "プレビューを指でなぞっても動かせます。"
        : "いまの倍率では動かせる余りがありません。拡大率を上げてください。")
    : "プレビューを指でなぞっても動かせます。";
}

/* =========================================================================
   写真の読み込み
   ========================================================================= */
function shelf(){
  els.shelf.innerHTML = "";
  if (!shots.length){
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "ここに写真をドラッグ＆ドロップ、または「写真を追加…」から。";
    els.shelf.appendChild(d);
    return;
  }
  shots.forEach((s, i) => {
    const c = document.createElement("div");
    c.className = "card" + (i === cur ? " on" : "");
    c.title = s.name;
    const im = document.createElement("img");
    im.src = s.url; im.alt = s.name;
    c.appendChild(im);
    c.addEventListener("click", () => { cur = i; shelf(); syncCrop(); draw(); });
    const x = document.createElement("button");
    x.type = "button"; x.className = "x"; x.textContent = "×"; x.title = "この写真を外す";
    x.addEventListener("click", e => {
      e.stopPropagation();
      URL.revokeObjectURL(s.url);
      shots.splice(i, 1);
      if (cur >= shots.length) cur = shots.length - 1;
      shelf(); syncCrop(); draw();
    });
    c.appendChild(x);
    els.shelf.appendChild(c);
  });
}

function syncCrop(){
  const sh = shots[cur];
  CROP_IDS.forEach(id => els[id].disabled = !sh);
  els.rotL.disabled = els.rotR.disabled = els.cropReset.disabled = !sh;
  if (sh){
    els.zoom.value = sh.zoom;
    els.cropX.value = sh.cx;
    els.cropY.value = sh.cy;
  }
  refreshLabels();
}

async function addFiles(list){
  const files = [...list].filter(f => /^image\//.test(f.type));
  if (!files.length) return;
  for (const f of files){
    const url = URL.createObjectURL(f);
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error("読み込めません"));
        im.src = url;
      });
      shots.push({ name: f.name || "画像", url, img, zoom: 100, cx: 0, cy: 0, rot: 0 });
    } catch (e){
      URL.revokeObjectURL(url);
      warn(`「${f.name}」は読み込めませんでした。`);
    }
  }
  if (cur < 0 && shots.length) cur = 0;
  shelf(); syncCrop(); draw();
}

els.addBtn.addEventListener("click", () => els.file.click());
els.file.addEventListener("change", e => { addFiles(e.target.files); e.target.value = ""; });
els.clearBtn.addEventListener("click", () => {
  if (!shots.length || !confirm("棚の写真を全部消しますか？（文字とプリセットは残ります）")) return;
  shots.forEach(s => URL.revokeObjectURL(s.url));
  shots = []; cur = -1;
  shelf(); syncCrop(); draw();
});

["dragenter","dragover"].forEach(t => els.shelf.addEventListener(t, e => {
  e.preventDefault(); els.shelf.classList.add("over");
}));
["dragleave","drop"].forEach(t => els.shelf.addEventListener(t, e => {
  e.preventDefault(); els.shelf.classList.remove("over");
}));
els.shelf.addEventListener("drop", e => { if (e.dataTransfer) addFiles(e.dataTransfer.files); });
window.addEventListener("paste", e => {
  const items = e.clipboardData && e.clipboardData.files;
  if (items && items.length) addFiles(items);
});

/* 回転は写真ごとの持ち物。90°ずつしか回さないので、
   スマホの縦横が逆に入ってきたときの直しに使う。 */
function rot(d){
  const sh = shots[cur];
  if (!sh) return;
  sh.rot = (sh.rot + d + 360) % 360;
  draw();
}
els.rotL.addEventListener("click", () => rot(-90));
els.rotR.addEventListener("click", () => rot(90));
els.cropReset.addEventListener("click", () => {
  const sh = shots[cur];
  if (!sh) return;
  sh.zoom = 100; sh.cx = 0; sh.cy = 0; sh.rot = 0;
  syncCrop(); draw();
});

/* =========================================================================
   文字の増減
   ========================================================================= */
els.layerAdd.addEventListener("click", () => {
  layers.push(newLayer({ y: 12 + layers.length * 10 }));
  sel = layers.length - 1;
  renderLayerList(); writeLayerIntoControls();
  ensureGlyphs().then(draw);
});
els.layerDup.addEventListener("click", () => {
  if (sel < 0) return;
  layers.splice(sel + 1, 0, tidyLayer(Object.assign({}, layers[sel], { y: layers[sel].y + 8 })));
  sel++;
  renderLayerList(); writeLayerIntoControls();
  ensureGlyphs().then(draw);
});
els.layerDel.addEventListener("click", () => {
  if (sel < 0) return;
  layers.splice(sel, 1);
  sel = Math.min(sel, layers.length - 1);
  renderLayerList(); writeLayerIntoControls(); draw();
});

/* =========================================================================
   つまみの変化

   切り抜きのつまみは「いまの写真」へ、文字のつまみは「いまの1枚」へ書き戻す。
   ========================================================================= */
function onChange(id){
  refreshLabels();
  if (CROP_IDS.includes(id)){
    const sh = shots[cur];
    if (sh){ sh.zoom = +els.zoom.value; sh.cx = +els.cropX.value; sh.cy = +els.cropY.value; }
    draw();
    return;
  }
  if (id in FIELDS){
    readControlsIntoLayer();
    if (id === "tText"){
      renderLayerList();
      ensureGlyphs().then(draw);
      return;
    }
    draw();
    return;
  }
  if (id === "outFmt") els.qualityRow.style.display = els.outFmt.value === "png" ? "none" : "";
  draw();
}
Object.keys(els).forEach(id => {
  const el = els[id];
  if (!el || !el.tagName) return;
  const tag = el.tagName.toLowerCase(), type = el.type;
  if (tag === "textarea" ||
      (tag === "input" && (type === "range" || type === "color" || type === "text")))
    el.addEventListener("input", () => onChange(id));
  else if (tag === "select" || (tag === "input" && type === "checkbox"))
    el.addEventListener("change", () => onChange(id));
});

/* =========================================================================
   プレビューの上での操作

   ・指1本／マウス … 文字をつかんでいれば文字を動かし、そうでなければ写真を動かす
   ・指2本 … ピンチで拡大率
   ・ホイール … 拡大率

   どれも最後はつまみの値を書き換えるだけにしてある。
   ========================================================================= */
function toCanvas(e){
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left) * PREVIEW / r.width,
           y: (e.clientY - r.top) * PREVIEW / r.height };
}

function hitLayer(p){
  for (let i = layers.length - 1; i >= 0; i--){
    const L = layers[i], m = metrics(vctx, L, PREVIEW);
    const a = -L.rot * Math.PI / 180;
    const dx = p.x - m.cx, dy = p.y - m.cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    const w = Math.max(m.boxW, m.w) / 2, h = Math.max(m.boxH, m.h) / 2;
    if (Math.abs(lx) <= w && Math.abs(ly) <= h) return i;
  }
  return -1;
}

const pointers = new Map();
let drag = null;      // { kind:"layer"|"pan", ... }
let pinch = null;     // { dist, zoom }

function setZoom(z){
  const sh = shots[cur];
  if (!sh) return;
  sh.zoom = Math.max(100, Math.min(400, z));
  els.zoom.value = sh.zoom;
  refreshLabels();
  draw();
}

view.addEventListener("pointerdown", e => {
  // 掴んだまま枠の外へ出ても追えるようにする。
  // 捕まえられない種類のポインタもあるので、失敗しても操作は続ける。
  try { view.setPointerCapture(e.pointerId); } catch (err){}
  pointers.set(e.pointerId, e);
  if (pointers.size === 2){
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
              zoom: shots[cur] ? shots[cur].zoom : 100 };
    drag = null;
    return;
  }
  const p = toCanvas(e);
  const i = hitLayer(p);
  if (i >= 0){
    if (i !== sel){ sel = i; renderLayerList(); writeLayerIntoControls(); }
    drag = { kind: "layer", i, dx: layers[i].x - p.x / PREVIEW * 100,
                             dy: layers[i].y - p.y / PREVIEW * 100 };
  } else if (shots[cur]){
    drag = { kind: "pan", px: p.x, py: p.y, cx: shots[cur].cx, cy: shots[cur].cy };
  }
  view.classList.add("dragging");
  draw();
});

view.addEventListener("pointermove", e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, e);

  if (pinch && pointers.size >= 2){
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (pinch.dist > 4) setZoom(pinch.zoom * d / pinch.dist);
    return;
  }
  if (!drag) return;
  const p = toCanvas(e);
  if (drag.kind === "layer"){
    const L = layers[drag.i];
    if (!L) return;
    L.x = Math.max(-20, Math.min(120, drag.dx + p.x / PREVIEW * 100));
    L.y = Math.max(-20, Math.min(120, drag.dy + p.y / PREVIEW * 100));
    if (drag.i === sel){ els.tX.value = L.x; els.tY.value = L.y; refreshLabels(); }
  } else {
    const sh = shots[cur];
    if (!sh) return;
    const g = shotGeom(sh, PREVIEW);
    if (g.maxX > 0) sh.cx = Math.max(-50, Math.min(50, drag.cx + (p.x - drag.px) / g.maxX * 50));
    if (g.maxY > 0) sh.cy = Math.max(-50, Math.min(50, drag.cy + (p.y - drag.py) / g.maxY * 50));
    els.cropX.value = sh.cx; els.cropY.value = sh.cy;
    refreshLabels();
  }
  draw();
});

function release(e){
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!pointers.size){ drag = null; view.classList.remove("dragging"); }
}
view.addEventListener("pointerup", release);
view.addEventListener("pointercancel", release);

view.addEventListener("wheel", e => {
  if (!shots[cur]) return;
  e.preventDefault();
  setZoom(shots[cur].zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06));
}, { passive: false });

/* =========================================================================
   保存
   ========================================================================= */
function baseName(n){
  return (n || "画像").replace(/\.[^.]+$/, "").replace(/[\\\/:*?"<>|]/g, "_").slice(0, 60);
}

async function render(sh){
  const S = +els.outSize.value;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  drawScene(c.getContext("2d"), S, sh, {});
  const png = els.outFmt.value === "png";
  const blob = await new Promise(res => c.toBlob(res,
    png ? "image/png" : "image/jpeg",
    png ? undefined : +els.quality.value / 100));
  return { blob, ext: png ? "png" : "jpg" };
}

function save(blob, name){
  const url = URL.createObjectURL(blob);
  els.dl.href = url;
  els.dl.download = name;
  els.dl.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

els.savePng.addEventListener("click", async () => {
  const sh = shots[cur];
  if (!sh){ els.status.textContent = "先に写真を追加してください。"; return; }
  els.status.textContent = "書き出しています…";
  await ensureGlyphs();
  const r = await render(sh);
  save(r.blob, `${baseName(sh.name)}-square.${r.ext}`);
  els.status.textContent = `保存しました（${Math.round(r.blob.size / 1024)} KB）。`;
});

els.saveAll.addEventListener("click", async () => {
  if (!shots.length){ els.status.textContent = "先に写真を追加してください。"; return; }
  els.saveAll.disabled = els.savePng.disabled = true;
  await ensureGlyphs();
  for (let i = 0; i < shots.length; i++){
    els.status.textContent = `${i + 1} / ${shots.length} 枚目を書き出しています…`;
    const r = await render(shots[i]);
    save(r.blob, `${String(i + 1).padStart(2, "0")}-${baseName(shots[i].name)}-square.${r.ext}`);
    await new Promise(res => setTimeout(res, 450));   // 続けざまに落とすと取りこぼすブラウザがある
  }
  els.status.textContent = `${shots.length}枚を保存しました。`;
  els.saveAll.disabled = els.savePng.disabled = false;
});

/* =========================================================================
   プリセット

   文字の束は操作子1つに収まらないので、まるごと _extra で受け渡す。
   切り抜きは写真ごとの事情なので、覚えるほうがかえって邪魔になる。
   ========================================================================= */
Presets.init({
  key: "masu.presets.v1",
  fileName: "masu-presets.json",
  els,
  skip: [...FIELD_IDS, ...CROP_IDS, "file", "fontFile", "fontSel"],
  ui: { sel: els.presetSel, save: els.presetSave, del: els.presetDel,
        exp: els.presetExport, imp: els.presetImport, file: els.presetFile,
        info: els.presetInfo, dl: els.dl },
  extra: () => ({ layers: layers.map(L => Object.assign({}, L)), sel }),
  applyExtra: x => {
    if (!Array.isArray(x.layers)) return "";
    layers = x.layers.map(tidyLayer);
    let lost = 0;
    layers.forEach(L => { if (!FontPicker.has(L.fontId)){ L.fontId = FontPicker.defaultId; lost++; } });
    sel = layers.length ? Math.min(Math.max(0, x.sel | 0), layers.length - 1) : -1;
    return lost ? `${lost}枚ぶんの書体が見つからないため、同梱フォントに戻しました。` : "";
  },
  onApplied: () => {
    els.qualityRow.style.display = els.outFmt.value === "png" ? "none" : "";
    renderLayerList();
    writeLayerIntoControls();
    ensureGlyphs().then(draw);
  }
});

/* =========================================================================
   起動
   ========================================================================= */
(async () => {
  await FontPicker.init({
    // 値札の文字なので、既定は太い丸ゴシック。
    // はちまるポップは手書き寄りで、出品写真には強すぎる。
    builtins: ["__rxmplus__", "__builtin__"],
    els: { fontSel: els.fontSel, fontAdd: els.fontAdd, fontFile: els.fontFile,
           fontDel: els.fontDel, fontInfo: els.fontInfo },
    onChange: () => {
      const L = layers[sel];
      if (!L) return;
      L.fontId = FontPicker.id;
      ensureGlyphs().then(draw);
    }
  });

  layers = [ newLayer({ text: FIRST_TEXT }) ];
  sel = 0;

  shelf();
  syncCrop();
  renderLayerList();
  writeLayerIntoControls();
  els.qualityRow.style.display = els.outFmt.value === "png" ? "none" : "";
  await ensureGlyphs();
  draw();
})();
