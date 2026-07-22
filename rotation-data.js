/* ============================================================================
 *  rotation-data.js — ルピンスペシャル / マップローテーション定義
 * ----------------------------------------------------------------------------
 *  設定パネル（歯車）からエクスポートしたコードです。このファイルに上書きして
 *  GitHub に push すると全閲覧者に反映されます。
 *  baseTime は「schedule 先頭マップが開始した UNIX秒(UTC)」。
 *  schedule は「マップキー + 継続時間(分)」のみを持ち、名前/画像は MAP_MASTER から引く。
 * ========================================================================== */

const SEASON_LABEL = "for SEASON30";
const SUB_TEXT = "APEX MAP ROTATION";

const IMAGE_LIST = [
  "images/e_district.jpg",
  "images/e_district2.jpg",
  "images/storm_point.jpg",
  "images/worlds_edge.png",
  "images/olympus.jpg",
  "images/kings_canyon.jpg",
  "images/broken_moon.jpg",
];

const MAP_MASTER = {
  storm_point: { nameJa: "ストームポイント", nameEn: "Storm Point", image: "images/e_district2.jpg" },
  worlds_edge: { nameJa: "ワールズエッジ", nameEn: "World's Edge", image: "images/worlds_edge.png" },
  e_district: { nameJa: "Eディストリクト", nameEn: "E-District", image: "images/e_district.jpg" },
  olympus: { nameJa: "オリンパス", nameEn: "Olympus", image: "images/olympus.jpg" },
  kings_canyon: { nameJa: "キングスキャニオン", nameEn: "Kings Canyon", image: "images/kings_canyon.jpg" },
  broken_moon: { nameJa: "ブロークンムーン", nameEn: "Broken Moon", image: "images/broken_moon.jpg" },
};

const ROTATION = {
  label: "ランク",
  baseTime: 1784691000, // JST 2026/07/22 12:30 に先頭マップ開始
  schedule: [
    { key: "storm_point", durationMin: 270 },
    { key: "worlds_edge", durationMin: 270 },
    { key: "e_district", durationMin: 270 },
  ],
};
