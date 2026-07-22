/* ============================================================================
 *  script.js — ルピンスペシャル / Apex マップローテーション ロジック
 * ----------------------------------------------------------------------------
 *  時刻はすべて UTC(epoch 秒) で計算し、表示のみ JST(Asia/Tokyo) に変換する。
 *  閲覧者の端末のタイムゾーン設定に依存せず、常に JST で表示する。
 * ========================================================================== */

"use strict";

/* ----------------------------------------------------------------------------
 *  定数・状態
 * -------------------------------------------------------------------------- */
const STORAGE_KEY = "lupin-rotation-mode"; // タブ選択状態の保存キー
const TIMELINE_HOURS = 48;                 // タイムライン表示時間（時間）
const SITE_TITLE = "ルピンスペシャル";       // ページタイトルのベース

let currentMode = "battle_royale"; // "battle_royale" | "ranked"
let tickTimer = null;              // カウントダウン用タイマー ID


/* ============================================================================
 *  1. 時刻ユーティリティ
 * ========================================================================== */

/** 現在の UNIX 時間（秒, UTC）を返す */
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * 正しい剰余（modulo）。JS の % は負の値に対して負を返すため、
 * 基準時刻より過去でも常に 0 以上の余りになるようにする。
 *   例: euclideanMod(-1, 10) === 9
 */
function euclideanMod(a, n) {
  return ((a % n) + n) % n;
}

/**
 * UNIX 秒 → JST の各フィールドを取り出す。
 * 端末のタイムゾーンに依存しないよう、UTC に +9時間 して UTC 系の
 * getter で読み出す（= JST の値になる）。
 */
function toJst(epochSec) {
  const d = new Date((epochSec + 9 * 3600) * 1000);
  return {
    year:  d.getUTCFullYear(),
    month: d.getUTCMonth() + 1, // 1-12
    day:   d.getUTCDate(),
    hour:  d.getUTCHours(),
    min:   d.getUTCMinutes(),
    dow:   d.getUTCDay(),       // 0=日 .. 6=土
  };
}

const DOW_JP = ["日", "月", "火", "水", "木", "金", "土"];

/** 2桁ゼロ埋め */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/** UNIX 秒 → "HH:MM"(JST) */
function fmtJstHm(epochSec) {
  const t = toJst(epochSec);
  return `${pad2(t.hour)}:${pad2(t.min)}`;
}

/** UNIX 秒 → JST の "YYYY-MM-DD"（日付グループのキー用） */
function jstDateKey(epochSec) {
  const t = toJst(epochSec);
  return `${t.year}-${pad2(t.month)}-${pad2(t.day)}`;
}

/** UNIX 秒 → 見出し用 "M/D (曜)"(JST) */
function fmtJstDateHead(epochSec) {
  const t = toJst(epochSec);
  return `${t.month}/${t.day} (${DOW_JP[t.dow]})`;
}

/** 秒数 → "HH:MM:SS" */
function fmtHms(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}

/** 残り秒数 → タイトル用のざっくり表記（例: "あと32分"） */
function fmtRemainRough(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `あと${h}時間${m}分`;
  if (m > 0) return `あと${m}分`;
  return `あと${s}秒`;
}


/* ============================================================================
 *  2. ローテーション計算（汎用）
 * ========================================================================== */

/** 指定した rotation の schedule 合計時間（秒）を返す */
function totalCycleSec(rotation) {
  return rotation.schedule.reduce((sum, item) => sum + item.durationMin * 60, 0);
}

/**
 * 指定時刻 atSec におけるローテ状態を計算する。
 *   - schedule 合計時間で割った余り（負の剰余対応）から現在位置を求める。
 */
function computeRotation(rotation, atSec) {
  const cycle = totalCycleSec(rotation);
  const offset = euclideanMod(atSec - rotation.baseTime, cycle);

  let acc = 0;
  let index = 0;
  for (let i = 0; i < rotation.schedule.length; i++) {
    const dur = rotation.schedule[i].durationMin * 60;
    if (offset < acc + dur) {
      index = i;
      break;
    }
    acc += dur;
  }

  const item = rotation.schedule[index];
  const durationSec = item.durationMin * 60;
  const elapsedSec = offset - acc;
  const remainSec = durationSec - elapsedSec;
  const startSec = atSec - elapsedSec;
  const endSec = startSec + durationSec;
  const progress = durationSec > 0 ? elapsedSec / durationSec : 0;
  const nextIndex = (index + 1) % rotation.schedule.length;

  return {
    index, item, startSec, endSec, remainSec, elapsedSec, durationSec, progress,
    nextIndex, nextItem: rotation.schedule[nextIndex],
  };
}

/**
 * atSec 以降の今後 hours 時間分のローテ予定を配列で返す。
 *   [{ item, startSec, endSec }, ...]
 */
function buildTimeline(rotation, atSec, hours) {
  const horizon = atSec + hours * 3600;
  const list = [];

  let cur = computeRotation(rotation, atSec);
  let index = cur.index;
  let startSec = cur.startSec;

  let guard = 0;
  while (startSec < horizon && guard < 2000) {
    const item = rotation.schedule[index];
    const endSec = startSec + item.durationMin * 60;
    list.push({ item, startSec, endSec });
    startSec = endSec;
    index = (index + 1) % rotation.schedule.length;
    guard++;
  }
  return list;
}


/* ============================================================================
 *  3. 表示ヘルパー
 * ========================================================================== */

/** マップの英語名を返す（MAP_META に無ければ日本語名で代替） */
function mapEn(item) {
  const meta = MAP_META[item.key];
  return (meta && meta.en) || item.map;
}

/** マップのプレースホルダー背景（CSS linear-gradient 文字列）を返す */
function mapGradient(key) {
  const meta = MAP_META[key];
  if (meta && Array.isArray(meta.colors) && meta.colors.length >= 2) {
    return `linear-gradient(135deg, ${meta.colors[0]}, ${meta.colors[1]})`;
  }
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) & 0xffffffff;
  }
  const hue = euclideanMod(hash, 360);
  return `linear-gradient(135deg, hsl(${hue} 45% 32%), hsl(${hue} 55% 12%))`;
}

/** マップのビジュアル（画像 or グラデーション）を DOM 要素に適用 */
function applyMapVisual(el, item) {
  if (item.image) {
    el.style.backgroundImage = `url("${item.image}")`;
    el.classList.remove("is-placeholder");
  } else {
    el.style.backgroundImage = mapGradient(item.key);
    el.classList.add("is-placeholder");
  }
}


/* ============================================================================
 *  4. 描画
 * ========================================================================== */

let el = {}; // DOM 参照（init で設定）

/** モード切替やロード時に呼ぶ：カード全体を再構築 */
function render() {
  const rotation = ROTATIONS[currentMode];
  const state = computeRotation(rotation, nowSec());

  // --- 背景（現在マップ画像をうっすら） ---
  if (state.item.image) {
    el.bgLayer.style.backgroundImage = `url("${state.item.image}")`;
  } else {
    el.bgLayer.style.backgroundImage = mapGradient(state.item.key);
  }

  // --- 現在のマップ ---
  applyMapVisual(el.currentVisual, state.item);
  el.currentNameEn.textContent = mapEn(state.item);
  el.currentNameJp.textContent = state.item.map;
  el.currentRange.textContent = `${fmtJstHm(state.startSec)} 〜 ${fmtJstHm(state.endSec)} (JST)`;

  // --- 次のマップ ---
  el.nextNameEn.textContent = mapEn(state.nextItem);

  // --- タイムライン ---
  renderTimeline(rotation);

  // --- タブの見た目 ---
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.mode === currentMode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });

  // 秒更新パートも即時反映
  tick();
}

/** 今後48時間のタイムラインを日付ごとにグループ化して描画 */
function renderTimeline(rotation) {
  const now = nowSec();
  const items = buildTimeline(rotation, now, TIMELINE_HOURS);

  // 日付キーごとにグループ化（挿入順を保持）
  const groups = new Map();
  items.forEach((entry) => {
    const key = jstDateKey(entry.startSec);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });

  const frag = document.createDocumentFragment();

  groups.forEach((entries) => {
    // 日付見出し
    const head = document.createElement("p");
    head.className = "date-head";
    head.textContent = fmtJstDateHead(entries[0].startSec);
    frag.appendChild(head);

    // その日のカード群（横並び・折り返し）
    const row = document.createElement("div");
    row.className = "tl-row";

    entries.forEach((entry) => {
      const isNow = entry.startSec <= now && now < entry.endSec;

      const card = document.createElement("div");
      card.className = "tl-card" + (isNow ? " is-now" : "");

      // サムネイル背景
      if (entry.item.image) {
        card.style.backgroundImage = `url("${entry.item.image}")`;
      } else {
        card.style.backgroundImage = mapGradient(entry.item.key);
      }

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
      name.textContent = mapEn(entry.item);

      overlay.append(time, name);
      card.appendChild(overlay);
      row.appendChild(card);
    });

    frag.appendChild(row);
  });

  el.timeline.replaceChildren(frag);
}

/** 1秒ごと：カウントダウン・タイトルを更新。切替時はカード再構築 */
function tick() {
  const rotation = ROTATIONS[currentMode];
  const state = computeRotation(rotation, nowSec());

  // マップが切り替わったらカード全体を作り直す（リロード不要）
  if (el.currentNameEn.textContent !== mapEn(state.item)) {
    render();
    return;
  }

  el.countdown.textContent = fmtHms(state.remainSec);
  document.title = `${fmtRemainRough(state.remainSec)} | ${SITE_TITLE}`;
}


/* ============================================================================
 *  5. 初期化・イベント
 * ========================================================================== */

/** localStorage から前回のモードを復元 */
function restoreMode() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && ROTATIONS[saved]) currentMode = saved;
  } catch (e) { /* 使えなくても既定モードで動作 */ }
}

/** モードを切り替えて保存 */
function setMode(mode) {
  if (!ROTATIONS[mode]) return;
  currentMode = mode;
  try { localStorage.setItem(STORAGE_KEY, mode); } catch (e) { /* 続行 */ }
  render();
}

function init() {
  el = {
    bgLayer:       document.getElementById("bg-layer"),
    currentVisual: document.getElementById("current-visual"),
    currentNameEn: document.getElementById("current-name-en"),
    currentNameJp: document.getElementById("current-name-jp"),
    currentRange:  document.getElementById("current-range"),
    countdown:     document.getElementById("countdown"),
    nextNameEn:    document.getElementById("next-name-en"),
    timeline:      document.getElementById("timeline"),
  };

  // ヘッダーのシーズン表記を rotation-data.js の定数から反映
  const seasonEl = document.getElementById("season-label");
  if (seasonEl && typeof SEASON_LABEL === "string") {
    seasonEl.textContent = SEASON_LABEL;
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
  });

  restoreMode();
  render();

  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(tick, 1000);
}

document.addEventListener("DOMContentLoaded", init);
