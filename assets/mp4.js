"use strict";

/* =========================================================================
   MP4（H.264）書き出し（tools.kosimizu.net）

   映像の圧縮はブラウザの WebCodecs にやらせ、
   MP4という容器の組み立てだけをここで行う。

   256色の制限は無いが、動画圧縮は細い線や文字をにじませる。
   実測ではGIFの方が忠実だった（輪郭の誤差 GIF 1.7 に対し MP4 6.0）。
   それでもXはアニメーションを必ず動画に変換するため、
   GIFで上げると「減色」→「動画化」と二重に劣化する。X向けにはこちらが有利。
   透過は扱えない。

   構成は素直な非分割MP4：
     ftyp → mdat（全コマの圧縮データ）→ moov（目次）
   コマの表示時間はミリ秒単位でばらばらに指定できるよう、
   時間の刻みを1/1000秒にして stts に1コマずつ書く。
   ========================================================================= */

const MP4 = (() => {

  /* ---- バイト列を組み立てる小道具 ---- */
  class Buf {
    constructor(){ this.a = []; }
    u8(v){ this.a.push(v & 255); return this; }
    u16(v){ this.a.push((v >> 8) & 255, v & 255); return this; }
    u24(v){ this.a.push((v >> 16) & 255, (v >> 8) & 255, v & 255); return this; }
    u32(v){ this.a.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); return this; }
    str(s){ for (let i = 0; i < s.length; i++) this.a.push(s.charCodeAt(i) & 255); return this; }
    raw(u){ for (let i = 0; i < u.length; i++) this.a.push(u[i]); return this; }
    zero(n){ for (let i = 0; i < n; i++) this.a.push(0); return this; }
    get bytes(){ return new Uint8Array(this.a); }
  }

  /* 箱＝[長さ][種別][中身] */
  function box(type, ...parts){
    let len = 8;
    const chunks = parts.map(p => (p instanceof Uint8Array) ? p : p.bytes);
    chunks.forEach(c => len += c.length);
    const out = new Uint8Array(len);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let p = 8;
    chunks.forEach(c => { out.set(c, p); p += c.length; });
    return out;
  }
  const fullBox = (type, version, flags, ...parts) =>
    box(type, new Buf().u8(version).u24(flags), ...parts);

  const TIMESCALE = 1000;                 // 1/1000秒＝ミリ秒で時間を扱う

  /* ---------------------------------------------------------------------
     samples: [{ data:Uint8Array, keyFrame:bool, durationMs:number }]
     description: avcC（VideoEncoder が最初に渡してくる復号設定）
     --------------------------------------------------------------------- */
  function build(samples, description, width, height){
    const total = samples.reduce((s, x) => s + x.durationMs, 0);

    const ftyp = box("ftyp",
      new Buf().str("isom").u32(512).str("isom").str("iso2").str("avc1").str("mp41"));

    // mdat は「長さ+種別」の8バイトのあと中身が続く
    let mdatSize = 8;
    samples.forEach(s => mdatSize += s.data.length);
    const mdat = new Uint8Array(mdatSize);
    new DataView(mdat.buffer).setUint32(0, mdatSize);
    mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
    let mp = 8;
    samples.forEach(s => { mdat.set(s.data, mp); mp += s.data.length; });

    const dataStart = ftyp.length + 8;    // 最初のコマの中身が始まる位置

    /* ---- 目次（moov） ---- */
    const mvhd = fullBox("mvhd", 0, 0, new Buf()
      .u32(0).u32(0).u32(TIMESCALE).u32(total)
      .u32(0x00010000).u16(0x0100).u16(0).u32(0).u32(0)
      .u32(0x00010000).u32(0).u32(0)
      .u32(0).u32(0x00010000).u32(0)
      .u32(0).u32(0).u32(0x40000000)
      .zero(24).u32(2));

    const tkhd = fullBox("tkhd", 0, 3, new Buf()
      .u32(0).u32(0).u32(1).u32(0).u32(total)
      .u32(0).u32(0).u16(0).u16(0).u16(0).u16(0)
      .u32(0x00010000).u32(0).u32(0)
      .u32(0).u32(0x00010000).u32(0)
      .u32(0).u32(0).u32(0x40000000)
      .u32(width << 16).u32(height << 16));

    const mdhd = fullBox("mdhd", 0, 0, new Buf()
      .u32(0).u32(0).u32(TIMESCALE).u32(total).u16(0x55c4).u16(0));

    const hdlr = fullBox("hdlr", 0, 0, new Buf()
      .u32(0).str("vide").u32(0).u32(0).u32(0).str("VideoHandler\0"));

    const vmhd = fullBox("vmhd", 0, 1, new Buf().u16(0).u16(0).u16(0).u16(0));
    const dref = fullBox("dref", 0, 0, new Buf().u32(1), fullBox("url ", 0, 1));
    const dinf = box("dinf", dref);

    const avcC = box("avcC", description);
    const avc1 = box("avc1", new Buf()
      .zero(6).u16(1)
      .u16(0).u16(0).u32(0).u32(0).u32(0)
      .u16(width).u16(height)
      .u32(0x00480000).u32(0x00480000).u32(0)
      .u16(1).zero(32).u16(0x0018).u16(0xffff), avcC);
    const stsd = fullBox("stsd", 0, 0, new Buf().u32(1), avc1);

    // 表示時間が同じコマはまとめる
    const runs = [];
    samples.forEach(s => {
      const last = runs[runs.length - 1];
      if (last && last.d === s.durationMs) last.n++;
      else runs.push({ n: 1, d: s.durationMs });
    });
    const sttsBuf = new Buf().u32(runs.length);
    runs.forEach(r => sttsBuf.u32(r.n).u32(r.d));
    const stts = fullBox("stts", 0, 0, sttsBuf);

    const keys = [];
    samples.forEach((s, i) => { if (s.keyFrame) keys.push(i + 1); });
    const stssBuf = new Buf().u32(keys.length);
    keys.forEach(k => stssBuf.u32(k));
    const stss = fullBox("stss", 0, 0, stssBuf);

    // 全コマを1つのまとまりに入れる
    const stsc = fullBox("stsc", 0, 0, new Buf().u32(1).u32(1).u32(samples.length).u32(1));

    const stszBuf = new Buf().u32(0).u32(samples.length);
    samples.forEach(s => stszBuf.u32(s.data.length));
    const stsz = fullBox("stsz", 0, 0, stszBuf);

    const stco = fullBox("stco", 0, 0, new Buf().u32(1).u32(dataStart));

    const stbl = box("stbl", stsd, stts, stss, stsc, stsz, stco);
    const minf = box("minf", vmhd, dinf, stbl);
    const mdia = box("mdia", mdhd, hdlr, minf);
    const trak = box("trak", tkhd, mdia);
    const moov = box("moov", mvhd, trak);

    const out = new Uint8Array(ftyp.length + mdat.length + moov.length);
    out.set(ftyp, 0);
    out.set(mdat, ftyp.length);
    out.set(moov, ftyp.length + mdat.length);
    return out;
  }

  /* ---------------------------------------------------------------------
     コマを順に渡してMP4を作る。

       size(w,h)   H.264 は縦横が偶数である必要があるので丸める
       draw(k)     k コマ目を描いた canvas を返す
       delays[k]   k コマ目の表示時間(ms)
     --------------------------------------------------------------------- */
  function evenSize(w, h){ return [w - (w % 2), h - (h % 2)]; }

  async function encode({ width, height, count, draw, delays, bitrate, onProgress }){
    if (typeof VideoEncoder === "undefined") throw new Error("このブラウザは動画の書き出しに対応していません");
    const [w, h] = evenSize(width, height);

    const samples = [];
    let description = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !description){
          description = new Uint8Array(meta.decoderConfig.description);
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        samples.push({ data, keyFrame: chunk.type === "key",
                       durationMs: Math.round((chunk.duration || 0) / 1000) });
      },
      error: e => { throw e; }
    });

    encoder.configure({
      codec: "avc1.640028",              // H.264 High Profile
      width: w, height: h,
      bitrate: bitrate || 16_000_000,   // 図形や文字が多いので高めに取る
      framerate: 30,
      avc: { format: "avc" },            // 長さ付きの並び＝MP4がそのまま入れられる形
      latencyMode: "quality"
    });

    let tUs = 0;
    for (let k = 0; k < count; k++){
      const canvas = draw(k);
      const durUs = Math.max(1, Math.round(delays[k])) * 1000;
      const frame = new VideoFrame(canvas, { timestamp: tUs, duration: durUs });
      // 先頭と、ときどきキーフレームを入れる（途中から再生できるように）
      encoder.encode(frame, { keyFrame: k === 0 || k % 60 === 0 });
      frame.close();
      tUs += durUs;
      if (onProgress && k % 5 === 0){
        onProgress(k + 1, count);
        await new Promise(r => setTimeout(r, 0));
      }
    }
    await encoder.flush();
    encoder.close();

    if (!description) throw new Error("H.264の復号設定を取り出せませんでした");
    // 最後のコマの表示時間が0で返ることがあるので補う
    samples.forEach((s, i) => { if (!s.durationMs) s.durationMs = Math.round(delays[i] || 100); });
    return { bytes: build(samples, description, w, h), width: w, height: h,
             frames: samples.length };
  }

  async function available(){
    if (typeof VideoEncoder === "undefined") return false;
    try {
      const r = await VideoEncoder.isConfigSupported(
        { codec: "avc1.640028", width: 640, height: 480, bitrate: 2_000_000, framerate: 30 });
      return !!r.supported;
    } catch (e){ return false; }
  }

  return { encode, available, evenSize };
})();
