"use strict";

/* =========================================================================
   共通のGIF書き出し（tools.kosimizu.net）

   2つのツールで透過の使い道が違うので、そこを1つにまとめてある。

     ・「画像動かすゾウ」の透過GIF
         → 透過インデックスは“本当に透ける画素”。廃棄方法2で毎コマ消す。
     ・「画像並べたらカックイイヤ」の差分最適化
         → 透過インデックスは“前のコマと同じ”という意味。廃棄方法1で残す。

   1つのインデックスに両方の意味は持たせられないので、
   本当の透過が要るときは差分最適化を切る、という規則にしている。
   ========================================================================= */

const GIF = (() => {

  class Bytes {
    constructor(){ this.buf = new Uint8Array(1 << 16); this.len = 0; }
    need(n){
      if (this.len + n <= this.buf.length) return;
      let cap = this.buf.length;
      while (cap < this.len + n) cap *= 2;
      const nb = new Uint8Array(cap); nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
    }
    u8(v){ this.need(1); this.buf[this.len++] = v & 0xff; }
    u16(v){ this.need(2); this.buf[this.len++] = v & 0xff; this.buf[this.len++] = (v >> 8) & 0xff; }
    raw(a){ this.need(a.length); this.buf.set(a, this.len); this.len += a.length; }
    str(s){ for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
    done(){ return this.buf.subarray(0, this.len); }
  }

  /* LZWの辞書。(prefix<<8)|k を直に引く。
     使い回すために外に置き、消すときは版番号を進めるだけにする。
     以前は毎回 100万要素をゼロ埋めしていたが、
     色数が増えて辞書が埋まりやすくなると、この消去だけで書き出しが分単位になった。 */
  const LZW_SIZE = 1 << 20;
  const lzwCode  = new Int32Array(LZW_SIZE);
  const lzwStamp = new Int32Array(LZW_SIZE);
  let lzwVersion = 0;

  /* GIF-LZW（Acme/GIFEncoder と同じコード幅の上げ方に合わせている） */
  function lzwEncode(out, pixels, minCodeSize){
    const clearCode = 1 << minCodeSize, eoi = clearCode + 1;
    let nBits = minCodeSize + 1;
    let maxcode = (1 << nBits) - 1;
    let free = clearCode + 2;
    let clearFlag = false;

    let ver = ++lzwVersion;                  // この版に一致する印だけを有効とみなす
    let acc = 0, accBits = 0;
    const block = new Uint8Array(255);
    let blockLen = 0;

    const flush = () => {
      if (!blockLen) return;
      out.u8(blockLen); out.raw(block.subarray(0, blockLen)); blockLen = 0;
    };
    function writeCode(code){
      acc |= code << accBits;
      accBits += nBits;
      while (accBits >= 8){
        block[blockLen++] = acc & 0xff;
        acc >>>= 8; accBits -= 8;
        if (blockLen === 255) flush();
      }
      if (clearFlag){ nBits = minCodeSize + 1; maxcode = (1 << nBits) - 1; clearFlag = false; }
      else if (free > maxcode && nBits < 12){
        nBits++;
        maxcode = nBits === 12 ? 4096 : (1 << nBits) - 1;
      }
    }

    writeCode(clearCode);
    let prefix = pixels[0];
    for (let i = 1; i < pixels.length; i++){
      const k = pixels[i];
      const key = (prefix << 8) | k;
      if (lzwStamp[key] === ver){ prefix = lzwCode[key]; continue; }
      writeCode(prefix);
      if (free < 4096){
        lzwStamp[key] = ver; lzwCode[key] = free; free++;
      } else {
        ver = ++lzwVersion;                  // 版を進めるだけで辞書を空にできる
        free = clearCode + 2; clearFlag = true; writeCode(clearCode);
      }
      prefix = k;
    }
    writeCode(prefix);
    writeCode(eoi);
    if (accBits > 0){ block[blockLen++] = acc & 0xff; if (blockLen === 255) flush(); }
    flush();
    out.u8(0);
  }

  /* GIFの表示時間は1/100秒単位。2未満は多くの環境で10に補正されるため下限を2にする */
  const delayUnits = ms => Math.max(2, Math.round(ms / 10));

  /* ---------------------------------------------------------------------
     減色（メディアンカット）
     --------------------------------------------------------------------- */
  function boxOf(pts){
    let rmin=255,rmax=0,gmin=255,gmax=0,bmin=255,bmax=0,rs=0,gs=0,bs=0;
    for (const p of pts){
      if(p[0]<rmin)rmin=p[0]; if(p[0]>rmax)rmax=p[0];
      if(p[1]<gmin)gmin=p[1]; if(p[1]>gmax)gmax=p[1];
      if(p[2]<bmin)bmin=p[2]; if(p[2]>bmax)bmax=p[2];
      rs+=p[0]; gs+=p[1]; bs+=p[2];
    }
    // 人間の目の感度で重み付けして分割軸を選ぶ
    const dr=(rmax-rmin)*1.0, dg=(gmax-gmin)*1.2, db=(bmax-bmin)*0.8;
    let axis=0, range=dr;
    if (dg>range){ axis=1; range=dg; }
    if (db>range){ axis=2; range=db; }
    const n = pts.length;
    return { pts, axis, range, avg:[Math.round(rs/n),Math.round(gs/n),Math.round(bs/n)] };
  }

  /* 分割するのは「色幅 × 画素数」が最大の箱。

     以前は画素数を ∛ で潰していたが、それだと
     面積は広いのに色幅の狭い領域（髪の陰影のような緩い階調）に色が回らず、
     そこだけ縞になった。実測で髪の誤差が 0.50、割り当てられた色は82色どまり。
     画素数をそのまま効かせると 0.27 / 92色まで改善する。 */
  function medianCut(samples, maxColors){
    let boxes = [boxOf(samples)];
    while (boxes.length < maxColors){
      let bi = -1, best = -1;
      for (let i = 0; i < boxes.length; i++){
        const b = boxes[i];
        if (b.pts.length < 2 || b.range === 0) continue;
        const s = b.range * b.pts.length;
        if (s > best){ best = s; bi = i; }
      }
      if (bi < 0) break;
      const b = boxes[bi], ax = b.axis;
      b.pts.sort((p, q) => p[ax] - q[ax]);
      const mid = b.pts.length >> 1;
      boxes.splice(bi, 1, boxOf(b.pts.slice(0, mid)), boxOf(b.pts.slice(mid)));
    }
    return boxes.map(b => b.avg);
  }

  /* できたパレットを実データの重心へ寄せ直す（Lloyd法）。
     箱の平均は「箱の中身の平均」でしかないので、
     実際にその色が担当する画素の平均に置き直すと誤差が下がる。
     画素数を効かせたことで小さく鮮やかな部分が粗くなるが、これで戻る。 */
  const REFINE = 8;

  function refinePalette(pal, samples){
    let P = pal.map(c => c.slice());
    const n = P.length;
    for (let it = 0; it < REFINE; it++){
      const match = makeMatcher(P);
      const sr = new Float64Array(n), sg = new Float64Array(n),
            sb = new Float64Array(n), sc = new Float64Array(n);
      for (let i = 0; i < samples.length; i++){
        const p = samples[i];
        const k = match(p[0], p[1], p[2]);
        sr[k] += p[0]; sg[k] += p[1]; sb[k] += p[2]; sc[k]++;
      }
      for (let k = 0; k < n; k++){
        if (!sc[k]) continue;                 // 誰も使わない色はそのまま残す
        P[k] = [Math.round(sr[k]/sc[k]), Math.round(sg[k]/sc[k]), Math.round(sb[k]/sc[k])];
      }
    }
    return P;
  }

  function paletteFromSamples(samples, maxColors){
    if (!samples.length) return [[0,0,0]];
    return refinePalette(medianCut(samples, maxColors), samples);
  }

  /* RGBAから色を間引いて拾う。透けている画素はパレットに入れない */
  function collectSamples(data, w, h, targetCount, into){
    const out = into || [];
    const stride = Math.max(1, Math.round(w * h / Math.max(1, targetCount)));
    for (let q = 0; q < w * h; q += stride){
      const o = q << 2;
      if (data[o + 3] < 128) continue;
      out.push([data[o], data[o + 1], data[o + 2]]);
    }
    return out;
  }

  /* 色 → 最も近いパレット添字。

     キャッシュは「出てきた色そのもの」で引く。
     以前は色を5bit（32段階）に丸めて引いていたが、それだと8段階以内の差が
     必ず同じ色に潰れ、パレットが255色あってもなだらかな階調が縞になった。
     （実測：グラデーションで使われた色が51色どまり、平均誤差1.49）

     丸めをやめても、絵に出てくる色の種類はたかが知れているので速度はほぼ変わらない。
     ノイズのように色数が極端に多い絵だけ遅くなるため、
     一定を超えたら粗いキャッシュに切り替えて頭打ちにする。 */
  const ROUGH_AT = 1 << 17;      // 13万色を超えたら丸めに切り替える

  function makeMatcher(pal){
    const exact = new Map();
    let rough = null;
    const n = pal.length;
    const pr = new Int32Array(n), pg = new Int32Array(n), pb = new Int32Array(n);
    for (let i = 0; i < n; i++){ pr[i]=pal[i][0]; pg[i]=pal[i][1]; pb[i]=pal[i][2]; }

    const nearest = (r, g, b) => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++){
        const dr=r-pr[i], dg=g-pg[i], db=b-pb[i];
        const d = dr*dr*3 + dg*dg*4 + db*db*2;
        if (d < bd){ bd = d; best = i; if (!d) break; }
      }
      return best;
    };

    return (r, g, b) => {
      if (rough){
        const k = ((r>>3)<<10) | ((g>>3)<<5) | (b>>3);
        const c = rough[k];
        if (c >= 0) return c;
        return (rough[k] = nearest(r, g, b));
      }
      const key = (r << 16) | (g << 8) | b;
      const hit = exact.get(key);
      if (hit !== undefined) return hit;
      const v = nearest(r, g, b);
      if (exact.size >= ROUGH_AT){
        rough = new Int16Array(32768).fill(-1);   // 色数が多すぎるので丸めに落とす
      } else {
        exact.set(key, v);
      }
      return v;
    };
  }

  /* RGBA → パレット添字。alphaIndex に 0以上を渡すと透けた画素をそこへ送る */
  function quantize(data, w, h, pal, match, alphaIndex, dither){
    const out = new Uint8Array(w * h);
    if (!dither){
      for (let i = 0, p = 0; p < out.length; p++, i += 4){
        out[p] = (alphaIndex >= 0 && data[i + 3] < 128) ? alphaIndex
               : match(data[i], data[i + 1], data[i + 2]);
      }
      return out;
    }
    // Floyd–Steinberg
    const buf = new Float32Array(w * h * 3);
    for (let i = 0, k = 0; k < w * h; k++, i += 4){
      buf[k*3] = data[i]; buf[k*3+1] = data[i+1]; buf[k*3+2] = data[i+2];
    }
    const push = (k, er, eg, eb, f) => {
      buf[k*3] += er*f; buf[k*3+1] += eg*f; buf[k*3+2] += eb*f;
    };
    const cl = v => v < 0 ? 0 : v > 255 ? 255 : v | 0;
    for (let y = 0; y < h; y++){
      for (let x = 0; x < w; x++){
        const k = y * w + x;
        if (alphaIndex >= 0 && data[(k << 2) + 3] < 128){ out[k] = alphaIndex; continue; }
        const r = cl(buf[k*3]), g = cl(buf[k*3+1]), b = cl(buf[k*3+2]);
        const idx = match(r, g, b);
        out[k] = idx;
        const er = r - pal[idx][0], eg = g - pal[idx][1], eb = b - pal[idx][2];
        if (x + 1 < w)   push(k + 1,     er, eg, eb, 7/16);
        if (y + 1 < h){
          if (x > 0)     push(k + w - 1, er, eg, eb, 3/16);
                         push(k + w,     er, eg, eb, 5/16);
          if (x + 1 < w) push(k + w + 1, er, eg, eb, 1/16);
        }
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------------
     書き出し本体

       frames    各コマのパレット添字（キャンバス全面ぶん）
       delays    各コマの表示時間(ms)
       opts.alphaIndex  本当に透ける席。無ければ -1
       opts.optimize    コマ間の差分だけを書く（本当の透過とは併用できない）
     --------------------------------------------------------------------- */
  /* パレットに必要なビット数と席数 */
  function tableBits(len){
    let bits = 1;
    while ((1 << bits) < Math.max(2, len)) bits++;
    return bits > 8 ? 8 : bits;
  }
  function writeTable(g, pal, size){
    for (let i = 0; i < size; i++){
      const c = pal[i] || [0, 0, 0];
      g.u8(c[0]); g.u8(c[1]); g.u8(c[2]);
    }
  }

  function encode(w, h, palettes, frames, delays, opts){
    const o = opts || {};
    const alphaIndex = o.alphaIndex == null ? -1 : o.alphaIndex;
    const realAlpha = alphaIndex >= 0;
    // 本当の透過が要る場合、同じ席を「前と同じ」には使えないので最適化は切る
    const optimize = !!o.optimize && !realAlpha;

    // palettes は 1つの配列（全コマ共通）でも、コマごとの配列でも受ける
    const perFrame = Array.isArray(palettes[0]) && Array.isArray(palettes[0][0]);
    const palOf = f => perFrame ? palettes[f] : palettes;
    const first = palOf(0);

    const g = new Bytes();
    const gBits = tableBits(first.length + (optimize ? 1 : 0));
    g.str("GIF89a");
    g.u16(w); g.u16(h);
    g.u8(0x80 | ((gBits - 1) << 4) | (gBits - 1));
    g.u8(0); g.u8(0);
    writeTable(g, first, 1 << gBits);
    // 無限ループ
    g.u8(0x21); g.u8(0xff); g.u8(0x0b);
    g.str("NETSCAPE2.0");
    g.u8(3); g.u8(1); g.u16(0); g.u8(0);

    const sub = new Uint8Array(w * h);
    let prev = null, prevPal = null;

    for (let f = 0; f < frames.length; f++){
      const cur = frames[f];
      const pal = palOf(f);
      // ローカル色表は「そのコマ限り」で次には引き継がれない。
      // グローバルと違うパレットを使うコマは、毎コマ色表を持たせる必要がある。
      const needLCT = pal !== first;
      // 添字の意味が同じ（＝前のコマと同じパレット）ときだけ差分が取れる
      const canDiff = pal === prevPal;
      const bits = tableBits(pal.length + (optimize ? 1 : 0));
      const diffIndex = optimize ? pal.length : -1;
      const minCodeSize = Math.max(2, bits);

      let x0 = 0, y0 = 0, bw = w, bh = h, useDiff = false;

      if (optimize && prev && canDiff){
        let minX = w, minY = h, maxX = -1, maxY = -1;
        for (let y = 0; y < h; y++){
          const row = y * w;
          for (let x = 0; x < w; x++){
            if (cur[row + x] !== prev[row + x]){
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0){ minX = minY = 0; maxX = maxY = 0; }   // 変化なし＝1画素だけ書く
        x0 = minX; y0 = minY; bw = maxX - minX + 1; bh = maxY - minY + 1;
        useDiff = true;
      }

      let n = 0;
      for (let y = 0; y < bh; y++){
        const srow = (y0 + y) * w + x0;
        for (let x = 0; x < bw; x++){
          const v = cur[srow + x];
          sub[n++] = (useDiff && prev[srow + x] === v) ? diffIndex : v;
        }
      }

      const transparent = realAlpha || useDiff;
      const transIdx = realAlpha ? alphaIndex : diffIndex;
      const disposal = realAlpha ? 2 : 1;    // 透過は毎コマ消す／差分は前を残す

      g.u8(0x21); g.u8(0xf9); g.u8(4);
      g.u8((disposal << 2) | (transparent ? 1 : 0));
      g.u16(delayUnits(delays[f]));
      g.u8(transparent ? transIdx : 0);
      g.u8(0);

      g.u8(0x2c);
      g.u16(x0); g.u16(y0); g.u16(bw); g.u16(bh);
      if (needLCT){
        g.u8(0x80 | (bits - 1));            // このコマ専用の色表
        writeTable(g, pal, 1 << bits);
      } else {
        g.u8(0);
      }
      g.u8(minCodeSize);
      lzwEncode(g, sub.subarray(0, n), minCodeSize);

      prev = cur;
      prevPal = pal;
    }
    g.u8(0x3b);
    return g.done();
  }

  return { encode, quantize, makeMatcher, paletteFromSamples, collectSamples, delayUnits };
})();
