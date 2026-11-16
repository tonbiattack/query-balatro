/**
 * 役判定とスコア計算。
 *
 * 仕様書（docs/SPEC.md「スコア式」「役」）の確定式をそのまま実装する:
 *   チップ = 断片のチップ合計 + 返却行数 × 1 + ジョーカー由来チップ
 *   マルチ = 役の倍率 + ジョーカー由来マルチ加算
 *   スコア = Math.round(チップ × マルチ)
 *
 * 端数は最終スコアのみ四捨五入する（途中では丸めない）。
 * この関数は副作用を持たず、同じ入力なら常に同じ出力を返す。
 */

import type {
  FragmentCard,
  FragmentKind,
  JokerDef,
  QueryResult,
  RankCondition,
  RankDef,
  Row,
  ScoreBreakdown,
  ScoreContext,
} from "../types.ts";
import { NO_RANK_MULT, RANKS } from "../data/index.ts";

/** 役が成立しなかったときの役ID。 */
const RANK_NONE_ID = "none";
/** 役が成立しなかったときの表示名。 */
const RANK_NONE_LABEL = "役なし";

// ---------------------------------------------------------------------------
// 役判定
// ---------------------------------------------------------------------------

/**
 * 役の成立条件を満たすか判定する。
 * allKinds / anyKinds / noneKinds は `result.usedKinds` に対して、
 * minRows は `result.rowCount` に対して判定する。
 */
function matchesCondition(
  condition: RankCondition,
  usedKinds: FragmentKind[],
  rowCount: number,
): boolean {
  // 指定された kind をすべて含むこと
  if (condition.allKinds) {
    for (const kind of condition.allKinds) {
      if (!usedKinds.includes(kind)) return false;
    }
  }
  // 指定された kind のうち1つ以上を含むこと
  if (condition.anyKinds && condition.anyKinds.length > 0) {
    if (!condition.anyKinds.some((kind) => usedKinds.includes(kind))) return false;
  }
  // 指定された kind を1つも含まないこと
  if (condition.noneKinds) {
    for (const kind of condition.noneKinds) {
      if (usedKinds.includes(kind)) return false;
    }
  }
  // 返却行数の下限
  if (condition.minRows !== undefined && rowCount < condition.minRows) return false;
  return true;
}

/**
 * RANKS を優先度順に走査し、最初に成立した役を返す。
 * どれも成立しなければ undefined。
 */
function findRankFor(usedKinds: FragmentKind[], rowCount: number): RankDef | undefined {
  return RANKS.find((rank) => matchesCondition(rank.requires, usedKinds, rowCount));
}

// ---------------------------------------------------------------------------
// 行の集計（ジョーカー効果用）
// ---------------------------------------------------------------------------

/** 行の内容を比較可能な文字列にする（列名の順序に依存しない）。 */
function rowKey(row: Row): string {
  const keys = Object.keys(row).sort();
  return JSON.stringify(keys.map((key) => [key, row[key]]));
}

/** NULL を1つでも含む行の数。 */
function countNullRows(rows: Row[]): number {
  let total = 0;
  for (const row of rows) {
    if (Object.values(row).some((value) => value === null)) total += 1;
  }
  return total;
}

/**
 * 完全重複している行の数。
 * 「同じ内容の行が他にも存在する行」を1行ずつ数える（3行重複なら3）。
 */
function countDuplicateRows(rows: Row[]): number {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = rowKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let total = 0;
  for (const count of counts.values()) {
    if (count >= 2) total += count;
  }
  return total;
}

/** 指定 kind を含む断片の枚数。 */
function countFragmentsWithKind(fragments: FragmentCard[], kind: FragmentKind): number {
  return fragments.filter((fragment) => fragment.kinds.includes(kind)).length;
}

// ---------------------------------------------------------------------------
// ジョーカー効果
// ---------------------------------------------------------------------------

/**
 * ジョーカー1個分の寄与を求める。
 * JokerEffect の全6種をここで評価する（データ側は効果を宣言するだけ）。
 */
function applyJoker(
  joker: JokerDef,
  result: QueryResult,
  fragments: FragmentCard[],
): { chips: number; mult: number } {
  const effect = joker.effect;
  switch (effect.type) {
    case "multIfNull":
      // 定額。行数に比例させると 58行 × 4 = +232 マルチになり崩壊する
      return { chips: 0, mult: result.hasNull ? effect.value : 0 };
    case "chipsPerLike":
      return { chips: effect.value * countFragmentsWithKind(fragments, "LIKE"), mult: 0 };
    case "multPerKind":
      return { chips: 0, mult: effect.value * countFragmentsWithKind(fragments, effect.kind) };
    case "chipsPerRow":
      return { chips: effect.value * result.rowCount, mult: 0 };
    case "multIfNoOrderBy":
      return { chips: 0, mult: result.usedKinds.includes("ORDER_BY") ? 0 : effect.value };
    case "multIfDuplicate":
      // 定額。行数に比例させると WINDOW 断片1枚で57行が重複し +114 マルチになる
      return { chips: 0, mult: result.hasDuplicateRows ? effect.value : 0 };
    default: {
      // 効果の追加漏れを型で検出する
      const exhaustive: never = effect;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// スコア計算
// ---------------------------------------------------------------------------

/** スコア内訳を組み立てる。 */
export function scoreQuery(ctx: ScoreContext): ScoreBreakdown {
  const { result, fragments, jokers, bossRule } = ctx;
  const notes: string[] = [];
  const fragmentChips = fragments.reduce((sum, fragment) => sum + fragment.chips, 0);

  // 実行できなかったクエリはスコアを持たない（run.ts は失敗手も履歴に残すため）。
  if (result.error) {
    notes.push(`クエリを実行できませんでした（${result.error.code}）`);
    return {
      chips: 0,
      mult: 0,
      total: 0,
      rankId: RANK_NONE_ID,
      rankLabel: RANK_NONE_LABEL,
      rankMult: NO_RANK_MULT,
      fragmentChips,
      rowChips: 0,
      jokerChips: 0,
      jokerMult: 0,
      notes,
    };
  }

  const rowCount = result.rowCount;

  // 0行は役なし・マルチ0・スコア0（仕様書「スコア式」）。
  // ジョーカーの加算も行わない（マルチ0のままスコア0に固定する）。
  if (rowCount <= 0) {
    notes.push(`返却0行のため役なし（×${NO_RANK_MULT}）`);
    notes.push(`断片チップ: ${fragmentChips}（${fragments.length}枚）`);
    notes.push("スコア: 0（返却0行）");
    return {
      chips: fragmentChips,
      mult: 0,
      total: 0,
      rankId: RANK_NONE_ID,
      rankLabel: RANK_NONE_LABEL,
      rankMult: NO_RANK_MULT,
      fragmentChips,
      rowChips: 0,
      jokerChips: 0,
      jokerMult: 0,
      notes,
    };
  }

  // --- 役判定 ---
  const rank = findRankFor(result.usedKinds, rowCount);
  const rankId = rank ? rank.id : RANK_NONE_ID;
  const rankLabel = rank ? rank.label : RANK_NONE_LABEL;
  const rankMult = rank ? rank.mult : NO_RANK_MULT;
  notes.push(`役判定: ${rankLabel}（×${rankMult}）`);

  // --- チップ ---
  const rowChips = rowCount * 1;
  notes.push(`断片チップ: ${fragmentChips}（${fragments.length}枚）`);
  notes.push(`行チップ: ${rowChips}（${rowCount}行 × 1）`);

  // --- ジョーカー ---
  let jokerChips = 0;
  let jokerMult = 0;
  for (const joker of jokers) {
    const applied = applyJoker(joker, result, fragments);
    if (applied.chips !== 0) {
      jokerChips += applied.chips;
      notes.push(`ジョーカー「${joker.name}」: チップ +${applied.chips}`);
    }
    if (applied.mult !== 0) {
      jokerMult += applied.mult;
      notes.push(`ジョーカー「${joker.name}」: マルチ +${applied.mult}`);
    }
  }

  const chips = fragmentChips + rowChips + jokerChips;
  const mult = rankMult + jokerMult;
  notes.push(`チップ合計: ${chips}`);
  notes.push(`マルチ合計: ${mult}（役 ${rankMult} + ジョーカー ${jokerMult}）`);

  // --- 最終スコア（端数はここだけで四捨五入） ---
  let total = Math.round(chips * mult);
  notes.push(`スコア: ${chips} × ${mult} = ${total}`);

  // --- Boss 妨害: 完全重複行を含むクエリはスコア0 ---
  if (bossRule === "zeroOnDuplicate" && result.hasDuplicateRows) {
    total = 0;
    notes.push("Boss「重複でスコア0」: 完全重複行を含むためスコア0");
  }

  return {
    chips,
    mult,
    total,
    rankId,
    rankLabel,
    rankMult,
    fragmentChips,
    rowChips,
    jokerChips,
    jokerMult,
    notes,
  };
}
