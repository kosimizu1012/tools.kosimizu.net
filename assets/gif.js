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

  /* GIF-LZW（Acme/GIFEncoder と同じコード幅の上げ方に合わせている） */
  function lzwEncode(out, pixels, minCodeSize){
    const clearCode = 1 << minCodeSize, eoi = clearCode + 1;
    let nBits = minCodeSize + 1;
    let maxcode = (1 << nBits) - 1;
    let free = clearCode + 2;
    let clearFlag = false;

    const table = new Int32Array(1 << 20);   // (prefix<<8)|k を直に引く。0=空、値は code+1
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
      const v = table[key];
      if (v !== 0){ prefix = v - 1; continue; }
      writeCode(prefix);
      if (free < 4096){ table[key] = free + 1; free++; }
      else { table.fill(0); free = clearCode + 2; clearFlag = true; writeCode(clearCode); }
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

  function paletteFromSamples(samples, maxColors){
    if (!samples.length) return [[0,0,0]];
    let boxes = [boxOf(samples)];
    while (boxes.length < maxColors){
      let bi = -1, best = -1;
      for (let i = 0; i < boxes.length; i++){
        const b = boxes[i];
        if (b.pts.length < 2 || b.range === 0) continue;
        const s = b.range * Math.cbrt(b.pts.length);
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

  function makeMatcher(pal){
    const cache = new Int16Array(32768).fill(-1);
    const n = pal.length;
    const pr = new Int32Array(n), pg = new Int32Array(n), pb = new Int32Array(n);
    for (let i = 0; i < n; i++){ pr[i]=pal[i][0]; pg[i]=pal[i][1]; pb[i]=pal[i][2]; }
    return (r, g, b) => {
      const key = ((r>>3)<<10) | ((g>>3)<<5) | (b>>3);
      const c = cache[key];
      if (c >= 0) return c;
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++){
        const dr=r-pr[i], dg=g-pg[i], db=b-pb[i];
        const d = dr*dr*3 + dg*dg*4 + db*db*2;
        if (d < bd){ bd = d; best = i; if (!d) break; }
      }
      cache[key] = best;
      return best;
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
  function encode(w, h, palette, frames, delays, opts){
    const o = opts || {};
    const alphaIndex = o.alphaIndex == null ? -1 : o.alphaIndex;
    const realAlpha = alphaIndex >= 0;
    // 本当の透過が要る場合、同じ席を「前と同じ」には使えないので最適化は切る
    const optimize = !!o.optimize && !realAlpha;

    // 差分用の席をパレットの末尾に1つ確保する
    const diffIndex = optimize ? palette.length : -1;
    const need = palette.length + (optimize ? 1 : 0);
    let bits = 1;
    while ((1 << bits) < Math.max(2, need)) bits++;
    if (bits > 8) bits = 8;
    const tableSize = 1 << bits;

    const g = new Bytes();
    g.str("GIF89a");
    g.u16(w); g.u16(h);
    g.u8(0x80 | ((bits - 1) << 4) | (bits - 1));
    g.u8(0); g.u8(0);
    for (let i = 0; i < tableSize; i++){
      const c = palette[i] || [0, 0, 0];
      g.u8(c[0]); g.u8(c[1]); g.u8(c[2]);
    }
    // 無限ループ
    g.u8(0x21); g.u8(0xff); g.u8(0x0b);
    g.str("NETSCAPE2.0");
    g.u8(3); g.u8(1); g.u16(0); g.u8(0);

    const minCodeSize = Math.max(2, bits);
    const sub = new Uint8Array(w * h);
    let prev = null;

    for (let f = 0; f < frames.length; f++){
      const cur = frames[f];
      let x0 = 0, y0 = 0, bw = w, bh = h, useDiff = false;

      if (optimize && prev){
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
      g.u8(0);
      g.u8(minCodeSize);
      lzwEncode(g, sub.subarray(0, n), minCodeSize);

      prev = cur;
    }
    g.u8(0x3b);
    return g.done();
  }

  return { encode, quantize, makeMatcher, paletteFromSamples, collectSamples, delayUnits };
})();
