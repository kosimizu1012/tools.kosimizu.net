"use strict";

/* =========================================================================
   書体の管理（tools.kosimizu.net）

   既定は同梱の Hachi Maru Pop（SIL OFL）。
   加えて、利用者が自分の持っているフォントを読み込んで使えるようにする。

   読み込んだフォントは IndexedDB に入れて次回から自動で復元する。
   ブラウザは選んだファイルの場所を覚えられないので、中身ごと持っておく必要がある。
   （＝ブラウザの「Cookieと他のサイトデータ」を消すと消える）

   同梱フォントは unicode-range で細かく分けてあるため、
   canvas に描く前に「実際に使う文字」を指定して読み込みを待つ必要がある。
   ここを怠ると、初回だけ文字が代替フォントで描かれてしまう。
   ========================================================================= */

const FontPicker = (() => {
  const DB = "tools-fonts", STORE = "fonts";
  const BUILTIN = { id: "__builtin__", label: "はちまるポップ（同梱）", family: "hachimarupop" };

  let userFonts = [];        // { id, label, family, buf }
  let current = BUILTIN.id;
  let cfg = null;

  /* ---- IndexedDB ---- */
  function open(){
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function dbAll(){
    try {
      const db = await open();
      return await new Promise((res, rej) => {
        const req = db.transaction(STORE).objectStore(STORE).getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => rej(req.error);
      });
    } catch (e){ return []; }
  }
  async function dbPut(rec){
    try {
      const db = await open();
      await new Promise((res, rej) => {
        const t = db.transaction(STORE, "readwrite");
        t.objectStore(STORE).put(rec);
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
      return true;
    } catch (e){ return false; }
  }
  async function dbDel(id){
    try {
      const db = await open();
      await new Promise((res, rej) => {
        const t = db.transaction(STORE, "readwrite");
        t.objectStore(STORE).delete(id);
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
    } catch (e){}
  }

  /* ---- 登録 ---- */
  async function register(rec){
    const face = new FontFace(rec.family, rec.buf);
    await face.load();
    document.fonts.add(face);
  }

  function familyOf(id){
    if (id === BUILTIN.id) return BUILTIN.family;
    const f = userFonts.find(f => f.id === id);
    return f ? f.family : BUILTIN.family;
  }

  /* いま使う書体で、この文字列を描けるようにする。
     unicode-range 分割のため、実際の文字を渡して読み込みを待つのが要点。 */
  async function ensure(text){
    const fam = familyOf(current);
    if (!text) return;
    try { await document.fonts.load(`40px "${fam}"`, text); } catch (e){}
  }

  function cssFamily(){
    return `"${familyOf(current)}", "Hiragino Maru Gothic ProN", sans-serif`;
  }

  /* ---- UI ---- */
  function renderList(){
    const sel = cfg.els.fontSel;
    sel.innerHTML = "";
    [BUILTIN, ...userFonts].forEach(f => {
      const o = document.createElement("option");
      o.value = f.id; o.textContent = f.label;
      sel.appendChild(o);
    });
    sel.value = current;
    cfg.els.fontDel.disabled = current === BUILTIN.id;
    cfg.els.fontInfo.textContent = userFonts.length
      ? `追加済み ${userFonts.length}件。ブラウザの「Cookieと他のサイトデータ」を消すと消えます。`
      : "手持ちのフォントを追加できます（この端末から出ません）。";
  }

  async function addFile(file){
    if (!file) return;
    if (!/\.(ttf|otf|woff2?|ttc)$/i.test(file.name)){
      cfg.els.fontInfo.textContent = "対応していない形式です（ttf / otf / woff / woff2）。";
      return;
    }
    const buf = await file.arrayBuffer();
    const id = "u_" + Date.now().toString(36);
    const rec = { id, label: file.name.replace(/\.[^.]+$/, ""), family: "userfont_" + id, buf };
    try {
      await register(rec);
    } catch (e){
      cfg.els.fontInfo.textContent = "このフォントは読み込めませんでした。";
      return;
    }
    userFonts.push(rec);
    current = id;
    const saved = await dbPut(rec);
    renderList();
    cfg.els.fontInfo.textContent = saved
      ? `「${rec.label}」を追加しました。次回からも使えます。`
      : `「${rec.label}」を追加しました（保存領域が使えないため今回かぎりです）。`;
    cfg.onChange();
  }

  async function init(c){
    cfg = c;
    // 保存済みの利用者フォントを戻す
    const recs = await dbAll();
    for (const r of recs){
      try { await register(r); userFonts.push(r); } catch (e){}
    }
    renderList();

    cfg.els.fontSel.addEventListener("change", () => {
      current = cfg.els.fontSel.value;
      cfg.els.fontDel.disabled = current === BUILTIN.id;
      cfg.onChange();
    });
    cfg.els.fontAdd.addEventListener("click", () => cfg.els.fontFile.click());
    cfg.els.fontFile.addEventListener("change", e => {
      addFile(e.target.files[0]);
      e.target.value = "";
    });
    cfg.els.fontDel.addEventListener("click", async () => {
      if (current === BUILTIN.id) return;
      const f = userFonts.find(f => f.id === current);
      if (!f || !confirm(`「${f.label}」を削除しますか？`)) return;
      await dbDel(current);
      userFonts = userFonts.filter(x => x.id !== current);
      current = BUILTIN.id;
      renderList();
      cfg.els.fontInfo.textContent = `「${f.label}」を削除しました。`;
      cfg.onChange();
    });
  }

  return {
    init, ensure, cssFamily,
    get id(){ return current; },
    // プリセットで指定された書体が消えている場合は同梱フォントに戻す
    set id(v){
      const ok = v === BUILTIN.id || userFonts.some(f => f.id === v);
      current = ok ? v : BUILTIN.id;
      renderList();
    },
    has: v => v === BUILTIN.id || userFonts.some(f => f.id === v),
    list: () => [BUILTIN, ...userFonts].map(f => ({ id: f.id, label: f.label }))
  };
})();
