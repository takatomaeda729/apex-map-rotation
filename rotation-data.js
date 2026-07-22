/* ============================================================================
 *  rotation-data.js — ルピンスペシャル / マップローテーション定義
 * ============================================================================
 *
 *  ★ このファイルだけを編集すればシーズン更新に対応できます。★
 *  （index.html / script.js / style.css は触らなくてOK）
 *
 *  ※ サイト上の「設定」パネル（ヘッダー右の歯車）からも編集できます。
 *     そちらで編集した内容はブラウザの localStorage に保存され、そのブラウザ
 *     でのみ反映されます。全閲覧者に反映したい場合は、設定パネルの
 *     「エクスポート」で出力されるコードを、この rotation-data.js に上書きして
 *     GitHub に push してください。
 *
 * ----------------------------------------------------------------------------
 *  ■ シーズン更新時の編集手順
 * ----------------------------------------------------------------------------
 *
 *  1) baseTime（基準時刻）の求め方
 *  ---------------------------------
 *  baseTime は「schedule の 1 番目のマップが切り替わった瞬間」の
 *  UNIX時間（秒, UTC）です。
 *
 *   ・JST の日時 → UNIX秒 への変換例（ブラウザの開発者ツールのコンソールで）:
 *       // 例: JST 2026/07/22 12:30 に開始 → UTC 2026/07/22 03:30
 *       Math.floor(Date.UTC(2026, 6, 22, 3, 30, 0) / 1000)
 *       //   ↑月は 0 始まり（7月 = 6）。結果 = 1784691000
 *   ・過去・未来どちらの時刻でも計算は正しく動きます（負の剰余対応済み）。
 *
 *  2) schedule（ローテーション配列）の書き換え方
 *  ---------------------------------------------
 *   ・schedule は «マップキー(key) + 継続時間(durationMin)» だけを持ちます。
 *     マップ名や画像は下の MAP_MASTER から key で引かれます。
 *   ・key は MAP_MASTER に存在するものを指定してください。
 *   ・durationMin が実測とズレていたらその数値だけ直せばOKです。
 *
 *  3) 新しいマップを追加したいとき
 *  --------------------------------
 *   ・MAP_MASTER に «キー: { nameJa, nameEn, image }» を追加すれば、
 *     schedule からその key を使えるようになります。
 * ========================================================================== */


/* ----------------------------------------------------------------------------
 *  ヘッダーのテキスト
 *   seasonLabel … ロゴ右の「for SEASON30」の文言
 *   subText     … サブテキスト（「APEX MAP ROTATION」相当）
 * -------------------------------------------------------------------------- */
const SEASON_LABEL = "for SEASON30";
const SUB_TEXT = "APEX MAP ROTATION";


/* ----------------------------------------------------------------------------
 *  選択可能な画像の一覧
 *   設定パネルのマップ画像プルダウンの選択肢になります。
 *   新しい画像を images/ に追加したら、この配列に1行足すだけで選べます。
 * -------------------------------------------------------------------------- */
const IMAGE_LIST = [
  "images/e_district.jpg",
  "images/e_district2.jpg",
  "images/storm_point.jpg",
  "images/worlds_edge.png",
  "images/olympus.jpg",
  "images/kings_canyon.jpg",
  "images/broken_moon.jpg",
];


/* ----------------------------------------------------------------------------
 *  マップマスタ（全マップの定義）
 *   key: { nameJa: 日本語名, nameEn: 英語名, image: 画像パス }
 * -------------------------------------------------------------------------- */
const MAP_MASTER = {
  storm_point:  { nameJa: "ストームポイント",   nameEn: "Storm Point",   image: "images/storm_point.jpg" },
  worlds_edge:  { nameJa: "ワールズエッジ",     nameEn: "World's Edge",  image: "images/worlds_edge.png" },
  e_district:   { nameJa: "Eディストリクト",    nameEn: "E-District",    image: "images/e_district2.jpg" },
  olympus:      { nameJa: "オリンパス",         nameEn: "Olympus",       image: "images/olympus.jpg" },
  kings_canyon: { nameJa: "キングスキャニオン", nameEn: "Kings Canyon",  image: "images/kings_canyon.jpg" },
  broken_moon:  { nameJa: "ブロークンムーン",   nameEn: "Broken Moon",   image: "images/broken_moon.jpg" },
};


/* ----------------------------------------------------------------------------
 *  ローテーション定義（1本のみ）
 *   label   … 表示用ラベル
 *   baseTime… 先頭マップが開始した UNIX秒(UTC)
 *   schedule… [{ key, durationMin }] を順番に無限ループ
 * -------------------------------------------------------------------------- */
const ROTATION = {
  label: "ランク",
  baseTime: 1784691000, // JST 2026/07/22 12:30 にストームポイント開始 = UTC 03:30
  schedule: [
    { key: "storm_point", durationMin: 270 },
    { key: "worlds_edge", durationMin: 270 },
    { key: "e_district",  durationMin: 270 },
  ],
};
