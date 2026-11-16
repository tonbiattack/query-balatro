/**
 * ジョーカー定義。
 *
 * 効果はデータで宣言し、logic 側が評価する（types.ts の JokerEffect）。
 * 仕様書の例「NULL行を含むクエリはマルチ+4」「LIKE を使うたびチップ+30」を核に、
 * 断片の選び方に意味の差が出るよう6種を用意する。
 *
 * ## 数値の決め方
 *
 * ジョーカーは「積むほど伸びる」ことが面白さの核だが、伸びすぎると目標値が無意味になる。
 * 実測で調整した結果、マルチ加算系は **+2〜+5 の定額**、チップ加算系は
 * **行数・枚数に比例** という配分にしている。
 * 特に NULL 系を「行数比例」にすると 58行 × 4 = +232 マルチになり崩壊するため、
 * 仕様書の「マルチ+4」を**定額**として解釈している。
 */

import type { JokerDef } from "../types.ts";

/** ジョーカーの全定義。 */
export const JOKERS: JokerDef[] = [
  {
    id: "null-mult",
    name: "NULL の使者",
    description: "NULL を含む行があればマルチ +4",
    cost: 4,
    effect: { type: "multIfNull", value: 4 },
  },
  {
    id: "like-chips",
    name: "LIKE の釣り人",
    description: "LIKE を含む断片1枚につきチップ +30",
    cost: 4,
    effect: { type: "chipsPerLike", value: 30 },
  },
  {
    id: "row-chips",
    name: "行の蒐集家",
    description: "返却行1行につきチップ +5",
    cost: 5,
    effect: { type: "chipsPerRow", value: 5 },
  },
  {
    id: "window-mult",
    name: "窓の魔術師",
    description: "WINDOW を含む断片1枚につきマルチ +3",
    cost: 6,
    effect: { type: "multPerKind", kind: "WINDOW", value: 3 },
  },
  {
    id: "no-order-mult",
    name: "秩序の否定",
    description: "ORDER BY を使っていなければマルチ +5",
    cost: 5,
    effect: { type: "multIfNoOrderBy", value: 5 },
  },
  {
    id: "dup-mult",
    name: "重複の鏡",
    description: "完全重複行があればマルチ +6",
    cost: 5,
    effect: { type: "multIfDuplicate", value: 6 },
  },
];

/** ID からジョーカーを引く。 */
export function findJoker(id: string): JokerDef | undefined {
  return JOKERS.find((j) => j.id === id);
}
