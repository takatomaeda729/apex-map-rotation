/* ============================================================================
 *  script.js — ルピンスペシャル / マップローテーション ロジック
 * ----------------------------------------------------------------------------
 *  時刻はすべて UTC(epoch 秒) で計算し、表示のみ JST(Asia/Tokyo) に変換する。
 *  設定は「localStorage に保存があればそれを、なければ rotation-data.js の
 *  デフォルト値を使う」という読み込み順。
 * ========================================================================== */

"use strict";

/* ----------------------------------------------------------------------------
 *  定数
 * -------------------------------------------------------------------------- */
const CONFIG_KEY = "lupin-config-v1"; // 設定の localStorage キー
const TOKEN_KEY = "lupin-gh-token";   // GitHub トークンの localStorage キー
const AUTH_KEY = "lupin-authed";      // 認証済みフラグの sessionStorage キー
const SITE_TITLE = "ルピンスペシャル";  // ページタイトルのベース
const DATE_CHIP_DAYS = 7;             // 日付チップの表示日数（今日から）

/*
 * 設定パネルのパスワード（クライアントサイド）。
 * ※これは本格的なセキュリティではなく、誤操作・いたずら防止用の簡易ゲートです。
 *   ソースを読めば分かってしまうため、機密保護の目的には使えません。
 */
const SETTINGS_PASSWORD = "rupin";

/* ----------------------------------------------------------------------------
 *  GitHub リポジトリ情報（全体公開＝直接コミットに使用）
 *   別のリポジトリに移す場合はここを書き換えてください。
 * -------------------------------------------------------------------------- */
const GITHUB_CONFIG = {
  owner: "takatomaeda729",     // ← あなたの GitHub ユーザー名/Org 名
  repo: "apex-map-rotation",   // ← リポジトリ名
  branch: "main",              // ← 公開ブランチ
  path: "rotation-data.js",    // ← コミット対象ファイル（通常は変更不要）
};

let config = null;          // 実行時の設定
let selectedDateStr = null; // 選択中の日付（JST "YYYY-MM-DD"）
let draft = null;           // 設定モーダル編集中の作業コピー
let tickTimer = null;


/* ============================================================================
 *  1. 時刻ユーティリティ
 * ========================================================================== */

function nowSec() { return Math.floor(Date.now() / 1000); }

/** 正しい剰余（負の値でも 0 以上を返す）。基準時刻より過去でも正しく計算するため */
function euclideanMod(a, n) { return ((a % n) + n) % n; }

/** UNIX 秒 → JST の各フィールド（端末TZに依存しないよう +9h して UTC 系で読む） */
function toJst(epochSec) {
  const d = new Date((epochSec + 9 * 3600) * 1000);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), min: d.getUTCMinutes(), dow: d.getUTCDay(),
  };
}

const DOW_JP = ["日", "月", "火", "水", "木", "金", "土"];
function pad2(n) { return String(n).padStart(2, "0"); }

function fmtJstHm(epochSec) { const t = toJst(epochSec); return `${pad2(t.hour)}:${pad2(t.min)}`; }
function jstDateStr(epochSec) { const t = toJst(epochSec); return `${t.year}-${pad2(t.month)}-${pad2(t.day)}`; }
function fmtJstDateHead(epochSec) { const t = toJst(epochSec); return `${t.month}/${t.day} (${DOW_JP[t.dow]})`; }
function fmtChipLabel(epochSec) { const t = toJst(epochSec); return `${t.month}/${t.day}(${DOW_JP[t.dow]})`; }

/** JST の "YYYY-MM-DD" → その日の JST 00:00 の UNIX 秒(UTC) */
function jstMidnightEpoch(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, 0, 0, 0) / 1000) - 9 * 3600;
}
/** "YYYY-MM-DD" を days 日ずらす（正午基準で安全に） */
function shiftDateStr(dateStr, days) {
  return jstDateStr(jstMidnightEpoch(dateStr) + 12 * 3600 + days * 86400);
}

/** datetime-local の値("YYYY-MM-DDTHH:MM", JST) → UNIX秒(UTC) */
function inputToBaseTime(str) {
  const [datePart, timePart] = str.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, mi] = timePart.split(":").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, h, mi, 0) / 1000) - 9 * 3600;
}
/** UNIX秒(UTC) → datetime-local の値("YYYY-MM-DDTHH:MM", JST) */
function baseTimeToInput(sec) {
  const t = toJst(sec);
  return `${t.year}-${pad2(t.month)}-${pad2(t.day)}T${pad2(t.hour)}:${pad2(t.min)}`;
}

function fmtHms(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}
function fmtRemainRough(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `あと${h}時間${m}分`;
  if (m > 0) return `あと${m}分`;
  return `あと${s}秒`;
}


/* ============================================================================
 *  2. 設定（config）の読み込み・保存
 * ========================================================================== */

/** 簡易ディープコピー */
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

/** rotation-data.js の定数から作るデフォルト設定
 *  ※ヘッダー文言(SUB_TEXT/SEASON_LABEL)はコード定数のみで管理し、設定には含めない */
function defaultConfig() {
  return {
    mapMaster: clone(MAP_MASTER),
    rotation: {
      label: ROTATION.label,
      baseTime: ROTATION.baseTime,
      schedule: clone(ROTATION.schedule),
    },
  };
}

/** 設定の妥当性チェック（壊れていたら false） */
function isValidConfig(c) {
  return c && typeof c === "object"
    && c.mapMaster && typeof c.mapMaster === "object"
    && c.rotation && Array.isArray(c.rotation.schedule)
    && c.rotation.schedule.length > 0
    && typeof c.rotation.baseTime === "number";
}

/** localStorage 優先で設定を読み込む（無ければデフォルト） */
function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isValidConfig(parsed)) {
        // デフォルトに無いフィールドを補完
        const def = defaultConfig();
        return {
          mapMaster: parsed.mapMaster,
          rotation: {
            label: parsed.rotation.label ?? def.rotation.label,
            baseTime: parsed.rotation.baseTime,
            schedule: parsed.rotation.schedule,
          },
        };
      }
    }
  } catch (e) { /* 壊れていたらデフォルトへ */ }
  return defaultConfig();
}

/** 設定を保存 */
function saveConfig(c) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(c)); } catch (e) { /* 続行 */ }
}


/* ============================================================================
 *  3. ローテーション計算
 * ========================================================================== */

function totalCycleSec(rotation) {
  return rotation.schedule.reduce((sum, item) => sum + item.durationMin * 60, 0);
}

/** 指定時刻 atSec のローテ状態を計算（負の剰余対応） */
function computeRotation(rotation, atSec) {
  const cycle = totalCycleSec(rotation);
  const offset = euclideanMod(atSec - rotation.baseTime, cycle);

  let acc = 0, index = 0;
  for (let i = 0; i < rotation.schedule.length; i++) {
    const dur = rotation.schedule[i].durationMin * 60;
    if (offset < acc + dur) { index = i; break; }
    acc += dur;
  }

  const item = rotation.schedule[index];
  const durationSec = item.durationMin * 60;
  const elapsedSec = offset - acc;
  const startSec = atSec - elapsedSec;
  const nextIndex = (index + 1) % rotation.schedule.length;

  return {
    index, item, startSec, endSec: startSec + durationSec,
    remainSec: durationSec - elapsedSec,
    nextIndex, nextItem: rotation.schedule[nextIndex],
  };
}

/** 指定 JST 日付の 00:00〜翌00:00 にかかる予定を返す（日跨ぎ先頭も含む） */
function buildDayTimeline(rotation, dateStr) {
  const dayStart = jstMidnightEpoch(dateStr);
  const dayEnd = dayStart + 86400;
  const list = [];

  let cur = computeRotation(rotation, dayStart);
  let index = cur.index;
  let startSec = cur.startSec;

  let guard = 0;
  while (startSec < dayEnd && guard < 1000) {
    const item = rotation.schedule[index];
    const endSec = startSec + item.durationMin * 60;
    if (endSec > dayStart) list.push({ item, startSec, endSec });
    startSec = endSec;
    index = (index + 1) % rotation.schedule.length;
    guard++;
  }
  return list;
}


/* ============================================================================
 *  4. マップ情報の解決 & ビジュアル
 * ========================================================================== */

/** マップキー → { nameJa, nameEn, image }（マスタに無ければキーで代替） */
function mapInfo(key) {
  return config.mapMaster[key] || { nameJa: key, nameEn: key, image: null };
}

/** キーから決定的なグラデーション（画像が無いとき用） */
function mapGradient(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) & 0xffffffff;
  const hue = euclideanMod(hash, 360);
  return `linear-gradient(135deg, hsl(${hue} 45% 32%), hsl(${hue} 55% 12%))`;
}

/** 要素にマップ画像 or グラデーションを適用 */
function applyVisual(el, key) {
  const info = mapInfo(key);
  if (info.image) {
    el.style.backgroundImage = `url("${info.image}")`;
    el.classList.remove("is-placeholder");
  } else {
    el.style.backgroundImage = mapGradient(key);
    el.classList.add("is-placeholder");
  }
}


/* ============================================================================
 *  5. 描画
 * ========================================================================== */

let el = {};

/** ヘッダー文言を反映（rotation-data.js の定数から直接） */
function renderHeader() {
  el.seasonLabel.textContent = (typeof SEASON_LABEL === "string") ? SEASON_LABEL : "";
  el.subText.textContent = (typeof SUB_TEXT === "string") ? SUB_TEXT : "";
}

/** 現在マップ・次マップカードを更新（常に現在時刻） */
function renderCurrent() {
  const state = computeRotation(config.rotation, nowSec());
  const info = mapInfo(state.item.key);

  // 背景（現在マップ画像をうっすら）
  if (info.image) el.bgLayer.style.backgroundImage = `url("${info.image}")`;
  else el.bgLayer.style.backgroundImage = mapGradient(state.item.key);

  applyVisual(el.currentVisual, state.item.key);
  el.currentNameEn.textContent = info.nameEn;
  el.currentNameJp.textContent = info.nameJa;
  el.currentRange.textContent = `${fmtJstHm(state.startSec)} 〜 ${fmtJstHm(state.endSec)} (JST)`;

  el.nextNameEn.textContent = mapInfo(state.nextItem.key).nameEn;
}

/** 日付チップを描画 */
function renderDateChips() {
  const todayStr = jstDateStr(nowSec());
  const frag = document.createDocumentFragment();
  for (let i = 0; i < DATE_CHIP_DAYS; i++) {
    const dStr = shiftDateStr(todayStr, i);
    const chip = document.createElement("button");
    chip.className = "date-chip" + (dStr === selectedDateStr ? " is-active" : "");
    chip.dataset.date = dStr;
    const label = i === 0 ? "今日" : fmtChipLabel(jstMidnightEpoch(dStr) + 12 * 3600);
    chip.textContent = label;
    chip.addEventListener("click", () => setDate(dStr));
    frag.appendChild(chip);
  }
  el.dateChips.replaceChildren(frag);
}

/** 選択日のローテカードを描画 */
function renderDay() {
  const now = nowSec();
  const items = buildDayTimeline(config.rotation, selectedDateStr);

  const head = toJst(jstMidnightEpoch(selectedDateStr) + 12 * 3600);
  el.dayHeading.textContent = `${head.month}/${head.day} (${DOW_JP[head.dow]}) のローテーション`;

  const frag = document.createDocumentFragment();
  items.forEach((entry) => {
    const isNow = entry.startSec <= now && now < entry.endSec;
    const info = mapInfo(entry.item.key);

    const card = document.createElement("div");
    card.className = "tl-card" + (isNow ? " is-now" : "");
    card.style.backgroundImage = info.image ? `url("${info.image}")` : mapGradient(entry.item.key);

    const overlay = document.createElement("div");
    overlay.className = "tl-overlay";

    if (isNow) {
      const live = document.createElement("span");
      live.className = "tl-live";
      live.innerHTML = '<span class="dot"></span>LIVE';
      overlay.appendChild(live);
    }

    const time = document.createElement("span");
    time.className = "tl-time";
    time.textContent = `${fmtJstHm(entry.startSec)} 〜 ${fmtJstHm(entry.endSec)}`;

    const name = document.createElement("span");
    name.className = "tl-name";
    name.textContent = info.nameEn;

    overlay.append(time, name);
    card.appendChild(overlay);
    frag.appendChild(card);
  });

  el.timeline.replaceChildren(frag);
}

/** 全体を再描画 */
function render() {
  renderHeader();
  renderCurrent();
  renderDateChips();
  renderDay();
  tick();
}

/** 1秒ごと：カウントダウン・タイトル更新。切替検知で再描画 */
function tick() {
  const state = computeRotation(config.rotation, nowSec());
  if (el.currentNameEn.textContent !== mapInfo(state.item.key).nameEn) {
    render();
    return;
  }
  el.countdown.textContent = fmtHms(state.remainSec);
  document.title = `${fmtRemainRough(state.remainSec)} | ${SITE_TITLE}`;
}

/** 選択日を変更 */
function setDate(dateStr) {
  selectedDateStr = dateStr;
  renderDateChips();
  renderDay();
}


/* ============================================================================
 *  6. 設定モーダル
 * ========================================================================== */

/** config → draft（編集用作業コピー：mapMaster は配列に展開） */
function configToDraft(c) {
  return {
    baseTime: c.rotation.baseTime,
    label: c.rotation.label,
    schedule: clone(c.rotation.schedule),
    mapList: Object.entries(c.mapMaster).map(([key, v]) => ({
      key, nameJa: v.nameJa, nameEn: v.nameEn, image: v.image,
    })),
  };
}

/** draft → config */
function draftToConfig(d) {
  const mapMaster = {};
  d.mapList.forEach((m) => {
    if (!m.key) return;
    mapMaster[m.key] = { nameJa: m.nameJa, nameEn: m.nameEn, image: m.image };
  });
  return {
    mapMaster,
    rotation: {
      label: d.label,
      baseTime: d.baseTime,
      schedule: d.schedule.map((s) => ({ key: s.key, durationMin: Number(s.durationMin) || 0 })),
    },
  };
}

/** モーダルを開く */
function openModal() {
  draft = configToDraft(config);
  document.getElementById("in-basetime").value = baseTimeToInput(draft.baseTime);
  document.getElementById("in-token").value = loadToken();
  document.getElementById("export-section").hidden = true;
  setSaveStatus("", null);
  renderRotRows();
  renderMapRows();
  el.modalOverlay.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeModal() {
  el.modalOverlay.hidden = true;
  document.body.style.overflow = "";
}

/* ---- 認証（設定を開く前の簡易パスワード） ---- */

/** このセッションで認証済みか */
function isAuthed() {
  try { return sessionStorage.getItem(AUTH_KEY) === "1"; } catch (e) { return false; }
}

/** 歯車クリック：認証済みなら設定へ、未認証なら認証モーダルを表示 */
function onGearClick() {
  if (isAuthed()) {
    openModal();
  } else {
    const err = document.getElementById("auth-error");
    err.hidden = true;
    const input = document.getElementById("auth-input");
    input.value = "";
    el.authOverlay.hidden = false;
    document.body.style.overflow = "hidden";
    input.focus();
  }
}

function closeAuth() {
  el.authOverlay.hidden = true;
  document.body.style.overflow = "";
}

/** パスワード判定：一致で sessionStorage に記録し設定を開く */
function submitAuth() {
  const input = document.getElementById("auth-input");
  if (input.value === SETTINGS_PASSWORD) {
    try { sessionStorage.setItem(AUTH_KEY, "1"); } catch (e) { /* 続行 */ }
    closeAuth();
    openModal();
  } else {
    document.getElementById("auth-error").hidden = false;
    input.select();
  }
}

/** ローテーション行を描画 */
function renderRotRows() {
  const wrap = document.getElementById("rot-rows");
  const frag = document.createDocumentFragment();

  draft.schedule.forEach((row, i) => {
    const r = document.createElement("div");
    r.className = "row row-rot";

    // マップ選択（プルダウン）
    const sel = document.createElement("select");
    draft.mapList.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.key;
      opt.textContent = `${m.nameJa}（${m.key}）`;
      sel.appendChild(opt);
    });
    // 現在の key がマスタに無い場合のフォールバック
    if (!draft.mapList.some((m) => m.key === row.key)) {
      const opt = document.createElement("option");
      opt.value = row.key;
      opt.textContent = `${row.key}（未登録）`;
      sel.appendChild(opt);
    }
    sel.value = row.key;
    sel.addEventListener("change", () => { draft.schedule[i].key = sel.value; });

    // 継続時間（分）
    const dur = document.createElement("input");
    dur.type = "number";
    dur.min = "1";
    dur.className = "num";
    dur.value = row.durationMin;
    dur.addEventListener("input", () => { draft.schedule[i].durationMin = dur.value; });
    const durWrap = document.createElement("span");
    durWrap.className = "num-wrap";
    durWrap.append(dur, document.createTextNode("分"));

    // 操作ボタン
    const up = mkBtn("↑", "上へ", () => { if (i > 0) { swap(draft.schedule, i, i - 1); renderRotRows(); } });
    const down = mkBtn("↓", "下へ", () => { if (i < draft.schedule.length - 1) { swap(draft.schedule, i, i + 1); renderRotRows(); } });
    const del = mkBtn("×", "削除", () => { draft.schedule.splice(i, 1); renderRotRows(); }, "btn-del");
    up.disabled = i === 0;
    down.disabled = i === draft.schedule.length - 1;

    const ops = document.createElement("span");
    ops.className = "row-ops";
    ops.append(up, down, del);

    r.append(sel, durWrap, ops);
    frag.appendChild(r);
  });

  wrap.replaceChildren(frag);
}

/** マップマスタ行を描画 */
function renderMapRows() {
  const wrap = document.getElementById("map-rows");
  const frag = document.createDocumentFragment();

  draft.mapList.forEach((m, i) => {
    const r = document.createElement("div");
    r.className = "row row-map";

    const key = mkInput(m.key, "キー", (v) => { m.key = v.trim(); });
    const ja = mkInput(m.nameJa, "日本語名", (v) => { m.nameJa = v; });
    const en = mkInput(m.nameEn, "英語名", (v) => { m.nameEn = v; });
    const img = mkInput(m.image, "画像パス", (v) => { m.image = v; });
    // key を変えたら選択肢も更新
    key.addEventListener("change", () => renderRotRows());

    const del = mkBtn("×", "削除", () => { draft.mapList.splice(i, 1); renderMapRows(); renderRotRows(); }, "btn-del");
    const ops = document.createElement("span");
    ops.className = "row-ops";
    ops.append(del);

    r.append(key, ja, en, img, ops);
    frag.appendChild(r);
  });

  wrap.replaceChildren(frag);
}

/* 小さなヘルパー */
function mkBtn(text, title, onClick, extra) {
  const b = document.createElement("button");
  b.className = "mini-btn" + (extra ? " " + extra : "");
  b.type = "button";
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}
function mkInput(value, placeholder, onInput) {
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = value || "";
  inp.placeholder = placeholder;
  inp.addEventListener("input", () => onInput(inp.value));
  return inp;
}
function swap(arr, a, b) { const t = arr[a]; arr[a] = arr[b]; arr[b] = t; }

/** モーダルの入力（基準時刻）を draft に取り込む */
function syncDraftBase() {
  const bt = document.getElementById("in-basetime").value;
  if (bt) draft.baseTime = inputToBaseTime(bt);
}

/* ---- GitHub トークンの保存/読み込み ---- */
function loadToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
}
function saveToken(tok) {
  try { localStorage.setItem(TOKEN_KEY, tok); } catch (e) { /* 続行 */ }
}

/** 保存ステータス表示（type: "ok" | "err" | "info" | null） */
function setSaveStatus(msg, type) {
  const el2 = document.getElementById("save-status");
  el2.textContent = msg || "";
  el2.hidden = !msg;
  el2.className = "save-status" + (type ? " is-" + type : "");
}

/**
 * UTF-8 文字列を Base64 に変換（日本語対応）。
 * btoa は Latin-1 しか扱えないため、一度 UTF-8 バイト列にしてから変換する。
 */
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * 保存（全体公開）：GitHub Contents API で rotation-data.js を直接コミット。
 *  1) GET で現在ファイルの sha 取得
 *  2) 新しい中身を生成して UTF-8 Base64 エンコード
 *  3) PUT でコミット
 * 成功後、localStorage にも保存して即座に画面へ反映する。
 */
async function onSave() {
  syncDraftBase();
  const newConfig = draftToConfig(draft);
  const token = document.getElementById("in-token").value.trim();

  if (!token) {
    setSaveStatus("GitHub トークンを入力してください（下の「GitHub トークン」欄）。", "err");
    return;
  }
  saveToken(token);

  const { owner, repo, branch, path } = GITHUB_CONFIG;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const btn = document.getElementById("btn-save");
  btn.disabled = true;
  setSaveStatus("保存中… GitHub にコミットしています。", "info");

  try {
    // 1) 現在の sha を取得
    let sha = undefined;
    const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
    if (getRes.status === 200) {
      const data = await getRes.json();
      sha = data.sha;
    } else if (getRes.status === 404) {
      sha = undefined; // ファイルが無ければ新規作成
    } else if (getRes.status === 401 || getRes.status === 403) {
      throw new Error("AUTH");
    } else {
      throw new Error("GET_" + getRes.status);
    }

    // 2) 新しい中身を生成 → Base64
    const fileText = generateFileText(newConfig);
    const contentB64 = utf8ToBase64(fileText);

    // 3) PUT でコミット
    const body = {
      message: "Update rotation settings from web",
      content: contentB64,
      branch,
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });

    if (putRes.status === 200 || putRes.status === 201) {
      // 即座にローカルへも反映（Pages 再ビルド待ちの間も正しく見えるように）
      config = newConfig;
      saveConfig(config);
      render();
      setSaveStatus("保存しました。GitHub Pages への反映には1〜2分かかります。", "ok");
    } else if (putRes.status === 401 || putRes.status === 403) {
      throw new Error("AUTH");
    } else if (putRes.status === 409) {
      throw new Error("CONFLICT");
    } else {
      let detail = "";
      try { detail = (await putRes.json()).message || ""; } catch (e) { /* noop */ }
      throw new Error("PUT_" + putRes.status + (detail ? "_" + detail : ""));
    }
  } catch (err) {
    const m = String(err.message || err);
    if (m === "AUTH") {
      setSaveStatus("トークンが無効か、権限が不足しています（Contents: Read and write が必要）。トークンを確認して再試行してください。", "err");
    } else if (m === "CONFLICT") {
      setSaveStatus("ファイルが競合しました（他の更新と衝突）。少し待ってからもう一度保存してください。", "err");
    } else if (m.startsWith("GET_") || m.startsWith("PUT_")) {
      setSaveStatus("GitHub への保存に失敗しました（" + m + "）。通信状態やリポジトリ設定を確認して再試行してください。", "err");
    } else {
      setSaveStatus("保存に失敗しました：" + m + "。ネットワークを確認して再試行してください。", "err");
    }
  } finally {
    btn.disabled = false;
  }
}

/** デフォルトに戻す */
function onReset() {
  if (!confirm("設定を rotation-data.js の初期値に戻します。よろしいですか？")) return;
  try { localStorage.removeItem(CONFIG_KEY); } catch (e) { /* 続行 */ }
  config = defaultConfig();
  selectedDateStr = jstDateStr(nowSec());
  render();
  // モーダルを開き直して初期値を反映
  openModal();
}

/** エクスポート：rotation-data.js 全体のコードを生成して表示 */
function onExport() {
  syncDraftBase();
  const cfg = draftToConfig(draft);
  document.getElementById("export-area").value = generateFileText(cfg);
  document.getElementById("export-section").hidden = false;
  document.getElementById("copy-msg").hidden = true;
  document.getElementById("export-area").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** JS のオブジェクトキーとして安全な表記にする */
function jsKey(k) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}

/** config → rotation-data.js 全体のテキスト */
function generateFileText(cfg) {
  const mapLines = Object.entries(cfg.mapMaster).map(([k, v]) =>
    `  ${jsKey(k)}: { nameJa: ${JSON.stringify(v.nameJa)}, nameEn: ${JSON.stringify(v.nameEn)}, image: ${JSON.stringify(v.image)} },`
  ).join("\n");

  const schedLines = cfg.rotation.schedule.map((s) =>
    `    { key: ${JSON.stringify(s.key)}, durationMin: ${Number(s.durationMin) || 0} },`
  ).join("\n");

  const bt = cfg.rotation.baseTime;
  const t = toJst(bt);
  const btComment = `JST ${t.year}/${pad2(t.month)}/${pad2(t.day)} ${pad2(t.hour)}:${pad2(t.min)} に先頭マップ開始`;

  return `/* ============================================================================
 *  rotation-data.js — ルピンスペシャル / マップローテーション定義
 * ----------------------------------------------------------------------------
 *  設定パネル（歯車）からエクスポートしたコードです。このファイルに上書きして
 *  GitHub に push すると全閲覧者に反映されます。
 *  baseTime は「schedule 先頭マップが開始した UNIX秒(UTC)」。
 *  schedule は「マップキー + 継続時間(分)」のみを持ち、名前/画像は MAP_MASTER から引く。
 * ========================================================================== */

const SEASON_LABEL = ${JSON.stringify(SEASON_LABEL)};
const SUB_TEXT = ${JSON.stringify(SUB_TEXT)};

const MAP_MASTER = {
${mapLines}
};

const ROTATION = {
  label: ${JSON.stringify(cfg.rotation.label)},
  baseTime: ${bt}, // ${btComment}
  schedule: [
${schedLines}
  ],
};
`;
}

/** クリップボードにコピー */
function onCopy() {
  const ta = document.getElementById("export-area");
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(ta.value).then(() => {}).catch(() => {});
    ok = true;
  }
  const msg = document.getElementById("copy-msg");
  msg.hidden = !ok;
}


/* ============================================================================
 *  7. 初期化
 * ========================================================================== */

function init() {
  el = {
    bgLayer:       document.getElementById("bg-layer"),
    seasonLabel:   document.getElementById("season-label"),
    subText:       document.getElementById("sub-text"),
    currentVisual: document.getElementById("current-visual"),
    currentNameEn: document.getElementById("current-name-en"),
    currentNameJp: document.getElementById("current-name-jp"),
    currentRange:  document.getElementById("current-range"),
    countdown:     document.getElementById("countdown"),
    nextNameEn:    document.getElementById("next-name-en"),
    dateChips:     document.getElementById("date-chips"),
    dayHeading:    document.getElementById("day-heading"),
    timeline:      document.getElementById("timeline"),
    modalOverlay:  document.getElementById("modal-overlay"),
  };

  config = loadConfig();
  selectedDateStr = jstDateStr(nowSec());

  // 日付の前後矢印（今日〜今日+6 の範囲でクランプ）
  document.getElementById("date-prev").addEventListener("click", () => {
    const todayStr = jstDateStr(nowSec());
    const cand = shiftDateStr(selectedDateStr, -1);
    if (jstMidnightEpoch(cand) >= jstMidnightEpoch(todayStr)) setDate(cand);
  });
  document.getElementById("date-next").addEventListener("click", () => {
    const todayStr = jstDateStr(nowSec());
    const maxStr = shiftDateStr(todayStr, DATE_CHIP_DAYS - 1);
    const cand = shiftDateStr(selectedDateStr, +1);
    if (jstMidnightEpoch(cand) <= jstMidnightEpoch(maxStr)) setDate(cand);
  });

  // 設定モーダル（歯車 → パスワード認証 → 設定）
  document.getElementById("gear-btn").addEventListener("click", onGearClick);
  document.getElementById("modal-close").addEventListener("click", closeModal);
  el.modalOverlay.addEventListener("click", (e) => {
    if (e.target === el.modalOverlay) closeModal();
  });

  // 認証モーダル
  document.getElementById("auth-close").addEventListener("click", closeAuth);
  document.getElementById("auth-submit").addEventListener("click", submitAuth);
  document.getElementById("auth-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAuth();
  });
  el.authOverlay = document.getElementById("auth-overlay");
  el.authOverlay.addEventListener("click", (e) => {
    if (e.target === el.authOverlay) closeAuth();
  });
  document.getElementById("btn-add-rot").addEventListener("click", () => {
    const firstKey = draft.mapList[0] ? draft.mapList[0].key : "";
    draft.schedule.push({ key: firstKey, durationMin: 270 });
    renderRotRows();
  });
  document.getElementById("btn-add-map").addEventListener("click", () => {
    draft.mapList.push({ key: "", nameJa: "", nameEn: "", image: "" });
    renderMapRows();
  });
  document.getElementById("btn-save").addEventListener("click", onSave);
  document.getElementById("btn-reset").addEventListener("click", onReset);
  document.getElementById("btn-export").addEventListener("click", onExport);
  document.getElementById("btn-copy").addEventListener("click", onCopy);

  render();

  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(tick, 1000);
}

document.addEventListener("DOMContentLoaded", init);
