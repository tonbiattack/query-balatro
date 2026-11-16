/**
 * Boss ブラインドの妨害ルール定義。
 *
 * 仕様書の方針どおり「データ側ではなくルール側を縛る」。
 * 断片の組み方そのものを変えさせる妨害だけを置く。
 */

import type { BossRuleDef, BossRuleId } from "../types.ts";

/** Boss ルールの全定義。 */
export const BOSS_RULES: BossRuleDef[] = [
  {
    id: "none",
    name: "妨害なし",
    description: "通常のブラインド。",
  },
  {
    id: "noOrderBy",
    name: "ORDER BY 禁止",
    description: "ORDER BY を含むクエリは実行できない。",
  },
  {
    id: "noLike",
    name: "LIKE 禁止",
    description: "LIKE を含むクエリは実行できない。",
  },
  {
    id: "noJoin",
    name: "JOIN 禁止",
    description: "JOIN を含むクエリは実行できない。",
  },
  {
    id: "zeroOnDuplicate",
    name: "重複でスコア0",
    description: "完全重複行を含むクエリはスコア0になる。",
  },
  {
    id: "maxRows50",
    name: "取得上限50行",
    description: "取得上限が50行に下がる。",
  },
];

/** ID から Boss ルールを引く。 */
export function findBossRule(id: BossRuleId): BossRuleDef | undefined {
  return BOSS_RULES.find((b) => b.id === id);
}
