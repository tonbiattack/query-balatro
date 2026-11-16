/**
 * 役（ランク）定義。
 *
 * RANKS は優先度の高い順。最初に成立した役を採用する（上位役が下位役を兼ねる）。
 * 仕様書の「ペア相当 ×2 / ストレート相当 ×4 / フルハウス相当 ×6」を核に、
 * 役の階段をなだらかにするため中間役を足している。
 */

import type { RankDef } from "../types.ts";

/** 役の全定義（優先度の高い順）。 */
export const RANKS: RankDef[] = [
  {
    id: "royal",
    label: "ロイヤル相当",
    mult: 10,
    requires: {
      allKinds: ["JOIN", "WINDOW", "GROUP_BY"],
      minRows: 1,
    },
    flavor: "JOIN・ウィンドウ・集約がすべて揃った究極形。",
  },
  {
    id: "full-house",
    label: "フルハウス相当",
    mult: 6,
    requires: {
      allKinds: ["WINDOW"],
      minRows: 1,
    },
    flavor: "ウィンドウ関数入り。",
  },
  {
    id: "straight",
    label: "ストレート相当",
    mult: 4,
    requires: {
      allKinds: ["JOIN"],
      minRows: 1,
    },
    flavor: "JOIN で別テーブルを繋いだ。",
  },
  {
    id: "flush",
    label: "フラッシュ相当",
    mult: 3,
    requires: {
      anyKinds: ["BETWEEN", "IN"],
      minRows: 1,
    },
    flavor: "範囲・列挙で絞り込んだ。",
  },
  {
    id: "two-pair",
    label: "ツーペア相当",
    mult: 2.5,
    requires: {
      anyKinds: ["LIKE"],
      minRows: 1,
    },
    flavor: "LIKE で部分一致。",
  },
  {
    id: "pair",
    label: "ペア相当",
    mult: 2,
    requires: {
      allKinds: ["WHERE"],
      minRows: 1,
    },
    flavor: "単一 WHERE。",
  },
  {
    id: "high-card",
    label: "ハイカード相当",
    mult: 1,
    requires: {
      minRows: 1,
    },
    flavor: "役なし。何かは返ってきた。",
  },
];

/** 役が成立しなかった（0行）ときの倍率。 */
export const NO_RANK_MULT = 0;

/** ID から役を引く。 */
export function findRank(id: string): RankDef | undefined {
  return RANKS.find((r) => r.id === id);
}
