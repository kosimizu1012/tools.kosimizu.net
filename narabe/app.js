"use strict";

/* =========================================================================
   画像並べたらカックイイヤ

   透過PNGのアルファから輪郭を取り、少し外側を点線で囲ってぷるぷる動かす。
   右の傾いた枠では同じ画像をスライドショーで流す。
   ========================================================================= */

const CANVAS_W = 1200, CANVAS_H = 675;

const els = {};
[ "view","meta","status","warn","shelf","addBtn","clearBtn","file","dl",
  "chSize","chX","chY",
  "dOff","dSmooth","dW","dColor","dash","gap","wAmp","wFreq","wKeys","wHold","ants",
  "fX","fY","fW","fH","fRot","fRad","fBg","fZoom","fOX","fOY","fShadow",
  "slFx","slHold","slTrans",
  "tTitle","tSize","tColor","tX","tY","tLine",
  "iText","iSize","iColor","iX","iY","iTilt","tiltNote","overlapHint",
  "fontSel","fontAdd","fontFile","fontDel","fontInfo",
  "fps","oScale","colors","palMode","saveGif","saveMp4","mp4Note","savePng",
  "presetSel","presetSave","presetDel","presetExport","presetImport","presetFile","presetInfo"
].forEach(id => els[id] = document.getElementById(id));

const view = els.view, vctx = view.getContext("2d", { willReadFrequently: true });

let slides = [];          // { name, url, img, field, work, contour }
let backImg = null;
let seed = 12345;
let playTimer = null, playFrame = 0;

/* =========================================================================
   素材の読み込み
   ========================================================================= */
function warn(msg){
  els.warn.textContent = msg;
  els.warn.classList.toggle("on", !!msg);
}

/* Web配信なので素材は普通のファイルとして読める。
   同一オリジンなら canvas が汚染されないので、GIF書き出しもそのまま通る。 */
async function loadAssets(){
  backImg = await new Promise(res => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = "back.png";
  });
  if (!backImg) warn("背景画像（back.png）を読み込めませんでした。");
}

function titleFont(px){ return `${px}px ${FontPicker.cssFamily()}`; }

/* 同梱フォントは unicode-range で細かく分けてあるので、
   canvas に描く前に「実際に使う文字」を渡して読み込みを待つ。
   これを怠ると初回だけ代替フォントで描かれてしまう。 */
async function ensureGlyphs(){
  const p = readParams();
  await FontPicker.ensure((p.title || "") + (p.id || ""));
}

/* =========================================================================
   乱数
   ========================================================================= */
function mulberry32(a){
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =========================================================================
   輪郭抽出

   1) 透過PNGを作業解像度に縮小してアルファのマスクを作る
   2) 外側方向の距離変換（チャンファー 1 / √2 の2パス）
   3) 指定距離のところで2値化し、境界を追跡して閉ループを得る
   4) 等間隔に取り直して平滑化

   距離場は画像ごとに1回だけ作り、外側の距離を変えたときは
   2値化から先だけをやり直す。
   ========================================================================= */
const WORK_MAX = 360;

function buildField(img){
  const k = Math.min(1, WORK_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;

  const INF = 1e9;
  const dist = new Float32Array(w * h);
  let any = false;
  for (let i = 0, p = 0; p < w * h; p++, i += 4){
    if (d[i + 3] > 24){ dist[p] = 0; any = true; } else dist[p] = INF;
  }
  if (!any) return null;

  const D1 = 1, D2 = Math.SQRT2;
  for (let y = 0; y < h; y++){
    for (let x = 0; x < w; x++){
      const p = y * w + x;
      let v = dist[p];
      if (x > 0)            v = Math.min(v, dist[p - 1] + D1);
      if (y > 0)            v = Math.min(v, dist[p - w] + D1);
      if (x > 0 && y > 0)   v = Math.min(v, dist[p - w - 1] + D2);
      if (x < w-1 && y > 0) v = Math.min(v, dist[p - w + 1] + D2);
      dist[p] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--){
    for (let x = w - 1; x >= 0; x--){
      const p = y * w + x;
      let v = dist[p];
      if (x < w-1)              v = Math.min(v, dist[p + 1] + D1);
      if (y < h-1)              v = Math.min(v, dist[p + w] + D1);
      if (x < w-1 && y < h-1)   v = Math.min(v, dist[p + w + 1] + D2);
      if (x > 0 && y < h-1)     v = Math.min(v, dist[p + w - 1] + D2);
      dist[p] = v;
    }
  }
  return { dist, w, h };
}

/* 8近傍の境界追跡。左に空きがある画素から始め、左回りに探して時計回りに舐める */
const DX8 = [1, 1, 0, -1, -1, -1, 0, 1];
const DY8 = [0, 1, 1, 1, 0, -1, -1, -1];

function traceLoops(mask, w, h, minLen){
  const seen = new Uint8Array(w * h);
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h) ? mask[y * w + x] : 0;
  const loops = [];

  for (let y = 0; y < h; y++){
    for (let x = 0; x < w; x++){
      const p = y * w + x;
      if (!mask[p] || seen[p] || at(x - 1, y)) continue;   // 外周の左端だけを起点にする
      let cx = x, cy = y, dir = 0;
      const pts = [];
      const limit = w * h * 4;
      let steps = 0;
      do {
        pts.push(cx, cy);
        seen[cy * w + cx] = 1;
        let found = false;
        for (let k = 0; k < 8; k++){
          const nd = (dir + 5 + k) % 8;                    // 直前の向きから左に切ってから時計回り
          const nx = cx + DX8[nd], ny = cy + DY8[nd];
          if (at(nx, ny)){ cx = nx; cy = ny; dir = nd; found = true; break; }
        }
        if (!found) break;
      } while ((cx !== x || cy !== y) && ++steps < limit);
      if (pts.length / 2 >= minLen) loops.push(pts);
    }
  }
  return loops;
}

/* 閉ループを等間隔に取り直す */
function resample(pts, step){
  const n = pts.length / 2;
  const acc = [0];
  for (let i = 1; i <= n; i++){
    const a = ((i - 1) % n) * 2, b = (i % n) * 2;
    acc.push(acc[i - 1] + Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1]));
  }
  const total = acc[n];
  const count = Math.max(16, Math.round(total / step));
  const out = new Float32Array(count * 2);
  let seg = 0;
  for (let i = 0; i < count; i++){
    const target = total * i / count;
    while (seg < n && acc[seg + 1] < target) seg++;
    const segLen = acc[seg + 1] - acc[seg] || 1;
    const t = (target - acc[seg]) / segLen;
    const a = (seg % n) * 2, b = ((seg + 1) % n) * 2;
    out[i * 2]     = pts[a]     + (pts[b]     - pts[a])     * t;
    out[i * 2 + 1] = pts[a + 1] + (pts[b + 1] - pts[a + 1]) * t;
  }
  return out;
}

/* 閉ループを [1,2,1] で平滑化 */
function smoothLoop(p, passes){
  const n = p.length / 2;
  let cur = p;
  for (let s = 0; s < passes; s++){
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++){
      const a = ((i - 1 + n) % n) * 2, b = i * 2, c = ((i + 1) % n) * 2;
      out[b]     = (cur[a]     + 2 * cur[b]     + cur[c])     / 4;
      out[b + 1] = (cur[a + 1] + 2 * cur[b + 1] + cur[c + 1]) / 4;
    }
    cur = out;
  }
  return cur;
}

/* 距離場から、外側 off の位置を通る輪郭（作業解像度の座標）を作る */
function extractContour(field, off, smooth){
  const { dist, w, h } = field;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = dist[i] <= off ? 1 : 0;
  const loops = traceLoops(mask, w, h, 24);
  if (!loops.length) return [];
  // 大きい順に、明らかな主輪郭だけを残す
  loops.sort((a, b) => b.length - a.length);
  const keep = loops.filter(l => l.length >= loops[0].length * 0.12).slice(0, 6);
  return keep.map(l => smoothLoop(resample(l, 2.2), smooth));
}

/* =========================================================================
   点線の揺れ

   輪郭に沿って周期的な滑らかノイズを作り、各点を法線方向にずらす。
   ループの先頭と末尾がつながるよう、制御点を巡回で補間する。
   ========================================================================= */
function makeWobble(count, ctrl, rnd){
  const a = new Float32Array(ctrl), b = new Float32Array(ctrl);
  for (let i = 0; i < ctrl; i++){ a[i] = rnd() * 2 - 1; b[i] = rnd() * 2 - 1; }
  const sample = (arr, u) => {
    const x = u * ctrl;
    const i0 = Math.floor(x) % ctrl, i1 = (i0 + 1) % ctrl;
    let t = x - Math.floor(x);
    t = t * t * (3 - 2 * t);
    return arr[i0] + (arr[i1] - arr[i0]) * t;
  };
  const A = new Float32Array(count), B = new Float32Array(count);
  for (let i = 0; i < count; i++){
    A[i] = sample(a, i / count);
    B[i] = sample(b, i / count);
  }
  return { A, B };
}

/* =========================================================================
   タイムライン
   ========================================================================= */
function timeline(p){
  const n = Math.max(1, slides.length);
  const D = p.frameMs;
  const hold = Math.max(1, Math.round(p.hold / D));
  const trans = (n < 2 || p.fx === "none") ? 0 : Math.max(1, Math.round(p.trans / D));
  const per = hold + trans;
  let total = (n < 2 || p.fx === "none") ? hold : n * per;

  // 揺れの1周期ぶんのコマ数。ここで割り切れないとループの継ぎ目で点線が飛ぶ
  const W = p.keys * 2 - 2 > 0 ? p.keys * 2 - 2 : 2;   // 往復の周期
  const cycle = W * p.wHold;
  if (total % cycle) total += cycle - (total % cycle);
  return { total, hold, trans, per, W, cycle, n };
}

/* 点線の揺れは「1コマ」とは別の速さで進める。
   コマを細かくしても点線だけはゆっくり揺らせるようにするため。 */
function wobblePhase(k, tl, p){
  return Math.floor(k / p.wHold) % tl.W;
}

/* k コマ目の状態（どの画像を、どれだけ動かして出すか） */
function frameState(k, tl, p){
  if (tl.trans === 0) return { a: 0, b: 0, t: 0 };
  const idx = Math.floor(k / tl.per) % tl.n;
  const within = k % tl.per;
  if (within < tl.hold) return { a: idx, b: idx, t: 0 };
  const t = (within - tl.hold + 1) / tl.trans;
  return { a: idx, b: (idx + 1) % tl.n, t: Math.min(1, t) };
}

/* =========================================================================
   1コマの描画
   ========================================================================= */
function roundRect(ctx, x, y, w, h, r){
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* 枠の中に画像を「はみ出す前提」で置く */
function drawSlideImage(ctx, img, fw, fh, p, shiftX, alpha){
  if (!img) return;
  const k = Math.max(fw / img.naturalWidth, fh / img.naturalHeight) * (p.zoom / 100);
  const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
  const ox = (p.ox / 100) * fw, oy = (p.oy / 100) * fh;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, -dw / 2 + ox + shiftX, -dh / 2 + oy, dw, dh);
  ctx.restore();
}

function drawFrame(ctx, k, p, tl){
  ctx.save();
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // 背景
  if (backImg) ctx.drawImage(backImg, 0, 0, CANVAS_W, CANVAS_H);
  else { ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H); }

  const st = frameState(k, tl, p);
  const cur = slides.length ? slides[st.a] : null;
  const nxt = slides.length ? slides[st.b] : null;

  /* ---- 右の枠（スライドショー） ---- */
  if (slides.length){
    ctx.save();
    ctx.translate(p.fX, p.fY);
    ctx.rotate(p.fRot * Math.PI / 180);
    if (p.shadow){
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,.35)";
      ctx.shadowBlur = 26; ctx.shadowOffsetY = 8;
      ctx.fillStyle = p.fBg;
      roundRect(ctx, -p.fW / 2, -p.fH / 2, p.fW, p.fH, p.fRad);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = p.fBg;
    roundRect(ctx, -p.fW / 2, -p.fH / 2, p.fW, p.fH, p.fRad);
    ctx.fill();
    ctx.save();
    roundRect(ctx, -p.fW / 2, -p.fH / 2, p.fW, p.fH, p.fRad);
    ctx.clip();
    if (st.t === 0 || p.fx === "none"){
      drawSlideImage(ctx, cur.img, p.fW, p.fH, p, 0, 1);
    } else if (p.fx === "fade"){
      drawSlideImage(ctx, cur.img, p.fW, p.fH, p, 0, 1 - st.t);
      drawSlideImage(ctx, nxt.img, p.fW, p.fH, p, 0, st.t);
    } else {
      const e = st.t < .5 ? 2 * st.t * st.t : 1 - Math.pow(-2 * st.t + 2, 2) / 2;  // ease-in-out
      drawSlideImage(ctx, cur.img, p.fW, p.fH, p, -e * p.fW, 1);
      drawSlideImage(ctx, nxt.img, p.fW, p.fH, p, (1 - e) * p.fW, 1);
    }
    ctx.restore();
    ctx.restore();
  }

  /* ---- 左のキャラと点線 ---- */
  const leftSlide = slides.length ? slides[0] : null;   // 左は常に1枚目
  if (leftSlide){
    const img = leftSlide.img;
    const k2 = p.chSize / Math.max(img.naturalWidth, img.naturalHeight);
    const dw = img.naturalWidth * k2, dh = img.naturalHeight * k2;
    const dx = p.chX - dw / 2, dy = p.chY - dh / 2;

    // 点線（キャラの下に敷くと絵に重ならない）
    const loops = leftSlide.contour;
    if (loops && loops.length){
      const fw = leftSlide.field.w, fh = leftSlide.field.h;
      const sx = dw / fw, sy = dh / fh;
      const phase = 2 * Math.PI * wobblePhase(k, tl, p) / tl.W;
      const cosP = Math.cos(phase), sinP = Math.sin(phase);

      ctx.save();
      ctx.strokeStyle = p.dColor;
      ctx.lineWidth = p.dW;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.setLineDash([p.dash, p.gap]);
      // 1周期で破線1つぶん進む。tl.total は周期の倍数なのでループが繋がる
      ctx.lineDashOffset = p.ants ? -(k * (p.dash + p.gap) / tl.cycle) : 0;

      loops.forEach((loop, li) => {
        const n = loop.length / 2;
        const wob = leftSlide.wobble[li];
        ctx.beginPath();
        for (let i = 0; i <= n; i++){
          const j = i % n;
          const a = ((j - 1 + n) % n) * 2, c = ((j + 1) % n) * 2;
          // 法線（隣接点の差分に垂直）
          let nx = -(loop[c + 1] - loop[a + 1]), ny = loop[c] - loop[a];
          const len = Math.hypot(nx, ny) || 1;
          nx /= len; ny /= len;
          const d = p.wAmp * (wob.A[j] * cosP + wob.B[j] * sinP);
          const px = dx + (loop[j * 2]     + nx * d / sx) * sx;
          const py = dy + (loop[j * 2 + 1] + ny * d / sy) * sy;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      });
      ctx.restore();
    }
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  /* ---- 文字 ---- */
  if (p.title){
    ctx.save();
    ctx.font = titleFont(p.tSize);
    ctx.fillStyle = p.tColor;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(p.title, p.tX, p.tY);
    if (p.tLine){
      const wpx = ctx.measureText(p.title).width;
      ctx.strokeStyle = p.tColor;
      ctx.lineWidth = Math.max(2, p.tSize * 0.06);
      ctx.lineCap = "round";
      ctx.beginPath();
      // 手書き感を出すため、わずかに反った線にする
      ctx.moveTo(p.tX - 4, p.tY + p.tSize * 0.26);
      ctx.quadraticCurveTo(p.tX + wpx / 2, p.tY + p.tSize * 0.36, p.tX + wpx + 6, p.tY + p.tSize * 0.22);
      ctx.stroke();
    }
    ctx.restore();
  }

  if (p.id){
    ctx.save();
    ctx.font = titleFont(p.iSize);
    ctx.fillStyle = p.iColor;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    // 右の枠と傾きをそろえる場合は、文字の右端を軸に回す
    ctx.translate(CANVAS_W - p.iX, p.iY);
    if (p.iTilt) ctx.rotate(p.fRot * Math.PI / 180);
    ctx.fillText(p.id, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}

/* =========================================================================
   設定の読み取り
   ========================================================================= */
function readParams(){
  return {
    chSize: +els.chSize.value, chX: +els.chX.value, chY: +els.chY.value,
    dOff: +els.dOff.value, dSmooth: +els.dSmooth.value,
    dW: +els.dW.value, dColor: els.dColor.value,
    dash: +els.dash.value, gap: +els.gap.value,
    wAmp: +els.wAmp.value, wFreq: +els.wFreq.value, keys: +els.wKeys.value,
    wHold: +els.wHold.value, ants: els.ants.checked,
    fX: +els.fX.value, fY: +els.fY.value, fW: +els.fW.value, fH: +els.fH.value,
    fRot: +els.fRot.value, fRad: +els.fRad.value, fBg: els.fBg.value,
    zoom: +els.fZoom.value, ox: +els.fOX.value, oy: +els.fOY.value,
    shadow: els.fShadow.checked,
    fx: els.slFx.value, hold: +els.slHold.value, trans: +els.slTrans.value,
    title: els.tTitle.value, tSize: +els.tSize.value, tColor: els.tColor.value,
    tX: +els.tX.value, tY: +els.tY.value, tLine: els.tLine.checked,
    id: els.iText.value, iSize: +els.iSize.value, iColor: els.iColor.value,
    iX: +els.iX.value, iY: +els.iY.value, iTilt: els.iTilt.checked,
    frameMs: +els.fps.value, scale: +els.oScale.value, colors: +els.colors.value,
    palMode: els.palMode.value
  };
}

/* =========================================================================
   プレビュー
   ========================================================================= */
let curTL = null, curP = null;

function stopPlay(){ if (playTimer){ clearInterval(playTimer); playTimer = null; } }

function refresh(){
  const p = readParams();
  curP = p;
  curTL = timeline(p);
  stopPlay();
  playFrame = 0;
  drawFrame(vctx, 0, p, curTL);
  if (curTL.total > 1){
    playTimer = setInterval(() => {
      playFrame = (playFrame + 1) % curTL.total;
      drawFrame(vctx, playFrame, curP, curTL);
    }, p.frameMs);
  }
  const secs = (curTL.total * p.frameMs / 1000).toFixed(2);
  els.meta.textContent = slides.length
    ? `${slides.length}枚 ／ ${curTL.total}コマ ／ 1周 ${secs}秒 ／ 出力 ${Math.round(CANVAS_W*p.scale)}×${Math.round(CANVAS_H*p.scale)}`
    : "画像を追加してください。";
  els.saveGif.disabled = !slides.length;
  els.savePng.disabled = !slides.length;
  checkOverlap(p);
}

/* 凸多角形どうしの重なり判定（分離軸法）。
   IDも枠も傾くので、軸に平行な矩形の比較では足りない。 */
function overlapConvex(A, B){
  for (const poly of [A, B]){
    for (let i = 0; i < poly.length; i++){
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      const nx = -(by - ay), ny = bx - ax;                 // 辺の法線
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const [x, y] of A){ const d = x*nx + y*ny; if (d<minA) minA=d; if (d>maxA) maxA=d; }
      for (const [x, y] of B){ const d = x*nx + y*ny; if (d<minB) minB=d; if (d>maxB) maxB=d; }
      if (maxA < minB || maxB < minA) return false;        // この軸で離れている
    }
  }
  return true;
}

/* 傾きを含めた、枠とIDそれぞれの四隅を返す */
function frameQuad(p){
  const c = Math.cos(p.fRot * Math.PI / 180), s = Math.sin(p.fRot * Math.PI / 180);
  return [[-p.fW/2,-p.fH/2],[p.fW/2,-p.fH/2],[p.fW/2,p.fH/2],[-p.fW/2,p.fH/2]]
    .map(([x, y]) => [p.fX + x*c - y*s, p.fY + x*s + y*c]);
}

function idQuad(p){
  vctx.save(); vctx.font = titleFont(p.iSize);
  const tw = vctx.measureText(p.id).width;
  vctx.restore();
  const ang = p.iTilt ? p.fRot * Math.PI / 180 : 0;
  const c = Math.cos(ang), s = Math.sin(ang);
  const ax = CANVAS_W - p.iX, ay = p.iY;                   // 右端・ベースラインが回転の軸
  return [[-tw, -p.iSize], [0, -p.iSize], [0, p.iSize*0.25], [-tw, p.iSize*0.25]]
    .map(([x, y]) => [ax + x*c - y*s, ay + x*s + y*c]);
}

/* IDが右の枠に重なっていないかを見て知らせる */
function checkOverlap(p){
  if (!slides.length || !p.id){ els.overlapHint.textContent = ""; els.tiltNote.textContent = ""; return; }
  els.tiltNote.textContent = p.iTilt
    ? `いまの傾き ${p.fRot}°（右の枠と同じ）`
    : "傾きなし（水平）";

  const hit = overlapConvex(frameQuad(p), idQuad(p));
  els.overlapHint.textContent = hit
    ? "⚠ IDが右の枠に重なっています。縦位置を上げるか、枠を下げてください。"
    : "";
  els.overlapHint.style.color = hit ? "#ffd479" : "";
}

/* =========================================================================
   画像の受け取り
   ========================================================================= */
function renderShelf(){
  els.shelf.innerHTML = "";
  if (!slides.length){
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "透過PNGをドロップ／クリックで追加";
    els.shelf.appendChild(d);
    return;
  }
  slides.forEach((s, i) => {
    const c = document.createElement("div");
    c.className = "card";
    const im = document.createElement("img"); im.src = s.url; im.alt = s.name;
    const n = document.createElement("span"); n.className = "n"; n.textContent = i + 1;
    const x = document.createElement("button");
    x.className = "x"; x.type = "button"; x.textContent = "×"; x.title = "削除";
    x.addEventListener("click", ev => {
      ev.stopPropagation();
      URL.revokeObjectURL(s.url);
      slides.splice(i, 1);
      renderShelf(); refresh();
    });
    c.append(im, n, x);
    els.shelf.appendChild(c);
  });
}

function prepareSlide(s, p){
  s.field = buildField(s.img);
  if (!s.field){ s.contour = []; s.wobble = []; return; }
  rebuildContour(s, p);
}

/* 外側の距離・なめらかさが変わったら輪郭だけ作り直す */
function rebuildContour(s, p){
  if (!s.field) return;
  // 画面上の px を作業解像度の単位に直す
  const drawn = p.chSize / Math.max(s.img.naturalWidth, s.img.naturalHeight)
              * Math.max(s.field.w, s.field.h);
  const scale = Math.max(s.field.w, s.field.h) / Math.max(1, drawn);
  s.contour = extractContour(s.field, p.dOff * scale, p.dSmooth);
  const rnd = mulberry32(seed + 977);
  s.wobble = s.contour.map(l => makeWobble(l.length / 2, Math.max(3, p.wFreq), rnd));
}

function addFiles(list){
  const files = [...list].filter(f => f.type.startsWith("image/"))
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  if (!files.length) return;
  const slots = new Array(files.length).fill(null);
  let pending = files.length;
  const done = () => {
    if (--pending > 0) return;
    const p = readParams();
    slots.filter(Boolean).forEach(s => { prepareSlide(s, p); slides.push(s); });
    renderShelf(); refresh();
  };
  files.forEach((f, i) => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload  = () => { slots[i] = { name: f.name, url, img }; done(); };
    img.onerror = () => { URL.revokeObjectURL(url); done(); };
    img.src = url;
  });
}

els.addBtn.addEventListener("click", () => els.file.click());
els.file.addEventListener("change", e => { addFiles(e.target.files); e.target.value = ""; });
els.clearBtn.addEventListener("click", () => {
  slides.forEach(s => URL.revokeObjectURL(s.url));
  slides = [];
  renderShelf(); refresh();
});
["dragenter","dragover"].forEach(t =>
  els.shelf.addEventListener(t, e => { e.preventDefault(); els.shelf.classList.add("over"); }));
["dragleave","drop"].forEach(t =>
  els.shelf.addEventListener(t, e => { e.preventDefault(); els.shelf.classList.remove("over"); }));
els.shelf.addEventListener("drop", e => addFiles(e.dataTransfer.files));
window.addEventListener("paste", e => {
  const imgs = [...e.clipboardData.items].filter(i => i.type.startsWith("image/"));
  if (imgs.length) addFiles(imgs.map(i => i.getAsFile()).filter(Boolean));
});

/* =========================================================================
   操作の配線
   ========================================================================= */
const LABELS = {
  chSize: v => `${v} px`, chX: v => v, chY: v => v,
  dOff: v => `${v} px`, dSmooth: v => v, dW: v => (+v).toFixed(1),
  dash: v => v, gap: v => v, wAmp: v => `${(+v).toFixed(1)} px`, wFreq: v => v, wKeys: v => v,
  wHold: v => `${v * (+els.fps.value)} ms`,
  fX: v => v, fY: v => v, fW: v => v, fH: v => v,
  fRot: v => `${v}°`, fRad: v => v, fZoom: v => `${v} %`, fOX: v => v, fOY: v => v,
  slHold: v => `${v} ms`, slTrans: v => `${v} ms`,
  tSize: v => v, tX: v => v, tY: v => v,
  iSize: v => v, iX: v => v, iY: v => v, fps: v => `${v} ms`
};
// 輪郭を作り直す必要がある操作
const RECONTOUR = new Set(["dOff","dSmooth","chSize","wFreq"]);

function refreshLabels(){
  Object.keys(LABELS).forEach(k => {
    const out = document.getElementById("v-" + k);
    if (out && els[k]) out.textContent = LABELS[k](els[k].value);
  });
}

/* 輪郭を作り直してから描き直す（プリセット適用時にも使う） */
function rebuildAll(){
  const p = readParams();
  slides.forEach(s => rebuildContour(s, p));
  refresh();
}

let debounce = null;
function onChange(id){
  refreshLabels();
  // 文字を打ち替えたら、その字が使える状態になってから描き直す
  if (id === "tTitle" || id === "iText"){
    ensureGlyphs().then(refresh);
    return;
  }
  if (RECONTOUR.has(id)){
    clearTimeout(debounce);
    debounce = setTimeout(rebuildAll, 120);
  } else {
    refresh();
  }
}
Object.keys(els).forEach(id => {
  const el = els[id];
  if (!el || !el.tagName) return;
  const tag = el.tagName.toLowerCase(), type = el.type;
  if (tag === "input" && (type === "range" || type === "color" || type === "text"))
    el.addEventListener("input", () => onChange(id));
  else if (tag === "select" || (tag === "input" && type === "checkbox"))
    el.addEventListener("change", () => onChange(id));
});

/* =========================================================================
   起動
   ========================================================================= */
(async () => {
  await loadAssets();
  await FontPicker.init({
    els: { fontSel: els.fontSel, fontAdd: els.fontAdd, fontFile: els.fontFile,
           fontDel: els.fontDel, fontInfo: els.fontInfo },
    // 書体を変えたら、その書体で字が使えるようにしてから描き直す
    onChange: () => ensureGlyphs().then(refresh)
  });
  await ensureGlyphs();
  renderShelf();
  refresh();
})();

/* =========================================================================
   書き出しの手順
   ========================================================================= */
const yieldToUI = () => new Promise(r => setTimeout(r, 0));

async function buildGif(){
  const p = readParams();
  const tl = timeline(p);
  const w = Math.round(CANVAS_W * p.scale), h = Math.round(CANVAS_H * p.scale);

  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const paint = k => {
    ctx.setTransform(p.scale, 0, 0, p.scale, 0, 0);
    drawFrame(ctx, k, p, tl);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return ctx.getImageData(0, 0, w, h).data;
  };

  // どのコマがどの絵柄かでまとめる。
  // 表示中は「そのスライドだけ」、切り替え中は「2枚が混ざった状態」で色が違うので、
  // まとまりごとに専用のパレットを作る。GIFはコマごとに色表を持てる。
  //
  // 色味の違う絵を1つのパレットで賄うと、どの絵にも色が足りずグラデーションが縞になる。
  // 実測では全コマ共有で255色中155色しか使えず、
  // まとまりごとに分けると221色まで使えて誤差が半分以下になった。
  // 切り替え中は2枚の絵が同時に映り、しかも混ざり具合がコマごとに変わる。
  // ひとまとめのパレットでは両方を賄いきれず、表示中のコマより階調が粗くなるので、
  // 切り替え中だけは1コマずつ専用のパレットにする。
  const groupOf = p.palMode === "shared" ? () => "all" : k => {
    const st = frameState(k, tl, p);
    return st.t === 0 ? `s${st.a}` : `t${st.a}-${st.b}-${k}`;
  };
  const groups = new Map();
  for (let k = 0; k < tl.total; k++){
    const gk = groupOf(k);
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(k);
  }

  els.status.textContent = "色を調べています…";
  await yieldToUI();
  const TARGET = 60000;
  const maxColors = Math.min(255, p.colors);

  const palOfGroup = new Map();
  let gi = 0;
  for (const [gk, ks] of groups){
    // まとまりの中から数コマ選んで色を拾う
    const probeCount = Math.min(ks.length, 4);
    const stride = Math.max(1, Math.round(w * h * probeCount / TARGET));
    // 輪郭は間引いて拾う。段が見えるのはなめらかな面なので、色をそちらへ回す
    const samples = [];
    for (let i = 0; i < probeCount; i++){
      const d = paint(ks[Math.round(i * (ks.length - 1) / Math.max(1, probeCount - 1))]);
      GIF.collectSamples(d, w, h, Math.round(w * h / stride),
                         { into: samples, edgeWeight: 0.25 });
    }
    const pal = GIF.paletteFromSamples(samples, maxColors);
    palOfGroup.set(gk, { pal, match: GIF.makeMatcher(pal) });
    els.status.textContent = `色を調べています… ${++gi}/${groups.size}`;
    await yieldToUI();
  }


  // 描き直して減色する。
  // 表示中は点線の揺れが変わらない限り絵が同じなので、
  // 「何コマ目か」ではなく「絵の内容」で使い回す。
  const frames = [], framePals = [];
  const cache = new Map();
  let painted = 0;
  for (let k = 0; k < tl.total; k++){
    const st = frameState(k, tl, p);
    const { pal, match } = palOfGroup.get(groupOf(k));
    const sig = [st.a, st.b, st.t.toFixed(5),
                 wobblePhase(k, tl, p), p.ants ? k % tl.cycle : 0].join("|");
    let idx = cache.get(sig);
    if (!idx){
      const d = paint(k);
      idx = GIF.quantize(new Uint8ClampedArray(d.buffer), w, h, pal, match, -1, false);
      cache.set(sig, idx);
      painted++;
      if (painted % 4 === 0){
        els.status.textContent = `コマを変換しています… ${k + 1}/${tl.total}`;
        await yieldToUI();
      }
    }
    frames.push(idx);
    framePals.push(pal);
  }
  els.status.textContent = `コマを変換しています… ${tl.total}/${tl.total}`;
  await yieldToUI();

  els.status.textContent = "GIFにまとめています…";
  await yieldToUI();
  const delays = frames.map(() => p.frameMs);
  const bytes = GIF.encode(w, h, framePals, frames, delays, { optimize: true });
  return { bytes, w, h, count: frames.length, drawn: cache.size,
           palettes: palOfGroup.size, pal: maxColors };
}

els.saveGif.addEventListener("click", async () => {
  if (!slides.length) return;
  els.saveGif.disabled = true;
  try {
    const r = await buildGif();
    const blob = new Blob([r.bytes], { type: "image/gif" });
    const url = URL.createObjectURL(blob);
    els.dl.href = url;
    els.dl.download = "narabetara.gif";
    els.dl.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    els.status.textContent =
      `完了：${(r.bytes.length / 1024).toFixed(0)} KB`
      + `（${r.w}×${r.h}、${r.count}コマ／実描画${r.drawn}枚、`
      + `${r.pal}色×${r.palettes}組）`;
  } catch (e){
    console.error(e);
    els.status.textContent = "エラー: " + e.message;
  } finally {
    els.saveGif.disabled = false;
  }
});

els.savePng.addEventListener("click", () => {
  if (!slides.length) return;
  const p = readParams(), tl = timeline(p);
  const w = Math.round(CANVAS_W * p.scale), h = Math.round(CANVAS_H * p.scale);
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.setTransform(p.scale, 0, 0, p.scale, 0, 0);
  drawFrame(ctx, playFrame % tl.total, p, tl);
  cv.toBlob(b => {
    const url = URL.createObjectURL(b);
    els.dl.href = url; els.dl.download = "narabetara.png"; els.dl.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    els.status.textContent = `PNGを保存しました（${w}×${h}）`;
  }, "image/png");
});

/* =========================================================================
   プリセット（共通モジュールを使う）
   ========================================================================= */
Presets.init({
  key: "narabe.presets.v1",
  fileName: "narabe-presets.json",
  els,
  skip: ["file", "fontFile", "fontSel"],
  ui: { sel: els.presetSel, save: els.presetSave, del: els.presetDel,
        exp: els.presetExport, imp: els.presetImport, file: els.presetFile,
        info: els.presetInfo, dl: els.dl },
  // 書体は FontPicker が持っているので、別に受け渡す
  extra: () => ({ fontId: FontPicker.id }),
  applyExtra: x => {
    if (!x.fontId) return "";
    const missing = !FontPicker.has(x.fontId);
    FontPicker.id = x.fontId;
    return missing ? "保存時の書体が見つからないため、同梱フォントに戻しました。" : "";
  },
  onApplied: () => { ensureGlyphs().then(rebuildAll); refreshLabels(); }
});

/* =========================================================================
   MP4（動画）で書き出す

   GIFと違って256色の制限が無いため、グラデーションの段が出ない。
   透過は扱えないが、この道具の出力は背景が不透明なので問題にならない。
   ========================================================================= */
(async () => {
  const ok = await MP4.available();
  if (!ok){
    els.saveMp4.disabled = true;
    els.mp4Note.textContent = "このブラウザは動画の書き出しに対応していません。GIFをお使いください。";
    return;
  }
})();

els.saveMp4.addEventListener("click", async () => {
  if (!slides.length) return;
  els.saveMp4.disabled = true;
  els.status.textContent = "動画を作っています…";
  try {
    const p = readParams();
    const tl = timeline(p);
    const w = Math.round(CANVAS_W * p.scale), h = Math.round(CANVAS_H * p.scale);
    const [vw, vh] = MP4.evenSize(w, h);

    const cv = document.createElement("canvas");
    cv.width = vw; cv.height = vh;
    const ctx = cv.getContext("2d");

    const t0 = performance.now();
    const r = await MP4.encode({
      width: w, height: h, count: tl.total,
      delays: Array.from({ length: tl.total }, () => p.frameMs),
      draw: k => {
        ctx.setTransform(p.scale, 0, 0, p.scale, 0, 0);
        drawFrame(ctx, k, p, tl);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        return cv;
      },
      onProgress: (i, n) => { els.status.textContent = `動画を作っています… ${i}/${n}`; }
    });

    const blob = new Blob([r.bytes], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);
    els.dl.href = url;
    els.dl.download = "narabetara.mp4";
    els.dl.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    const secs = (tl.total * p.frameMs / 1000).toFixed(1);
    els.status.textContent =
      `完了：${(r.bytes.length / 1024).toFixed(0)} KB（${r.width}×${r.height}、`
      + `${r.frames}コマ、${secs}秒、${((performance.now() - t0) / 1000).toFixed(1)}秒で作成）`;
  } catch (e){
    console.error(e);
    els.status.textContent = "エラー: " + e.message;
  } finally {
    els.saveMp4.disabled = false;
  }
});
