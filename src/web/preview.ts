/**
 * プレビュー計算（純粋ロジック）。
 *
 * Issue #7 の核:「選択中のカードで成立するSQLパターンと、予想チップ×マルチを即時プレビュー」
 * 「不成立の組み合わせは原因を短く説明し、手戻りを少なくする」。
 *
 * DOM に触らない純粋関数にして、テストできるようにする。
 * 実際にクエリを実行してスコアを計算するため、**予測ではなく確定値**を返せる
 * （クエリは読み取り専用で 0.1〜0.2ms なので、選択のたびに実行して問題ない）。
 */

import type {
  FragmentCard,
  JokerDef,
  PlayError,
  QueryEngine,
  QueryError,
  RunState,
  ScoreBreakdown,
} from "../types.ts";
import { RULES } from "../types.ts";
import { BASE_TABLE } from "../data/index.ts";
import { scoreQuery } from "../logic/score.ts";

/** プレビューの結果。 */
export interface Preview {
  /** その組み合わせでプレイできるか */
  ok: boolean;
  /** 組み立てられる SQL（実行前でも表示できる） */
  sql: string;
  /** 返却行数（実行できたときのみ） */
  rowCount: number;
  /** スコア内訳（実行できたときのみ） */
  score?: ScoreBreakdown;
  /** 成立する役の表示名 */
  rankLabel: string;
  /** 予想合計スコア */
  total: number;
  /** プレイできない理由（短い日本語） */
  reason?: string;
  /** 失敗の種類。UI が出し分けに使う。 */
  failureKind?: "input" | "query";
}

/** 選択が不正なときのプレビューを作る。 */
function invalid(reason: string, sql = ""): Preview {
  return {
    ok: false,
    sql,
    rowCount: 0,
    rankLabel: "—",
    total: 0,
    reason,
    failureKind: "input",
  };
}

/**
 * 選択中の断片からプレビューを作る。
 *
 * @param engine クエリ実行基盤
 * @param state 現在のラン状態（Boss ルールとジョーカーを参照する）
 * @param selected 選択中の断片（選択順）
 */
export function buildPreview(
  engine: QueryEngine,
  state: RunState,
  selected: FragmentCard[],
): Preview {
  // --- 入力の検証（プレイと同じ規則） ---
  if (selected.length === 0) {
    return invalid("断片を1枚以上えらんでください。");
  }
  if (selected.length > RULES.maxPlayFragments) {
    return invalid(`断片は最大${RULES.maxPlayFragments}枚までです（${selected.length}枚）。`);
  }
  if (state.status !== "playing") {
    return invalid("このランは終了しています。");
  }
  if (state.blindScore >= state.targetChips) {
    return invalid("このブラインドは突破済みです。次のブラインドへ進んでください。");
  }
  if (state.playsLeft <= 0) {
    return invalid("プレイ回数が残っていません。");
  }

  // --- クエリを実行して確定値を出す ---
  const plan = { baseTable: BASE_TABLE, fragments: selected };
  const result = engine.run(plan, {
    bossRule: state.bossRule,
    maxRows: state.bossRule === "maxRows50" ? 50 : RULES.maxRows,
  });

  if (result.error) {
    return {
      ok: false,
      sql: result.sql,
      rowCount: 0,
      rankLabel: "—",
      total: 0,
      reason: explainQueryError(result.error),
      failureKind: "query",
    };
  }

  const score = scoreQuery({
    result,
    fragments: selected,
    jokers: state.jokers,
    bossRule: state.bossRule,
  });

  // 0行は「役なし」だが、プレイ自体は可能（スコア0になる）
  return {
    ok: true,
    sql: result.sql,
    rowCount: result.rowCount,
    score,
    rankLabel: score.rankLabel,
    total: score.total,
  };
}

/**
 * クエリ失敗の理由をプレイヤー向けの短い日本語にする。
 *
 * 「何が悪いか」だけでなく「どうすればいいか」まで書く（桜井原則:
 * ダメ出しは改善案とセット）。
 */
export function explainQueryError(error: QueryError): string {
  switch (error.code) {
    case "blocked-by-boss":
      return `${error.message} 別の断片に置きかえてください。`;
    case "timeout":
      return "クエリが重すぎます。断片を減らすか、JOIN を外してください。";
    case "not-select":
      return "SELECT 以外は実行できません。";
    case "sql-error":
      return error.message;
    default:
      return "クエリを実行できませんでした。";
  }
}

/**
 * プレイ失敗（入力ミス・クエリ失敗）を短い日本語にする。
 * CLI の `formatPlayError` と同じ方針で、必ず「どう直すか」を含める。
 */
export function explainPlayError(error: PlayError): string {
  switch (error.code) {
    case "invalid-count":
      return error.message;
    case "unknown-fragment":
      return "手札にない断片が選ばれています。えらび直してください。";
    case "duplicate-fragment":
      return "同じ断片を2回えらぶことはできません。";
    case "no-plays-left":
      return "プレイ回数が残っていません。";
    case "no-discards-left":
      return "ディスカード回数が残っていません。";
    case "query-failed":
      return explainQueryError(error.cause);
    default:
      return "プレイできませんでした。";
  }
}

/**
 * 選択中の断片が「あと何枚まで足せるか」を返す。
 * UI が「あと2枚」のように表示するために使う。
 */
export function remainingSlots(selectedCount: number): number {
  return Math.max(0, RULES.maxPlayFragments - selectedCount);
}

/**
 * 選択の並びを「1 → 3 → 5」のような表示用文字列にする。
 * 選択順が役に影響しないことは仕様だが、プレイヤーが選んだ順を
 * 見せておくと「何を選んだか」の確認がしやすい。
 */
export function formatSelectionOrder(selected: FragmentCard[]): string {
  if (selected.length === 0) return "なし";
  return selected.map((fragment, index) => `${index + 1}. ${fragment.name}`).join(" → ");
}

/**
 * 選択中の断片が使っている句を、重複なしで返す。
 * UI が「使っている句: WHERE / JOIN」のように表示するために使う。
 */
export function usedClauseLabels(selected: FragmentCard[]): string[] {
  const labels: string[] = [];
  for (const fragment of selected) {
    for (const kind of fragment.kinds) {
      if (!labels.includes(kind)) labels.push(kind);
    }
  }
  return labels;
}

/**
 * ジョーカーのうち、今回の選択で実際に効果が出ているものを返す。
 * 「どのジョーカーが効いたか」をプレビューで示すために使う。
 */
export function activeJokers(score: ScoreBreakdown | undefined, jokers: JokerDef[]): JokerDef[] {
  if (!score) return [];
  // notes にジョーカー名が含まれているものだけを「効いた」とみなす
  return jokers.filter((joker) => score.notes.some((note) => note.includes(joker.name)));
}
