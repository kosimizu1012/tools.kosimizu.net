
"use strict";

/* =======================================================================
   状態
   ======================================================================= */
const els = {};
["drop","view","hint","file","meta","status","save","reseed","dl","cycle",
 "amp","uniform","grid","rot","scl","motion","keys","delay","perFrameOn","perFrame","keepOrig",
 "size","pad","colors","bgmode","dither",
 "bgImageRow","bgGrid","bgFolderBtn","bgfit","bgfile","bgClear",
 "bgTintRow","bgTint","bgink","bgpaper","tintInfo",
 "knockout","knockRow","knockT","knockInfo",
 "bgWarp","bgHint","swatches",
 "presetSel","presetSave","presetDel","presetExport","presetImport","presetFile","presetInfo"
].forEach(id => els[id] = document.getElementById(id));
els.bglib = document.getElementById("v-bglib");

let srcImage = null;      // 読み込んだ Image
let srcName  = "image";
let bgImage  = null;      // 登録した背景画像
let srcHasAlpha = false;  // 前景に透過部分があるか（背景が見えるかの判定用）
let seed     = (Math.random() * 1e9) | 0;

let uniqueFrames = [];    // キーフレーム（ImageData）
let order        = [];    // 再生順（uniqueFrames への添字）
let delays       = [];    // order と同じ長さの表示時間(ms)
let manual       = [];    // コマごとの手動表示時間(ms)

let playPos = 0, playTimer = null;
let renderToken = 0;

/* =======================================================================
   乱数（シード固定）
   ======================================================================= */
function mulberry32(a){
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =======================================================================
   ゆらぎ場：粗い格子の乱数を smoothstep 補間して滑らかな変位場にする

   格子点には「ランダムな向きの単位ベクトル」を置く。x,y を独立に取ると
   場所によって長さが大きくばらつき、画面の一部だけ強く揺れて見えるため。
   ======================================================================= */
function makeDirField(gw, gh, rnd){
  const n = (gw + 1) * (gh + 1);
  const fx = new Float32Array(n), fy = new Float32Array(n);
  for (let i = 0; i < n; i++){
    const a = rnd() * Math.PI * 2;
    fx[i] = Math.cos(a); fy[i] = Math.sin(a);
  }
  return { fx, fy };
}
function sampleField(f, gw, gh, u, v){
  const x = u * gw, y = v * gh;
  const x0 = Math.min(gw - 1, Math.max(0, Math.floor(x)));
  const y0 = Math.min(gh - 1, Math.max(0, Math.floor(y)));
  let tx = x - x0, ty = y - y0;
  tx = tx * tx * (3 - 2 * tx);          // smoothstep
  ty = ty * ty * (3 - 2 * ty);
  const i0 = y0 * (gw + 1) + x0, i1 = i0 + (gw + 1);
  const a = f[i0] + (f[i0 + 1] - f[i0]) * tx;
  const b = f[i1] + (f[i1 + 1] - f[i1]) * tx;
  return a + (b - a) * ty;
}

/* =======================================================================
   変位の下地：格子の場を画素解像度に展開し、長さのムラをならす。

   補間後の長さ m を、均一さ U に応じて REF に寄せる：
     scale = (m(1-U) + REF*U) / max(m, FLOOR)
   U=0 なら素通し、U=1 なら長さが REF で一定になる。
   最後に 1/REF を掛けるので、U をどこにしても平均の移動量は「揺れの強さ」px のまま。
   ======================================================================= */
const REF = 0.7, FLOOR = 0.15;

function buildBasis(w, h, fields, uniformity){
  const n = w * h;
  const X1 = new Float32Array(n), Y1 = new Float32Array(n);
  const X2 = new Float32Array(n), Y2 = new Float32Array(n);
  const { gw, gh, a, b } = fields;
  const gain = 1 / REF;

  for (let y = 0; y < h; y++){
    const v = h > 1 ? y / (h - 1) : 0;
    for (let x = 0; x < w; x++){
      const u = w > 1 ? x / (w - 1) : 0;
      const i = y * w + x;

      let dx = sampleField(a.fx, gw, gh, u, v), dy = sampleField(a.fy, gw, gh, u, v);
      let m = Math.sqrt(dx * dx + dy * dy);
      let s = (m * (1 - uniformity) + REF * uniformity) / Math.max(m, FLOOR) * gain;
      X1[i] = dx * s; Y1[i] = dy * s;

      dx = sampleField(b.fx, gw, gh, u, v); dy = sampleField(b.fy, gw, gh, u, v);
      m = Math.sqrt(dx * dx + dy * dy);
      s = (m * (1 - uniformity) + REF * uniformity) / Math.max(m, FLOOR) * gain;
      X2[i] = dx * s; Y2[i] = dy * s;
    }
  }
  return { X1, Y1, X2, Y2 };
}

/* =======================================================================
   1コマ分の歪み描画（逆写像＋バイリニア、アルファは事前乗算して滲み防止）
   wCos / wSin で2つの変位場を混ぜる。往復は wSin=0 の単純往復になる。
   ======================================================================= */
function warpFrame(src, w, h, basis, wCos, wSin, p){
  const out = new ImageData(w, h);
  const S = src.data, D = out.data;
  const cx = w / 2, cy = h / 2;

  // 全体のわずかな回転・拡縮（変位と同期しすぎないよう少しずらす）
  const ang   = p.rot * Math.PI / 180 * (wCos * 0.45 + wSin * 0.89);
  const scale = 1 + p.scl / 100 * (wCos * -0.67 + wSin * 0.74);
  const ca = Math.cos(-ang) / scale, sa = Math.sin(-ang) / scale;

  const { X1, Y1, X2, Y2 } = basis;
  const amp = p.amp;

  for (let y = 0; y < h; y++){
    for (let x = 0; x < w; x++){
      const i = y * w + x;

      let dx = 0, dy = 0;
      if (amp > 0){
        dx = amp * (X1[i] * wCos + X2[i] * wSin);
        dy = amp * (Y1[i] * wCos + Y2[i] * wSin);
      }

      // 逆アフィン変換で参照元を求める
      const ox = x - cx - dx, oy = y - cy - dy;
      let sx = cx + ox * ca - oy * sa;
      let sy = cy + ox * sa + oy * ca;

      // clamp（端の内容を引き伸ばす。透過画像なら端は透明のまま）
      if (sx < 0) sx = 0; else if (sx > w - 1) sx = w - 1;
      if (sy < 0) sy = 0; else if (sy > h - 1) sy = h - 1;

      const x0 = sx | 0, y0 = sy | 0;
      const x1 = x0 + 1 < w ? x0 + 1 : x0;
      const y1 = y0 + 1 < h ? y0 + 1 : y0;
      const fx = sx - x0, fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy,       w11 = fx * fy;

      const i00 = (y0 * w + x0) << 2, i10 = (y0 * w + x1) << 2;
      const i01 = (y1 * w + x0) << 2, i11 = (y1 * w + x1) << 2;

      const a00 = S[i00 + 3], a10 = S[i10 + 3], a01 = S[i01 + 3], a11 = S[i11 + 3];
      const a = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;

      const o = (y * w + x) << 2;
      if (a < 0.5){ D[o] = D[o+1] = D[o+2] = D[o+3] = 0; continue; }

      // 事前乗算してから補間 → 透明部の黒がにじむのを防ぐ
      const r = S[i00]  *a00*w00 + S[i10]  *a10*w10 + S[i01]  *a01*w01 + S[i11]  *a11*w11;
      const g = S[i00+1]*a00*w00 + S[i10+1]*a10*w10 + S[i01+1]*a01*w01 + S[i11+1]*a11*w11;
      const b = S[i00+2]*a00*w00 + S[i10+2]*a10*w10 + S[i01+2]*a01*w01 + S[i11+2]*a11*w11;

      D[o]     = r / a;
      D[o + 1] = g / a;
      D[o + 2] = b / a;
      D[o + 3] = a;
    }
  }
  return out;
}

/* =======================================================================
   タイミング組み立て
   ======================================================================= */
function readParams(){
  return {
    amp:    parseFloat(els.amp.value),
    uniform: parseInt(els.uniform.value, 10) / 100,
    grid:   parseInt(els.grid.value, 10),
    rot:    parseFloat(els.rot.value),
    scl:    parseFloat(els.scl.value),
    motion: els.motion.value,
    keys:   parseInt(els.keys.value, 10),
    delay:  parseInt(els.delay.value, 10),
    perFrame: els.perFrameOn.checked,
    keep:   els.keepOrig.checked,
    size:   parseInt(els.size.value, 10),
    pad:    Math.max(0, Math.min(64, parseInt(els.pad.value, 10) || 0)),
    colors: parseInt(els.colors.value, 10),
    bgmode: (els.bgmode.value === "image" && !bgImage) ? "white" : els.bgmode.value,
    bgfit:  els.bgfit.value,
    bgTint: els.bgTint.checked,
    bgink:  els.bgink.value,
    bgpaper:els.bgpaper.value,
    bgWarp: els.bgWarp.checked,
    knockout: els.knockout.checked,
    knockT: parseInt(els.knockT.value, 10),
    dither: els.dither.checked
  };
}

/* キーフレームの重み（変位場の混ぜ具合）を返す */
function keyWeights(p){
  const out = [];
  for (let i = 0; i < p.keys; i++){
    if (p.motion === "loop"){
      const ph = 2 * Math.PI * i / p.keys;     // 一周して必ず元に戻る
      out.push([Math.cos(ph), Math.sin(ph)]);
    } else {
      // 往復：位相 0→π を等分。両端が折り返し点になる
      const ph = p.keys > 1 ? Math.PI * i / (p.keys - 1) : 0;
      out.push([Math.cos(ph), 0]);
    }
  }
  return out;
}

/* 再生順（キーフレームへの添字）。往復は端を重複させずに折り返す */
function playOrder(p){
  const o = [];
  for (let i = 0; i < p.keys; i++) o.push(i);
  if (p.motion === "pingpong"){
    for (let i = p.keys - 2; i >= 1; i--) o.push(i);
  }
  return o;
}

/* 各出力コマの表示時間(ms) */
function frameDelays(p, ord){
  return ord.map(i => {
    const v = p.perFrame ? manual[i] : p.delay;
    return Math.max(20, Math.min(5000, v || p.delay));
  });
}

/* =======================================================================
   コマ生成
   ======================================================================= */
/* 出力サイズを決める */
function outputSize(p){
  const iw = srcImage.naturalWidth, ih = srcImage.naturalHeight;
  let dw = iw, dh = ih;
  if (p.size > 0 && Math.max(iw, ih) > p.size){
    const k = p.size / Math.max(iw, ih);
    dw = Math.max(1, Math.round(iw * k));
    dh = Math.max(1, Math.round(ih * k));
  }
  return { dw, dh, w: dw + p.pad * 2, h: dh + p.pad * 2 };
}

/* =======================================================================
   背景画像の色替え

   方眼紙のような「紙 + 線」の画像を、紙色と線色に塗り分け直す。
   輝度のヒストグラムから紙側（明るい方）と線側（暗い方）の代表値を取り、
   各画素の「インク濃度」を 0..1 に正規化してから2色間で補間する。
   これで、罫線がちょうど指定色に、紙がちょうど指定色になる。
   ======================================================================= */
function hexToRgb(hex){
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function tintBackground(cv, w, h, paperHex, inkHex){
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;

  // 輝度ヒストグラム
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4){
    hist[(d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0]++;
  }
  const total = w * h;
  const at = frac => {
    let acc = 0, target = total * frac;
    for (let L = 0; L < 256; L++){ acc += hist[L]; if (acc >= target) return L; }
    return 255;
  };
  const Lpaper = at(0.97);            // 紙は面積が大きいので上位側
  const Link   = at(0.01);            // 線は少数派なので下位側
  const span   = Lpaper - Link;
  if (span < 8) return { ok: false, Lpaper, Link };   // 濃淡がなく塗り分けられない

  const [pr, pg, pb] = hexToRgb(paperHex);
  const [ir, ig, ib] = hexToRgb(inkHex);

  // 輝度 → インク濃度 は256通りしかないので先に引き算表を作る
  const tr = new Uint8Array(256), tg = new Uint8Array(256), tb = new Uint8Array(256);
  for (let L = 0; L < 256; L++){
    let a = (Lpaper - L) / span;
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    tr[L] = pr + (ir - pr) * a;
    tg[L] = pg + (ig - pg) * a;
    tb[L] = pb + (ib - pb) * a;
  }
  for (let i = 0; i < d.length; i += 4){
    const L = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    d[i] = tr[L]; d[i + 1] = tg[L]; d[i + 2] = tb[L];
  }
  ctx.putImageData(id, 0, 0);
  return { ok: true, Lpaper, Link };
}

/* =======================================================================
   前景の白抜き

   外周から届く「白い領域」だけを塗りつぶし方式で透明にする。
   全画素を一律に判定すると顔や瞳の白まで抜けてしまうため、
   外周とつながっているかどうかで区別する。
   ======================================================================= */
function knockoutWhite(imgData, w, h, thr){
  const d = imgData.data;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;

  const white = i => {
    const o = i << 2;
    return d[o + 3] > 8 && d[o] >= thr && d[o + 1] >= thr && d[o + 2] >= thr;
  };
  const push = i => { if (!seen[i]){ seen[i] = 1; if (white(i)) stack[sp++] = i; } };

  for (let x = 0; x < w; x++){ push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++){ push(y * w); push(y * w + w - 1); }

  let removed = 0;
  while (sp > 0){
    const i = stack[--sp];
    const x = i % w, y = (i / w) | 0;
    d[(i << 2) + 3] = 0;
    removed++;
    if (x > 0)     push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0)     push(i - w);
    if (y < h - 1) push(i + w);
  }

  // 消した領域に接する縁は白が半分残るので、白さに応じてアルファを落とす
  const soft = Math.max(1, 255 - thr);
  for (let y = 0; y < h; y++){
    for (let x = 0; x < w; x++){
      const i = y * w + x, o = i << 2;
      if (d[o + 3] === 0) continue;
      const touching =
        (x > 0     && d[((i - 1) << 2) + 3] === 0) ||
        (x < w - 1 && d[((i + 1) << 2) + 3] === 0) ||
        (y > 0     && d[((i - w) << 2) + 3] === 0) ||
        (y < h - 1 && d[((i + w) << 2) + 3] === 0);
      if (!touching) continue;
      const L = Math.min(d[o], d[o + 1], d[o + 2]);
      if (L <= thr) continue;
      d[o + 3] = d[o + 3] * (1 - (L - thr) / soft);
    }
  }
  return removed;
}

/* 背景（白 or 画像）を描いたキャンバス。透過モードなら null */
function makeBackground(p, w, h){
  if (p.bgmode === "alpha") return null;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";

  // 画像が収まらない部分は紙の色で埋める
  ctx.fillStyle = (p.bgmode === "image" && p.bgTint) ? p.bgpaper : "#ffffff";
  ctx.fillRect(0, 0, w, h);

  if (p.bgmode === "image" && bgImage){
    const iw = bgImage.naturalWidth, ih = bgImage.naturalHeight;
    if (p.bgfit === "stretch"){
      ctx.drawImage(bgImage, 0, 0, w, h);
    } else if (p.bgfit === "tile"){
      ctx.fillStyle = ctx.createPattern(bgImage, "repeat");
      ctx.fillRect(0, 0, w, h);
    } else {
      const k = p.bgfit === "contain"
        ? Math.min(w / iw, h / ih)
        : Math.max(w / iw, h / ih);          // cover
      const dw = iw * k, dh = ih * k;
      ctx.drawImage(bgImage, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
    if (p.bgTint) lastTint = tintBackground(cv, w, h, p.bgpaper, p.bgink);
  }
  return cv;
}
let lastTint = null;      // 色替えが成立したかの記録（案内文に使う）

/* 揺らす対象。背景も揺らす場合はここで背景を焼き込む */
function prepareSource(p){
  const { dw, dh, w, h } = outputSize(p);
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  // 白抜きは前景だけに掛けたいので、先に前景を単独で描いて処理する
  let fg = srcImage, fw = dw, fh = dh;
  if (p.knockout){
    const t = document.createElement("canvas");
    t.width = dw; t.height = dh;
    const tc = t.getContext("2d", { willReadFrequently: true });
    tc.imageSmoothingQuality = "high";
    tc.drawImage(srcImage, 0, 0, dw, dh);
    const fgData = tc.getImageData(0, 0, dw, dh);
    lastKnock = knockoutWhite(fgData, dw, dh, p.knockT);
    tc.putImageData(fgData, 0, 0);
    fg = t; fw = dw; fh = dh;
  } else {
    lastKnock = -1;
  }

  if (p.bgWarp){
    const bg = makeBackground(p, w, h);
    if (bg) ctx.drawImage(bg, 0, 0);
  }
  ctx.drawImage(fg, p.pad, p.pad, fw, fh);
  return { data: ctx.getImageData(0, 0, w, h), w, h };
}
let lastKnock = -1;       // 白抜きで消した画素数（案内文に使う）

/* 歪ませた前景を、静止した背景の上に重ねる */
const compo = { fg: document.createElement("canvas"), out: document.createElement("canvas") };
function overBackground(frame, bg, w, h){
  compo.fg.width = w; compo.fg.height = h;
  compo.fg.getContext("2d").putImageData(frame, 0, 0);
  compo.out.width = w; compo.out.height = h;
  const ctx = compo.out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bg, 0, 0);
  ctx.drawImage(compo.fg, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}

function buildFrames(p){
  const { data, w, h } = prepareSource(p);
  const rnd = mulberry32(seed);
  const gw = p.grid, gh = Math.max(2, Math.round(p.grid * h / Math.max(1, w)));
  const fields = { gw, gh, a: makeDirField(gw, gh, rnd), b: makeDirField(gw, gh, rnd) };
  const basis = buildBasis(w, h, fields, p.uniform);
  const weights = keyWeights(p);

  let list = weights.map(([wc, ws], i) =>
    (i === 0 && p.keep) ? data : warpFrame(data, w, h, basis, wc, ws, p)
  );

  // 背景を揺らさない場合は、歪ませたあとに静止背景と合成する
  if (!p.bgWarp){
    const bg = makeBackground(p, w, h);
    if (bg) list = list.map(f => overBackground(f, bg, w, h));
  }
  return { list, w, h };
}

/* =======================================================================
   プレビュー
   ======================================================================= */
const view = els.view, vctx = view.getContext("2d");

function stopPlay(){ if (playTimer){ clearTimeout(playTimer); playTimer = null; } }

/* 表示時間がコマごとに違うので setTimeout をつなぐ */
function startPlay(){
  stopPlay();
  if (order.length < 2) return;
  const tick = () => {
    playPos = (playPos + 1) % order.length;
    vctx.putImageData(uniqueFrames[order[playPos]], 0, 0);
    playTimer = setTimeout(tick, GIF.delayUnits(delays[playPos]) * 10);
  };
  playTimer = setTimeout(tick, GIF.delayUnits(delays[playPos]) * 10);
}

let debounce = null;
function scheduleRender(){
  if (!srcImage) return;
  clearTimeout(debounce);
  debounce = setTimeout(render, 140);
}

/* コマ生成をやり直さず、タイミングだけ差し替える（スピード調整を軽くする） */
function retime(){
  const p = readParams();
  order  = playOrder(p);
  delays = frameDelays(p, order);
  updateCycle(p);
  if (uniqueFrames.length){
    if (playPos >= order.length) playPos = 0;
    startPlay();
  }
}

function updateCycle(p){
  if (!order.length){ els.cycle.textContent = "—"; return; }
  const total = delays.reduce((a, d) => a + GIF.delayUnits(d) * 10, 0);
  const fps = order.length / (total / 1000);
  els.cycle.innerHTML =
    `1周 <b>${total} ms</b>（${(total/1000).toFixed(2)}秒）／ 全 <b>${order.length}</b> コマ ／ ${fps.toFixed(1)} fps`;
}

function render(){
  if (!srcImage) return;
  const token = ++renderToken;
  const p = readParams();
  els.meta.textContent = "生成中…";
  setTimeout(() => {
    if (token !== renderToken) return;
    const built = buildFrames(p);
    if (token !== renderToken) return;

    uniqueFrames = built.list;
    order  = playOrder(p);
    delays = frameDelays(p, order);

    view.width = built.w; view.height = built.h;
    view.hidden = false;
    view.classList.toggle("checker", p.bgmode === "alpha");
    playPos = 0;
    vctx.putImageData(uniqueFrames[0], 0, 0);
    startPlay();
    updateCycle(p);

    els.save.disabled = false;
    syncBgUI();                       // 色替え・白抜きの結果を案内に反映
    const heavy = built.w * built.h > 1600000;
    els.meta.textContent =
      `${built.w} × ${built.h} px ／ 元画像 ${srcImage.naturalWidth}×${srcImage.naturalHeight}`
      + (heavy ? "　⚠ サイズが大きいため生成に数秒かかります" : "");
  }, 0);
}

/* =======================================================================
   書き出し
   ======================================================================= */
els.save.addEventListener("click", () => {
  if (!uniqueFrames.length) return;
  els.save.disabled = true;
  els.status.textContent = "減色しています…";
  setTimeout(() => {
    try {
      const p = readParams();
      const w = view.width, h = view.height;
      const useAlpha = p.bgmode === "alpha";

      // パレットは1コマ目から1回だけ作り、全コマで共有する（コマ間の色ちらつき防止）
      const maxColors = useAlpha ? p.colors - 1 : p.colors;
      const samples = GIF.collectSamples(uniqueFrames[0].data, w, h, 50000);
      const pal = GIF.paletteFromSamples(samples, maxColors);
      const transIdx = useAlpha ? pal.length : -1;
      const palOut   = useAlpha ? pal.concat([[0, 0, 0]]) : pal;
      const match    = GIF.makeMatcher(pal);

      // キーフレームごとに1回だけ減色し、往復の折り返しでは使い回す
      const indexedUnique = uniqueFrames.map((f, i) => {
        els.status.textContent = `コマ ${i + 1}/${uniqueFrames.length} を変換中…`;
        return GIF.quantize(f.data, w, h, pal, match, transIdx, p.dither);
      });
      const indexed = order.map(i => indexedUnique[i]);

      els.status.textContent = "GIFを書き出しています…";
      // 透過GIFのときは本当の透過が要るので差分最適化は使えない
      const bytes = GIF.encode(w, h, palOut, indexed, delays,
                               { alphaIndex: transIdx, optimize: !useAlpha });
      const blob = new Blob([bytes], { type: "image/gif" });
      const url = URL.createObjectURL(blob);
      els.dl.href = url;
      els.dl.download = srcName.replace(/\.[^.]+$/, "") + "_ugoku.gif";
      els.dl.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      const total = delays.reduce((a, d) => a + GIF.delayUnits(d) * 10, 0);
      els.status.textContent =
        `完了：${(bytes.length/1024).toFixed(0)} KB（${w}×${h}、${indexed.length}コマ、1周 ${total}ms）`;
    } catch (e){
      console.error(e);
      els.status.textContent = "エラー: " + e.message;
    } finally {
      els.save.disabled = false;
    }
  }, 0);
});

/* =======================================================================
   画像の読み込み
   ======================================================================= */
/* 透過部分があるか（縮小して走査。背景が見えるかの案内に使うだけ） */
function detectAlpha(img){
  const s = 96;
  const k = Math.min(1, s / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

function loadFile(file){
  if (!file || !file.type.startsWith("image/")) return;
  srcName = file.name || "image";
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    srcImage = img;
    srcHasAlpha = detectAlpha(img);
    els.hint.style.display = "none";
    els.drop.classList.add("has");
    els.status.textContent = "";
    syncBgUI();
    render();
  };
  img.onerror = () => { URL.revokeObjectURL(url); els.meta.textContent = "画像を読み込めませんでした"; };
  img.src = url;
}

els.drop.addEventListener("click", () => els.file.click());
els.file.addEventListener("change", e => { loadFile(e.target.files[0]); e.target.value = ""; });

["dragenter","dragover"].forEach(t =>
  els.drop.addEventListener(t, e => { e.preventDefault(); els.drop.classList.add("over"); }));
["dragleave","drop"].forEach(t =>
  els.drop.addEventListener(t, e => { e.preventDefault(); els.drop.classList.remove("over"); }));
els.drop.addEventListener("drop", e => loadFile(e.dataTransfer.files[0]));

window.addEventListener("paste", e => {
  for (const item of e.clipboardData.items){
    if (item.type.startsWith("image/")){ loadFile(item.getAsFile()); break; }
  }
});

/* =======================================================================
   背景 UI
   ======================================================================= */
/* 線の色として選びやすい色 */
const SWATCHES = ["#8fc7f0","#f0a0b8","#a8d8a8","#e0c070","#b0a0e0","#909090","#333333","#d06060"];

function buildSwatches(){
  SWATCHES.forEach(hex => {
    const b = document.createElement("button");
    b.type = "button"; b.style.background = hex; b.title = `線の色を ${hex} に`;
    b.addEventListener("click", () => {
      els.bgink.value = hex;
      els.bgTint.checked = true;      // 色を選んだら色替えを有効に
      syncBgUI(); scheduleRender();
    });
    els.swatches.appendChild(b);
  });
}

function syncBgUI(){
  const mode = els.bgmode.value;
  els.bgImageRow.classList.toggle("off", mode !== "image");
  els.bgTintRow.classList.toggle("off", mode !== "image");
  els.knockRow.classList.toggle("off", !els.knockout.checked);
  document.getElementById("v-bgink").textContent   = els.bgink.value.toUpperCase();
  document.getElementById("v-bgpaper").textContent = els.bgpaper.value.toUpperCase();
  document.getElementById("v-knockT").textContent  = els.knockT.value;

  // 色替えが成立したか
  let tint = "";
  if (mode === "image" && els.bgTint.checked && lastTint){
    tint = lastTint.ok
      ? `紙 ${lastTint.Lpaper} / 線 ${lastTint.Link} の濃淡を検出して塗り替えました。`
      : "濃淡の差が小さく、色を塗り分けられませんでした。";
  }
  els.tintInfo.textContent = tint;

  // 白抜きの結果
  els.knockInfo.textContent = (els.knockout.checked && lastKnock >= 0)
    ? `外周から ${lastKnock.toLocaleString()} 画素を透過にしました。`
    : "";

  // 背景が見えるかどうかの案内
  let hint = "";
  if (mode === "image" && !bgImage){
    hint = "背景が未選択です。選ぶまで白として扱います。";
  } else if (mode === "alpha"){
    hint = "透過GIFに対応していないSNSもあります。迷ったら白。";
  } else if (mode === "image" && srcImage && !srcHasAlpha && !els.knockout.checked){
    hint = "この画像には透過部分がないため、背景が完全に隠れます。"
         + "「白い背景を透過にする」をオンにするか、余白を広げてください。";
  }
  els.bgHint.textContent = hint;
}

/* ---- 背景ライブラリ ------------------------------------------------------
   Web公開版では backgrounds/manifest.json を読んで最初から一覧を出す。
   同一オリジンなので canvas は汚染されず、GIF書き出しもそのまま通る。
   自前の画像はドラッグ＆ドロップやファイル選択で足せる。
   -------------------------------------------------------------------------*/
let bgLibrary = [];       // { name, url, img }
let bgIndex   = -1;       // 選択中の添字。-1 は未選択

/* 同梱の背景を読み込む。manifest.json が無ければ何もしない（自前の追加は使える） */
async function loadBundledBackgrounds(){
  let list;
  try {
    const res = await fetch("backgrounds/manifest.json", { cache: "no-cache" });
    if (!res.ok) return;
    list = await res.json();
  } catch (e){ return; }
  if (!Array.isArray(list) || !list.length) return;

  const slots = await Promise.all(list.map(entry => new Promise(res => {
    const name = typeof entry === "string" ? entry : entry.file;
    const label = (typeof entry === "object" && entry.name) ? entry.name : name;
    const url = "backgrounds/" + name;
    const img = new Image();
    img.onload  = () => res({ name: label, url, img });
    img.onerror = () => res(null);
    img.src = url;
  })));
  const ok = slots.filter(Boolean);
  if (!ok.length) return;
  bgLibrary = ok.concat(bgLibrary);      // 同梱ぶんを先頭に置く
  renderBgGrid();
  syncBgUI();
}

function renderBgGrid(){
  els.bgGrid.innerHTML = "";
  if (!bgLibrary.length){
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "ここに画像をドロップすると背景に使えます";
    els.bgGrid.appendChild(d);
  } else {
    bgLibrary.forEach((item, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.title = `${item.name}（${item.img.naturalWidth}×${item.img.naturalHeight}）`;
      b.classList.toggle("sel", i === bgIndex);
      const im = document.createElement("img");
      im.src = item.url; im.alt = item.name;
      b.appendChild(im);
      b.addEventListener("click", () => selectBg(i));
      els.bgGrid.appendChild(b);
    });
  }
  els.bglib.textContent = bgLibrary.length ? `${bgLibrary.length}枚` : "未読み込み";
}

function selectBg(i){
  bgIndex = i;
  bgImage = i >= 0 ? bgLibrary[i].img : null;
  if (i >= 0) els.bgmode.value = "image";
  renderBgGrid(); syncBgUI();
  if (srcImage) render(); else scheduleRender();
}

/* 画像ファイル群をライブラリへ追加。全部読み終わってから1回だけ描き直す */
function addBgFiles(fileList){
  const files = [...fileList]
    .filter(f => f.type.startsWith("image/"))
    .sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, "ja"));
  if (!files.length){
    els.bgHint.textContent = "画像ファイルが見つかりませんでした。";
    return;
  }
  // 読み込み完了はバラバラの順で返るので、席を先に確保してファイル名順を保つ
  const firstNew = bgLibrary.length;
  const slots = new Array(files.length).fill(null);
  let pending = files.length;
  const done = () => {
    if (--pending > 0) return;
    bgLibrary = bgLibrary.concat(slots.filter(Boolean));
    if (bgIndex < 0 && bgLibrary.length > firstNew) selectBg(firstNew);   // 最初の1枚を自動選択
    else { renderBgGrid(); syncBgUI(); }
  };
  files.forEach((f, i) => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload  = () => { slots[i] = { name: f.name, url, img }; done(); };
    img.onerror = () => { URL.revokeObjectURL(url); done(); };
    img.src = url;
  });
}

els.bgFolderBtn.addEventListener("click", () => els.bgfile.click());
els.bgfile.addEventListener("change", e => { addBgFiles(e.target.files); e.target.value = ""; });

["dragenter","dragover"].forEach(t =>
  els.bgGrid.addEventListener(t, e => { e.preventDefault(); e.stopPropagation(); els.bgGrid.classList.add("over"); }));
["dragleave","drop"].forEach(t =>
  els.bgGrid.addEventListener(t, e => { e.preventDefault(); e.stopPropagation(); els.bgGrid.classList.remove("over"); }));
els.bgGrid.addEventListener("drop", e => { e.stopPropagation(); addBgFiles(e.dataTransfer.files); });

els.bgClear.addEventListener("click", e => {
  e.stopPropagation();
  bgIndex = -1; bgImage = null;
  els.bgmode.value = "white";
  renderBgGrid(); syncBgUI(); scheduleRender();
});

els.bgmode.addEventListener("change", () => { syncBgUI(); scheduleRender(); });
els.bgfit.addEventListener("change", scheduleRender);
els.bgWarp.addEventListener("change", () => { syncBgUI(); scheduleRender(); });
els.bgTint.addEventListener("change", () => { syncBgUI(); scheduleRender(); });
[els.bgink, els.bgpaper].forEach(el => el.addEventListener("input", () => {
  els.bgTint.checked = true;
  syncBgUI(); scheduleRender();
}));
els.knockout.addEventListener("change", () => { syncBgUI(); scheduleRender(); });
els.knockT.addEventListener("input", () => { syncBgUI(); scheduleRender(); });

/* =======================================================================
   コマごとの表示時間 UI
   ======================================================================= */
function rebuildPerFrame(){
  const n = parseInt(els.keys.value, 10);
  const base = parseInt(els.delay.value, 10);
  const old = manual.slice();
  manual = [];
  for (let i = 0; i < n; i++) manual.push(old[i] != null ? old[i] : base);

  els.perFrame.innerHTML = "";
  for (let i = 0; i < n; i++){
    const row = document.createElement("div");
    row.className = "fr";
    const lab = document.createElement("label");
    lab.textContent = `コマ ${i + 1}`;
    const inp = document.createElement("input");
    inp.type = "number"; inp.min = "20"; inp.max = "5000"; inp.step = "10";
    inp.value = manual[i];
    inp.addEventListener("input", () => {
      manual[i] = parseInt(inp.value, 10) || base;
      retime();                     // コマは作り直さずタイミングだけ更新
    });
    row.appendChild(lab); row.appendChild(inp);
    els.perFrame.appendChild(row);
  }
}

els.perFrameOn.addEventListener("change", () => {
  els.perFrame.classList.toggle("on", els.perFrameOn.checked);
  if (els.perFrameOn.checked) rebuildPerFrame();
  retime();
});

/* =======================================================================
   UI 配線
   ======================================================================= */
const labelUpdaters = [];
function bindLabel(id, fmt, onInput){
  const el = els[id], out = document.getElementById("v-" + id);
  const upd = () => { if (out) out.textContent = fmt(el.value); };
  labelUpdaters.push(upd);
  el.addEventListener("input", () => { upd(); onInput(); });
  upd();
}
function refreshLabels(){ labelUpdaters.forEach(f => f()); }
bindLabel("amp",     v => `${parseFloat(v).toFixed(2)} px`, scheduleRender);
bindLabel("uniform", v => `${v} %`,                         scheduleRender);
bindLabel("grid",    v => v,                                scheduleRender);
bindLabel("rot",  v => `${parseFloat(v).toFixed(2)}°`,   scheduleRender);
bindLabel("scl",  v => `${parseFloat(v).toFixed(1)} %`,  scheduleRender);

// コマ数は絵の作り直しが要る
bindLabel("keys", v => v, () => { rebuildPerFrame(); scheduleRender(); });

// スピードは絵を作り直さなくてよいので即反映
bindLabel("delay", v => `${v} ms`, () => {
  if (!els.perFrameOn.checked) manual = manual.map(() => parseInt(els.delay.value, 10));
  retime();
});

els.motion.addEventListener("change", scheduleRender);
["keepOrig","size","pad","colors","dither"].forEach(id =>
  els[id].addEventListener("change", scheduleRender));

els.reseed.addEventListener("click", () => { seed = (Math.random() * 1e9) | 0; render(); });

/* =======================================================================
   プリセット（共通モジュールに、このツール固有の状態を渡す）
   ======================================================================= */
Presets.init({
  key: "puru.presets.v1",
  fileName: "ugoku-presets.json",
  els,
  skip: ["file", "bgfile", "bgfolder"],
  ui: { sel: els.presetSel, save: els.presetSave, del: els.presetDel,
        exp: els.presetExport, imp: els.presetImport, file: els.presetFile,
        info: els.presetInfo, dl: els.dl },

  // 操作子以外に覚えておきたいもの
  extra: () => ({
    seed,
    manual: manual.slice(),
    bgName: bgIndex >= 0 ? bgLibrary[bgIndex].name : null
  }),

  applyExtra: x => {
    if (typeof x.seed === "number") seed = x.seed;
    if (Array.isArray(x.manual)) manual = x.manual.slice();
    rebuildPerFrame();
    els.perFrame.classList.toggle("on", els.perFrameOn.checked);
    // 背景は名前で選び直す
    if (x.bgName){
      const i = bgLibrary.findIndex(b => b.name === x.bgName);
      if (i >= 0){ bgIndex = i; bgImage = bgLibrary[i].img; }
      else {
        bgIndex = -1; bgImage = null;
        return `背景「${x.bgName}」が見つかりませんでした。残りの設定は適用しています。`;
      }
    } else { bgIndex = -1; bgImage = null; }
    return "";
  },

  onApplied: () => {
    refreshLabels();
    renderBgGrid();
    syncBgUI();
    if (srcImage) render();
  }
});

buildSwatches();
renderBgGrid();
syncBgUI();
rebuildPerFrame();
loadBundledBackgrounds();
