"use strict";

/* =========================================================================
   共通のプリセット（tools.kosimizu.net）

   画像は保存せず、パネルの操作子の値だけを保存する。
   項目を並べて書かず操作子を走査して拾うので、
   あとから操作子を足しても自動で保存対象に入る。

   ツール固有の状態（選んでいる背景の名前など）は
   extra / applyExtra で受け渡す。
   ========================================================================= */

const Presets = (() => {

  function isControl(el){
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "select") return true;
    if (tag !== "input") return false;
    return ["range", "color", "text", "number", "checkbox"].includes(el.type);
  }

  function init(cfg){
    const { key, els, ui } = cfg;
    const skip = new Set(cfg.skip || []);
    const extra = cfg.extra || (() => ({}));
    const applyExtra = cfg.applyExtra || (() => "");
    const onApplied = cfg.onApplied || (() => {});

    let presets = {};

    /* 保存領域が使えるか実際に書いて確かめる */
    let canStore = true;
    try {
      localStorage.setItem(key + ".t", "1");
      localStorage.removeItem(key + ".t");
    } catch (e){ canStore = false; }

    const load = () => {
      if (!canStore) return;
      try { presets = JSON.parse(localStorage.getItem(key) || "{}") || {}; }
      catch (e){ presets = {}; }
    };
    const persist = () => {
      if (!canStore) return false;
      try { localStorage.setItem(key, JSON.stringify(presets)); return true; }
      catch (e){ return false; }
    };

    function collect(){
      const s = { _extra: extra() };
      Object.keys(els).forEach(id => {
        if (skip.has(id) || id.startsWith("preset")) return;
        const el = els[id];
        if (!isControl(el)) return;
        s[id] = el.type === "checkbox" ? el.checked : el.value;
      });
      return s;
    }

    function apply(s){
      let unknown = 0;
      Object.keys(s).forEach(id => {
        if (id === "_extra") return;
        const el = els[id];
        if (!isControl(el)){ unknown++; return; }   // 版が違って無くなった項目は読み飛ばす
        if (el.type === "checkbox") el.checked = !!s[id];
        else el.value = s[id];
      });
      const note = applyExtra(s._extra || {}) || "";
      onApplied();
      return { unknown, note };
    }

    function refreshList(selected){
      const names = Object.keys(presets).sort((a, b) => a.localeCompare(b, "ja"));
      ui.sel.innerHTML = '<option value="">— 保存した設定を選ぶ —</option>';
      names.forEach(n => {
        const o = document.createElement("option");
        o.value = n; o.textContent = n;
        ui.sel.appendChild(o);
      });
      if (selected && presets[selected]) ui.sel.value = selected;
      ui.del.disabled = !ui.sel.value;

      if (!canStore){
        ui.info.textContent =
          "このブラウザでは保存領域が使えないため、プリセットはこのページを閉じるまでの一時保存です。"
          + "「ファイルに書き出し」で残してください。";
      } else if (!names.length){
        ui.info.textContent = "よく使う設定に名前を付けて保存できます（画像は含まれません）。";
      } else {
        ui.info.textContent = `${names.length}件を保存中。`;
      }
    }

    ui.sel.addEventListener("change", () => {
      const name = ui.sel.value;
      ui.del.disabled = !name;
      if (!name) return;
      const r = apply(presets[name]);
      ui.info.textContent = r.note
        || (r.unknown
            ? `「${name}」を適用しました（${r.unknown}項目は今の版に無いため読み飛ばしました）。`
            : `「${name}」を適用しました。`);
    });

    ui.save.addEventListener("click", () => {
      const name = (prompt("プリセット名を入力してください", ui.sel.value || "") || "").trim();
      if (!name) return;
      if (presets[name] && !confirm(`「${name}」を上書きしますか？`)) return;
      presets[name] = collect();
      const ok = persist();
      refreshList(name);
      ui.info.textContent = ok
        ? `「${name}」を保存しました。`
        : `「${name}」を一時保存しました（このページを閉じると消えます）。`;
    });

    ui.del.addEventListener("click", () => {
      const name = ui.sel.value;
      if (!name || !confirm(`「${name}」を削除しますか？`)) return;
      delete presets[name];
      persist();
      refreshList();
      ui.info.textContent = `「${name}」を削除しました。`;
    });

    ui.exp.addEventListener("click", () => {
      const names = Object.keys(presets);
      if (!names.length){ ui.info.textContent = "書き出すプリセットがありません。"; return; }
      const blob = new Blob([JSON.stringify(presets, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      ui.dl.href = url;
      ui.dl.download = cfg.fileName || "presets.json";
      ui.dl.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      ui.info.textContent = `${names.length}件を書き出しました。`;
    });

    ui.imp.addEventListener("click", () => ui.file.click());
    ui.file.addEventListener("change", e => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          let obj;
          try { obj = JSON.parse(rd.result); }
          catch (err){ throw new Error("JSONとして読み取れないファイルです"); }
          if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("形式が違います");
          const added = Object.keys(obj);
          if (!added.length) throw new Error("中身が空です");
          added.forEach(k => { presets[k] = obj[k]; });
          persist();
          refreshList();
          ui.info.textContent = `${added.length}件を読み込みました。`;
        } catch (err){
          ui.info.textContent = "読み込めませんでした：" + err.message;
        }
      };
      rd.readAsText(f);
    });

    load();
    refreshList();
    return { collect, apply, refreshList, canStore, all: () => presets };
  }

  return { init };
})();
