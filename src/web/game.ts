/**
 * Web UI の状態管理（DOM 非依存）。
 *
 * Issue #8 の要件「リロード・リトライ・ゲーム終了時に破綻しない状態管理」に対応する。
 *
 * 設計方針:
 *   - ゲームの真実は `RunController`（既存の logic）が持つ。ここは薄いラッパーに留める
 *   - UI が知りたい「今なにをすべきか」を `phase` として明示する
 *     （プレイ待ち / ジョーカー選択待ち / ブラインド突破 / ラン終了）
 *   - DOM に触らないので、テストで全フローを検証できる
 */

import type { FragmentCard, JokerDef, PlayOutcome, QueryEngine, RunController } from "../types.ts";
import { RULES } from "../types.ts";
import { createRun } from "../logic/index.ts";
import { buildPreview } from "./preview.ts";
import type { Preview } from "./preview.ts";

/** いまプレイヤーがすべきこと。UI はこれで画面を切り替える。 */
export type Phase =
  /** 手札から断片を選んでプレイする */
  | "selecting"
  /** ブラインドを突破した。次へ進む */
  | "blind-cleared"
  /** ジョーカー報酬を選ぶ */
  | "choosing-joker"
  /** ランが終了した（勝ち or 負け） */
  | "ended";

/** 1手の結果（UI 表示用に整形済み）。 */
export interface PlayFeedback {
  ok: boolean;
  /** 表示する見出し（例: "フルハウス相当 ×6"） */
  headline: string;
  /** 補足（失敗理由など） */
  detail?: string;
  /** スコア内訳の行 */
  lines: string[];
  /** 実行した SQL */
  sql?: string;
  /** 返却行数 */
  rowCount?: number;
  /** 合計スコア */
  total?: number;
}

/** Web ゲームのコントローラ。 */
export interface WebGame {
  /** 現在のラン状態（読み取り専用として扱う） */
  readonly run: RunController;
  /** いまプレイヤーがすべきこと */
  phase(): Phase;
  /** 選択中の断片 */
  selection(): FragmentCard[];
  /** 断片を選択に加える／外す。成功したら true。 */
  toggle(fragmentId: string): boolean;
  /** 選択をすべて解除する */
  clearSelection(): void;
  /** 選択中の断片のプレビュー（確定値） */
  preview(): Preview;
  /** 選択中の断片でプレイする */
  play(): PlayFeedback;
  /** 選択中の断片をディスカードする */
  discard(): PlayFeedback;
  /** ブラインド突破後に次へ進む */
  nextBlind(): void;
  /** ジョーカー報酬を選ぶ */
  chooseJoker(jokerId: string): boolean;
  /** 直前のプレイ結果（UI が表示に使う） */
  lastFeedback(): PlayFeedback | undefined;
  /** 新しいランを始める（リトライ） */
  restart(seed?: number): void;
}

/** スコア内訳を UI 表示用の行にする。 */
function scoreLines(outcome: PlayOutcome): string[] {
  const score = outcome.score;
  if (!score) return [];
  return score.notes;
}

/** プレイ結果を UI 表示用に整形する。 */
function toFeedback(outcome: PlayOutcome): PlayFeedback {
  if (!outcome.ok) {
    return {
      ok: false,
      headline: "プレイできませんでした",
      detail: outcome.error ? explain(outcome.error) : "理由が分かりません。",
      lines: [],
    };
  }
  const score = outcome.score;
  return {
    ok: true,
    headline: score ? `${score.rankLabel} ×${score.rankMult}` : "プレイしました",
    lines: scoreLines(outcome),
    sql: outcome.result?.sql,
    rowCount: outcome.result?.rowCount,
    total: score?.total,
  };
}

/** PlayError を短い日本語にする（preview.ts と同じ規則）。 */
function explain(error: NonNullable<PlayOutcome["error"]>): string {
  switch (error.code) {
    case "invalid-count":
      return error.message;
    case "unknown-fragment":
      return "手札にない断片が選ばれています。";
    case "duplicate-fragment":
      return "同じ断片を2回えらぶことはできません。";
    case "no-plays-left":
      return "プレイ回数が残っていません。";
    case "no-discards-left":
      return "ディスカード回数が残っていません。";
    case "query-failed":
      return error.cause.message;
    default:
      return "プレイできませんでした。";
  }
}

/**
 * Web ゲームを作る。
 *
 * @param engine ブラウザ用クエリエンジン
 * @param seed 乱数の種（省略時は非決定的）
 */
export function createWebGame(engine: QueryEngine, seed?: number): WebGame {
  let run = createRun(seed === undefined ? {} : { seed }, engine);
  let selectedIds: string[] = [];
  let feedback: PlayFeedback | undefined;

  /** 選択中の断片を手札から引く（選択順を保つ）。 */
  const selection = (): FragmentCard[] => {
    const hand = run.state.hand;
    return selectedIds
      .map((id) => hand.find((fragment) => fragment.id === id))
      .filter((fragment): fragment is FragmentCard => fragment !== undefined);
  };

  /** 手札にない断片は選択から落とす（プレイ後に手札が変わったときの破綻を防ぐ）。 */
  const pruneSelection = (): void => {
    const handIds = new Set(run.state.hand.map((fragment) => fragment.id));
    selectedIds = selectedIds.filter((id) => handIds.has(id));
  };

  const phase = (): Phase => {
    if (run.state.status !== "playing") return "ended";
    if (run.state.pendingJokerChoices.length > 0) return "choosing-joker";
    if (run.state.blindScore >= run.state.targetChips) return "blind-cleared";
    return "selecting";
  };

  const toggle = (fragmentId: string): boolean => {
    if (phase() !== "selecting") return false;
    const index = selectedIds.indexOf(fragmentId);
    if (index >= 0) {
      selectedIds.splice(index, 1);
      return true;
    }
    if (selectedIds.length >= RULES.maxPlayFragments) return false;
    if (!run.state.hand.some((fragment) => fragment.id === fragmentId)) return false;
    selectedIds.push(fragmentId);
    return true;
  };

  const clearSelection = (): void => {
    selectedIds = [];
  };

  const preview = (): Preview => buildPreview(engine, run.state, selection());

  const play = (): PlayFeedback => {
    if (phase() !== "selecting") {
      feedback = {
        ok: false,
        headline: "いまはプレイできません",
        detail:
          phase() === "choosing-joker"
            ? "先にジョーカーをえらんでください。"
            : phase() === "blind-cleared"
              ? "次のブラインドへ進んでください。"
              : "このランは終了しています。",
        lines: [],
      };
      return feedback;
    }
    const ids = selection().map((fragment) => fragment.id);
    const outcome = run.play(ids);
    selectedIds = [];
    pruneSelection();
    feedback = toFeedback(outcome);
    return feedback;
  };

  const discard = (): PlayFeedback => {
    if (phase() !== "selecting") {
      feedback = {
        ok: false,
        headline: "いまはディスカードできません",
        detail: "プレイ待ちのときだけディスカードできます。",
        lines: [],
      };
      return feedback;
    }
    const ids = selection().map((fragment) => fragment.id);
    const outcome = run.discard(ids);
    if (outcome.error) {
      feedback = {
        ok: false,
        headline: "ディスカードできませんでした",
        detail: explain(outcome.error),
        lines: [],
      };
      return feedback;
    }
    selectedIds = [];
    pruneSelection();
    feedback = {
      ok: true,
      headline: `${outcome.discarded}枚を捨てました`,
      lines: [`残りディスカード: ${run.state.discardsLeft}`],
    };
    return feedback;
  };

  const nextBlind = (): void => {
    if (phase() !== "blind-cleared") return;
    run.nextBlind();
    selectedIds = [];
    pruneSelection();
  };

  const chooseJoker = (jokerId: string): boolean => {
    if (phase() !== "choosing-joker") return false;
    const ok = run.chooseJoker(jokerId);
    if (ok) {
      feedback = {
        ok: true,
        headline: "ジョーカーを獲得しました",
        lines: [],
      };
    }
    return ok;
  };

  const restart = (newSeed?: number): void => {
    run = createRun(newSeed === undefined ? {} : { seed: newSeed }, engine);
    selectedIds = [];
    feedback = undefined;
  };

  return {
    get run() {
      return run;
    },
    phase,
    selection,
    toggle,
    clearSelection,
    preview,
    play,
    discard,
    nextBlind,
    chooseJoker,
    lastFeedback: () => feedback,
    restart,
  };
}

/** ジョーカー報酬の候補を返す（UI 表示用）。 */
export function jokerChoices(run: RunController): JokerDef[] {
  return run.state.pendingJokerChoices;
}
