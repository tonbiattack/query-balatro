/**
 * ランの進行（RunController の実装）。
 *
 * 仕様書（docs/SPEC.md「数値仕様」「勝敗条件」）に従い、
 * ブラインド単位のプレイ／ディスカードとアンティ進行を司る。
 *
 * 依存方向は types ← data ← db ← logic。logic は `QueryEngine` インターフェースにのみ依存し、
 * 既定エンジンは engine-provider.ts が実行時に遅延解決する。
 */

import type {
  BlindKind,
  BossRuleId,
  CreateRunOptions,
  DiscardOutcome,
  FragmentCard,
  JokerDef,
  PlayError,
  PlayOutcome,
  PlayRecord,
  QueryEngine,
  QueryError,
  QueryPlan,
  QueryResult,
  RunController,
  RunState,
  ScoreBreakdown,
} from "../types.ts";
import { RULES } from "../types.ts";
import {
  BASE_TABLE,
  FRAGMENTS,
  JOKERS,
  findAnte,
  findJoker,
  targetChips,
} from "../data/index.ts";
import { scoreQuery } from "./score.ts";
import { mulberry32, shuffleInPlace } from "./rng.ts";
import { resolveDefaultEngine } from "./engine-provider.ts";

// ---------------------------------------------------------------------------
// 内部ヘルパ
// ---------------------------------------------------------------------------

/** ブラインドの進行順。 */
const BLIND_ORDER: BlindKind[] = ["small", "big", "boss"];

/**
 * 開始時に持たせるジョーカーのID。
 *
 * 「行の蒐集家」を選んだ理由:
 * - 効果が「返却行1行につきチップ+5」で、**行を増やすほど強い**ことが一目で分かる
 * - マルチではなくチップなので、役の倍率と掛け算になり伸びを体感しやすい
 * - 序盤の目標値（2,500）に対して過剰でなく、曲線を歪めない
 */
const STARTING_JOKER_ID = "row-chips";

/** 次に進むブラインド種別を返す。boss の次は undefined（＝次のアンティへ）。 */
function nextBlindKind(blind: BlindKind): BlindKind | undefined {
  const index = BLIND_ORDER.indexOf(blind);
  return BLIND_ORDER[index + 1];
}

/** ブラインド種別の表示名。 */
function blindLabel(blind: BlindKind): string {
  if (blind === "small") return "Small";
  if (blind === "big") return "Big";
  return "Boss";
}

/**
 * そのアンティ・ブラインドに適用される Boss 妨害ルール。
 * 妨害は Boss ブラインドでのみ有効（Small / Big は常に "none"）。
 */
function bossRuleFor(ante: number, blind: BlindKind): BossRuleId {
  if (blind !== "boss") return "none";
  const config = findAnte(ante);
  return config ? config.bossRule : "none";
}

/**
 * 入力検証の失敗を PlayError として表す。
 *
 * 「クエリは実行したが失敗した」（QueryError）と「プレイの前提が満たされていない」
 * （入力ミス）はプレイヤーにとって意味が違うため、型で区別する。
 */
function invalidPlay(
  code: "invalid-count" | "unknown-fragment" | "duplicate-fragment" | "no-plays-left" | "no-discards-left",
  message: string,
): PlayError {
  return { code, message };
}

/** 断片IDの並びを検証する。問題があれば理由を返す。 */
function validateFragmentIds(
  fragmentIds: string[],
  hand: FragmentCard[],
  actionLabel: string,
): PlayError | undefined {
  if (fragmentIds.length === 0) {
    return invalidPlay("invalid-count", `${actionLabel}する断片を1枚以上選んでください。`);
  }
  if (fragmentIds.length > RULES.maxPlayFragments) {
    return invalidPlay(
      "invalid-count",
      `断片は最大${RULES.maxPlayFragments}枚までです（${fragmentIds.length}枚選ばれています）。`,
    );
  }
  const seen = new Set<string>();
  for (const id of fragmentIds) {
    if (seen.has(id)) {
      return invalidPlay("duplicate-fragment", `同じ断片（${id}）を2回選ぶことはできません。`);
    }
    seen.add(id);
    if (!hand.some((fragment) => fragment.id === id)) {
      return invalidPlay("unknown-fragment", `手札にない断片です（${id}）。`);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// createRun
// ---------------------------------------------------------------------------

/**
 * ランを生成する。
 *
 * @param options 乱数の種・初期ジョーカー
 * @param engine クエリ実行基盤。省略時は `src/db/engine.ts` の
 *   `createEngineFromSchema()` を実行時に遅延解決する（テストではフェイクを注入する）
 */
export function createRun(
  options: CreateRunOptions = {},
  engine?: QueryEngine,
): RunController {
  // エンジンは最初の play() まで解決しない（生成だけなら db 未実装でも成功する）
  let resolvedEngine: QueryEngine | undefined = engine;
  const getEngine = (): QueryEngine => {
    if (!resolvedEngine) resolvedEngine = resolveDefaultEngine();
    return resolvedEngine;
  };

  // --- 乱数（seed 指定時は決定的） ---
  const random = options.seed === undefined ? Math.random : mulberry32(options.seed);

  // --- 山札の準備 ---
  // FRAGMENTS は共有定数なので、複製してからシャッフルする（元データを壊さない）
  const deck: FragmentCard[] = shuffleInPlace([...FRAGMENTS], random);
  const hand: FragmentCard[] = [];
  const discardPile: FragmentCard[] = [];

  /** 山札から1枚引く。山札が尽きたら捨て札を切り直して戻す。 */
  const drawOne = (): FragmentCard | undefined => {
    if (deck.length === 0) {
      if (discardPile.length === 0) return undefined;
      // 捨て札を切り直して山札へ戻す（カードが尽きてもランを止めない）
      const recycled = discardPile.splice(0, discardPile.length);
      deck.push(...shuffleInPlace(recycled, random));
    }
    return deck.pop();
  };

  /** 手札が規定枚数になるまで引く。 */
  const drawToHandSize = (): void => {
    while (hand.length < RULES.handSize) {
      const card = drawOne();
      if (!card) break;
      hand.push(card);
    }
  };

  // --- 初期ジョーカー ---
  // 開始時に1つ持たせる。理由は data/antes.ts のコメントを参照:
  // 0個→1個でスコアが約2.5倍になり、最初の獲得時に目標値が跳ねて壁になるため。
  // また「ジョーカーでスコアが伸びる」という本作の核を最初の1手から体験できる。
  const jokers: JokerDef[] = [];
  const startingJoker = findJoker(STARTING_JOKER_ID);
  if (startingJoker) jokers.push(startingJoker);
  for (const jokerId of options.initialJokers ?? []) {
    if (jokers.length >= RULES.jokerSlots) break;
    const joker = findJoker(jokerId);
    // 未知のIDは無視する（CLI から呼ばれてもクラッシュさせない）
    // 開始ジョーカーと同じIDは重複させない
    if (joker && !jokers.some((owned) => owned.id === joker.id)) jokers.push(joker);
  }

  // --- 初期状態（アンティ1 / Small） ---
  const state: RunState = {
    ante: 1,
    blind: "small",
    targetChips: targetChips(1, "small"),
    blindScore: 0,
    playsLeft: RULES.playsPerBlind,
    discardsLeft: RULES.discardsPerBlind,
    hand,
    deck,
    discardPile,
    jokers,
    bossRule: bossRuleFor(1, "small"),
    status: "playing",
    history: [],
    pendingJokerChoices: [],
  };

  drawToHandSize();

  // -------------------------------------------------------------------------
  // ジョーカー報酬
  // -------------------------------------------------------------------------

  /**
   * ブラインド突破の報酬として、ジョーカー候補を3つ用意する。
   *
   * ジョーカーはスコアの伸びを担う中核で、これが無いとアンティ8の目標に
   * 数学的に到達できない（実測: ジョーカー無しの理論最大は 2,170 に対し
   * アンティ8 Boss の目標は 33,000）。そのため突破ごとに必ず1つ獲得できる。
   *
   * 枠が埋まっている場合と、候補が尽きた場合は何もしない。
   */
  const offerJokerChoices = (): void => {
    if (state.jokers.length >= RULES.jokerSlots) return;
    // すでに持っているジョーカーは候補から除く（同じ効果の重複を避ける）
    const owned = new Set(state.jokers.map((joker) => joker.id));
    const available = JOKERS.filter((joker) => !owned.has(joker.id));
    if (available.length === 0) return;
    const shuffled = shuffleInPlace([...available], random);
    state.pendingJokerChoices = shuffled.slice(0, Math.min(3, shuffled.length));
  };

  /** 報酬のジョーカーを1つ選んで獲得する。 */
  const chooseJoker = (jokerId: string): boolean => {
    if (state.pendingJokerChoices.length === 0) return false;
    if (state.jokers.length >= RULES.jokerSlots) return false;
    const chosen = state.pendingJokerChoices.find((joker) => joker.id === jokerId);
    if (!chosen) return false;
    state.jokers.push(chosen);
    state.pendingJokerChoices = [];
    return true;
  };

  // -------------------------------------------------------------------------
  // play
  // -------------------------------------------------------------------------

  /**
   * 選んだ断片を手札から取り除き、捨て札へ送って手札を補充する。
   * プレイ失敗時も断片は消費済みとして扱う（プレイ回数だけが減る状態を作らない）。
   */
  const consumeFromHand = (fragmentIds: string[]): FragmentCard[] => {
    const played: FragmentCard[] = [];
    for (const id of fragmentIds) {
      const index = hand.findIndex((fragment) => fragment.id === id);
      if (index >= 0) {
        const [card] = hand.splice(index, 1);
        played.push(card);
      }
    }
    discardPile.push(...played);
    drawToHandSize();
    return played;
  };

  const play = (fragmentIds: string[]): PlayOutcome => {
    // --- 状態の検証 ---
    if (state.status !== "playing") {
      return {
        ok: false,
        error: invalidPlay(
          "no-plays-left",
          state.status === "won" ? "ランはすでに勝利で終了しています。" : "ランはすでに敗北で終了しています。",
        ),
        blindCleared: false,
        runEnded: true,
      };
    }
    if (state.blindScore >= state.targetChips) {
      return {
        ok: false,
        error: invalidPlay(
          "no-plays-left",
          "このブラインドは突破済みです。nextBlind() で次のブラインドへ進んでください。",
        ),
        blindCleared: false,
        runEnded: false,
      };
    }
    if (state.playsLeft <= 0) {
      return {
        ok: false,
        error: invalidPlay("no-plays-left", "プレイ回数が残っていません。"),
        blindCleared: false,
        runEnded: false,
      };
    }
    const validationError = validateFragmentIds(fragmentIds, hand, "プレイ");
    if (validationError) {
      return {
        ok: false,
        error: validationError,
        blindCleared: false,
        runEnded: false,
      };
    }

    // --- 断片を確定（手札から消費し、補充する） ---
    const fragments = consumeFromHand(fragmentIds);
    const plan: QueryPlan = { baseTable: BASE_TABLE, fragments };

    // --- クエリ実行（Boss 妨害付き） ---
    let result: QueryResult;
    try {
      result = getEngine().run(plan, {
        bossRule: state.bossRule,
        // maxRows50 の Boss は取得上限50行。エンジン側の既定と二重に掛けても同じ結果になる。
        maxRows: state.bossRule === "maxRows50" ? 50 : RULES.maxRows,
      });
    } catch (cause) {
      // 契約上エンジンは例外を投げないが、フェイクや実装不備に備えて受け止める
      const message = cause instanceof Error ? cause.message : String(cause);
      result = {
        sql: "",
        rows: [],
        rowCount: 0,
        hasNull: false,
        hasDuplicateRows: false,
        usedKinds: [],
        elapsedMs: 0,
        error: { code: "sql-error", message } satisfies QueryError,
      };
    }

    // プレイ回数は成功・失敗にかかわらず消費する
    state.playsLeft -= 1;

    const score = scoreQuery({
      result,
      fragments,
      jokers: state.jokers,
      bossRule: state.bossRule,
    });

    const record: PlayRecord = {
      ante: state.ante,
      blind: state.blind,
      fragmentIds: [...fragmentIds],
      sql: result.sql,
      score,
    };

    // --- 失敗（Boss 妨害・SQL エラー・タイムアウト） ---
    if (result.error) {
      record.error = result.error;
      state.history.push(record);
      // 失敗手でもプレイ回数を使い切ったら敗北
      const runEnded = state.playsLeft <= 0;
      if (runEnded) state.status = "lost";
      return {
        ok: false,
        error: {
          code: "query-failed",
          message: result.error.message,
          cause: result.error,
        },
        blindCleared: false,
        runEnded,
      };
    }

    // --- 成功 ---
    state.blindScore += score.total;
    state.history.push(record);

    const blindCleared = state.blindScore >= state.targetChips;
    let runEnded = false;

    if (blindCleared) {
      // アンティ8の Boss を突破したら勝利
      if (state.ante >= RULES.maxAnte && state.blind === "boss") {
        state.status = "won";
        runEnded = true;
      }
    } else if (state.playsLeft <= 0) {
      // 目標未達のままプレイ回数を使い切ったら敗北
      state.status = "lost";
      runEnded = true;
    }

    return {
      ok: true,
      result,
      score,
      blindCleared,
      runEnded,
    };
  };

  // -------------------------------------------------------------------------
  // discard
  // -------------------------------------------------------------------------

  const discard = (fragmentIds: string[]): DiscardOutcome => {
    if (state.status !== "playing") {
      return {
        discarded: 0,
        error: invalidPlay("no-discards-left", "ランはすでに終了しています。"),
      };
    }
    if (state.discardsLeft <= 0) {
      return {
        discarded: 0,
        error: invalidPlay("no-discards-left", "ディスカード回数が残っていません。"),
      };
    }
    const validationError = validateFragmentIds(fragmentIds, hand, "ディスカード");
    if (validationError) {
      return { discarded: 0, error: validationError };
    }

    const discarded = consumeFromHand(fragmentIds);
    state.discardsLeft -= 1;
    return { discarded: discarded.length };
  };

  // -------------------------------------------------------------------------
  // nextBlind
  // -------------------------------------------------------------------------

  const nextBlind = (): void => {
    // ランが終了している、またはブラインド未突破なら何もしない
    if (state.status !== "playing") return;
    if (state.blindScore < state.targetChips) return;

    const following = nextBlindKind(state.blind);
    if (following) {
      state.blind = following;
    } else {
      // Boss 突破 → 次のアンティの Small へ
      state.ante += 1;
      state.blind = "small";
    }

    // アンティ8の Boss を突破済みなら勝利（play() で設定済みだが、念のため確定させる）
    if (state.ante > RULES.maxAnte) {
      state.ante = RULES.maxAnte;
      state.status = "won";
      return;
    }

    state.targetChips = targetChips(state.ante, state.blind);
    state.blindScore = 0;
    state.playsLeft = RULES.playsPerBlind;
    state.discardsLeft = RULES.discardsPerBlind;
    state.bossRule = bossRuleFor(state.ante, state.blind);
    drawToHandSize();

    // 突破の報酬としてジョーカー候補を用意する
    offerJokerChoices();
  };

  // -------------------------------------------------------------------------
  // addJoker
  // -------------------------------------------------------------------------

  const addJoker = (jokerId: string): boolean => {
    if (state.jokers.length >= RULES.jokerSlots) return false;
    const joker = findJoker(jokerId);
    if (!joker) return false;
    state.jokers.push(joker);
    return true;
  };

  return { state, play, discard, nextBlind, chooseJoker, addJoker };
}

// ---------------------------------------------------------------------------
// 補助（CLI の表示用。契約外だが便利なので公開する）
// ---------------------------------------------------------------------------

/** 現在のブラインドの表示用ラベル（例: "アンティ1 / Small"）。 */
export function describeBlind(state: RunState): string {
  return `アンティ${state.ante} / ${blindLabel(state.blind)}`;
}

/** スコア内訳を1行に要約する（ログ・デバッグ用）。 */
export function summarizeScore(score: ScoreBreakdown): string {
  return `${score.rankLabel} ×${score.rankMult} / チップ${score.chips} × マルチ${score.mult} = ${score.total}`;
}

/** ジョーカー定義の一覧（CLI のショップ表示用）。 */
export function availableJokers() {
  return JOKERS;
}
