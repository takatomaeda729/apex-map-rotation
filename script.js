/* ============================================================================
 *  script.js — Apex マップローテーション 計算 & 表示ロジック（ランク専用）
 * ----------------------------------------------------------------------------
 *  時刻はすべて UTC(epoch 秒) で計算し、表示のみ JST(Asia/Tokyo) に変換する。
 *  閲覧者の端末のタイムゾーン設定に依存せず、常に JST で表示する。
 * ========================================================================== */

"use strict";

/* ----------------------------------------------------------------------------
 *  定数・状態
 * -------------------------------------------------------------------------- */
const MODE = "ranked";              // ランク専用（rotation-data.js の ROTATIONS.ranked）
const SITE_TITLE = "Apexマップローテ"; // ページタイトルのベース

// 日付指定タイムラインで表示中の日付（JST の "YYYY-MM-DD"）
let selectedDateStr = null;
// カウントダウン用タイマー ID
let tickTimer = null;


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

/** UNIX 秒 → "HH:MM"(JST) の文字列 */
function fmtJstHm(epochSec) {
  const t = toJst(epochSec);
  return `${pad2(t.hour)}:${pad2(t.min)}`;
}

/** UNIX 秒 → "M/D(曜) HH:MM"(JST) の文字列 */
function fmtJstFull(epochSec) {
  const t = toJst(epochSec);
  return `${t.month}/${t.day}(${DOW_JP[t.dow]}) ${pad2(t.hour)}:${pad2(t.min)}`;
}

/** UNIX 秒 → JST の日付文字列 "YYYY-MM-DD"（date input 用） */
function jstDateStr(epochSec) {
  const t = toJst(epochSec);
  return `${t.year}-${pad2(t.month)}-${pad2(t.day)}`;
}

/**
 * JST の "YYYY-MM-DD" → その日の JST 00:00 の UNIX 秒(UTC)。
 *   JST 00:00 = 前日の UTC 15:00 なので、UTC 換算から 9 時間引く。
 */
function jstMidnightEpoch(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, 0, 0, 0) / 1000) - 9 * 3600;
}

/** "YYYY-MM-DD" を days 日ずらした "YYYY-MM-DD" を返す */
function shiftDateStr(dateStr, days) {
  // 正午基準でずらして夏時間等の影響を避ける（JST は影響なしだが安全側）
  return jstDateStr(jstMidnightEpoch(dateStr) + 12 * 3600 + days * 86400);
}

/** 2桁ゼロ埋め */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 秒数 → "HH:MM:SS" */
function fmtHms(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}

/** 残り秒数 → タイトル用のざっくり表記（例: "あと32分" / "あと1時間5分"） */
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
 * ----------------------------------------------------------------------------
 *  baseTime と schedule から、指定時刻におけるローテ状態を算出する。
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
 * 指定した JST 日付("YYYY-MM-DD")の 1 日分（00:00〜翌00:00）に
 * かかるローテ予定を配列で返す。
 *   [{ item, startSec, endSec }, ...]
 *   ・日をまたいで継続しているマップも先頭に含む。
 */
function buildDayTimeline(rotation, dateStr) {
  const dayStart = jstMidnightEpoch(dateStr);
  const dayEnd = dayStart + 86400;
  const list = [];

  // 00:00 時点で進行中のマップから順に積み上げる。
  let cur = computeRotation(rotation, dayStart);
  let index = cur.index;
  let startSec = cur.startSec;

  let guard = 0;
  while (startSec < dayEnd && guard < 1000) {
    const item = rotation.schedule[index];
    const endSec = startSec + item.durationMin * 60;
    if (endSec > dayStart) {
      list.push({ item, startSec, endSec });
    }
    startSec = endSec;
    index = (index + 1) % rotation.schedule.length;
    guard++;
  }
  return list;
}


/* ============================================================================
 *  3. 表示ヘルパー
 * ========================================================================== */

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
function applyMapVisual(el, key) {
  const meta = MAP_META[key];
  if (meta && meta.image) {
    el.style.backgroundImage = `url("${meta.image}")`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    el.classList.remove("is-placeholder");
  } else {
    el.style.backgroundImage = mapGradient(key);
    el.classList.add("is-placeholder");
  }
}


/* ============================================================================
 *  4. 描画
 * ========================================================================== */

let el = {}; // DOM 参照（init で設定）

/** 現在マップ・次マップカードを更新（常に現在時刻ベース） */
function renderCurrent() {
  const rotation = ROTATIONS[MODE];
  const state = computeRotation(rotation, nowSec());

  el.currentName.textContent = state.item.map;
  applyMapVisual(el.currentVisual, state.item.key);

  el.nextName.textContent = state.nextItem.map;
  el.nextStart.textContent = fmtJstFull(state.endSec);
  applyMapVisual(el.nextVisual, state.nextItem.key);
}

/** 選択中の日付のローテを描画 */
function renderDay() {
  const rotation = ROTATIONS[MODE];
  const items = buildDayTimeline(rotation, selectedDateStr);
  const now = nowSec();

  // 見出し（例:「7/22(火) のローテーション」）
  const head = toJst(jstMidnightEpoch(selectedDateStr) + 12 * 3600); // 正午で曜日判定
  el.dayHeading.textContent = `${head.month}/${head.day}(${DOW_JP[head.dow]}) のローテーション`;

  const frag = document.createDocumentFragment();
  items.forEach((entry) => {
    const isNow = entry.startSec <= now && now < entry.endSec; // 現在進行中か

    const row = document.createElement("div");
    row.className = "timeline-row";
    if (isNow) row.classList.add("is-now");

    const swatch = document.createElement("span");
    swatch.className = "timeline-swatch";
    swatch.style.backgroundImage = mapGradient(entry.item.key);

    const time = document.createElement("span");
    time.className = "timeline-time";
    // 開始〜終了(JST)。日をまたぐ表示も HH:MM で表す。
    time.textContent = `${fmtJstHm(entry.startSec)}〜${fmtJstHm(entry.endSec)}`;

    const name = document.createElement("span");
    name.className = "timeline-name";
    name.textContent = entry.item.map;

    const badge = document.createElement("span");
    badge.className = "timeline-badge";
    if (isNow) badge.textContent = "現在";

    row.append(swatch, time, name, badge);
    frag.appendChild(row);
  });

  el.timeline.replaceChildren(frag);
}

/** 全体を描画し直す */
function render() {
  renderCurrent();
  renderDay();
  tick(); // 秒更新パートも即時反映
}

/** 1秒ごと：カウントダウン・進行度・タイトルを更新 */
function tick() {
  const rotation = ROTATIONS[MODE];
  const state = computeRotation(rotation, nowSec());

  // マップが切り替わったらカード全体を作り直す（リロード不要）
  if (el.currentName.textContent !== state.item.map) {
    render();
    return;
  }

  el.countdown.textContent = fmtHms(state.remainSec);

  const pct = Math.min(100, Math.max(0, state.progress * 100));
  el.progressFill.style.width = pct.toFixed(2) + "%";
  el.progressLabel.textContent = pct.toFixed(1) + "%";

  document.title = `${fmtRemainRough(state.remainSec)} | ${SITE_TITLE}`;
}


/* ============================================================================
 *  5. 初期化・イベント
 * ========================================================================== */

/** 選択日を変更して再描画 */
function setDate(dateStr) {
  selectedDateStr = dateStr;
  el.dateInput.value = dateStr;
  renderDay();
}

function init() {
  el = {
    currentName:   document.getElementById("current-name"),
    currentVisual: document.getElementById("current-visual"),
    countdown:     document.getElementById("countdown"),
    progressFill:  document.getElementById("progress-fill"),
    progressLabel: document.getElementById("progress-label"),
    nextName:      document.getElementById("next-name"),
    nextStart:     document.getElementById("next-start"),
    nextVisual:    document.getElementById("next-visual"),
    dateInput:     document.getElementById("date-input"),
    dayHeading:    document.getElementById("day-heading"),
    timeline:      document.getElementById("timeline"),
  };

  // 初期日付 = 今日（JST）
  selectedDateStr = jstDateStr(nowSec());
  el.dateInput.value = selectedDateStr;

  // 日付イベント
  el.dateInput.addEventListener("change", () => {
    if (el.dateInput.value) setDate(el.dateInput.value);
  });
  document.getElementById("prev-day").addEventListener("click", () => {
    setDate(shiftDateStr(selectedDateStr, -1));
  });
  document.getElementById("next-day").addEventListener("click", () => {
    setDate(shiftDateStr(selectedDateStr, +1));
  });
  document.getElementById("today-btn").addEventListener("click", () => {
    setDate(jstDateStr(nowSec()));
  });

  render();

  // 1秒ごとの更新を開始
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(tick, 1000);
}

document.addEventListener("DOMContentLoaded", init);
