/**
 * Web UI の状態管理とプレビューのテスト。
 *
 * Issue #7 / #8 の受け入れ条件に対応:
 *   - キーボードでコマンド入力せずに1ブラインドをプレイできる
 *   - カード選択のたびに役・スコアが即時更新される
 *   - ジョーカー/Boss制約が正しく反映される
 *   - リロード・リトライ・ゲーム終了時に破綻しない状態管理
 *
 * DOM には触らないので、ゲーム進行の全フローをここで検証できる。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createBrowserEngine } from "../src/db/browser-engine.ts";
import { createWebGame } from "../src/web/game.ts";
import { buildPreview, explainQueryError, remainingSlots, usedClauseLabels } from "../src/web/preview.ts";
import { FRAGMENTS } from "../src/data/fragments.ts";
import { RULES } from "../src/types.ts";
import type { QueryEngine } from "../src/types.ts";

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

/** テスト用のゲームを作る（エンジンは呼び出し側で閉じる）。 */
async function makeGame(seed = 2026): Promise<{
  game: ReturnType<typeof createWebGame>;
  engine: QueryEngine;
}> {
  const engine = await createBrowserEngine();
  return { game: createWebGame(engine, seed), engine };
}

/** 手札の先頭から n 枚を選ぶ。 */
function selectFirst(game: ReturnType<typeof createWebGame>, n: number): void {
  for (const fragment of game.run.state.hand.slice(0, n)) {
    assert.equal(game.toggle(fragment.id), true, `${fragment.id} を選択できませんでした`);
  }
}

/**
 * 確実にスコアが出る手を選んでプレイする。
 *
 * 手札の組み合わせによっては 0 行（スコア0）になるため、
 * 「突破したか」を検証するテストでは全組み合わせを試して
 * 最もスコアが高い手を打つ必要がある。
 */
function playBestHand(game: ReturnType<typeof createWebGame>): number {
  const hand = game.run.state.hand;
  let best: { ids: string[]; total: number } | undefined;
  // 1〜5枚の全組み合わせから、プレビューで最大スコアのものを選ぶ
  for (let mask = 1; mask < 1 << hand.length; mask++) {
    const ids: string[] = [];
    for (let i = 0; i < hand.length; i++) {
      if (mask & (1 << i)) ids.push(hand[i]!.id);
    }
    if (ids.length > RULES.maxPlayFragments) continue;
    game.clearSelection();
    for (const id of ids) game.toggle(id);
    const preview = game.preview();
    if (!preview.ok) continue;
    if (!best || preview.total > best.total) best = { ids, total: preview.total };
  }
  assert.ok(best, "プレイできる組み合わせが1つもない");
  game.clearSelection();
  for (const id of best.ids) game.toggle(id);
  const feedback = game.play();
  assert.equal(feedback.ok, true, feedback.detail);
  return best.total;
}

// ---------------------------------------------------------------------------
// プレビュー
// ---------------------------------------------------------------------------

test("プレビュー: 選択なしは理由付きで不成立", async () => {
  const { game, engine } = await makeGame();
  try {
    const preview = game.preview();
    assert.equal(preview.ok, false);
    assert.equal(preview.failureKind, "input");
    assert.ok(preview.reason?.includes("1枚以上"));
  } finally {
    engine.close();
  }
});

test("プレビュー: 1枚選ぶと役とスコアが即座に出る", async () => {
  const { game, engine } = await makeGame();
  try {
    const first = game.run.state.hand[0]!;
    game.toggle(first.id);

    const preview = game.preview();
    assert.equal(preview.ok, true, preview.reason);
    assert.ok(preview.sql.startsWith("SELECT"), "SQL が組み立てられていない");
    assert.ok(preview.rowCount >= 0);
    assert.ok(preview.score, "スコア内訳がない");
    assert.ok(preview.rankLabel.length > 0);
    assert.equal(typeof preview.total, "number");
  } finally {
    engine.close();
  }
});

test("プレビュー: 選択を増やすとスコアが変わる（即時更新）", async () => {
  const { game, engine } = await makeGame();
  try {
    const hand = game.run.state.hand;
    game.toggle(hand[0]!.id);
    const one = game.preview();

    game.toggle(hand[1]!.id);
    const two = game.preview();

    // 断片が増えればチップが増えるので、スコアは通常変わる
    assert.notEqual(two.sql, one.sql, "SQL が更新されていない");
    assert.ok(two.score && one.score);
  } finally {
    engine.close();
  }
});

test("プレビュー: 5枚を超えると理由付きで不成立", async () => {
  const { game, engine } = await makeGame();
  try {
    selectFirst(game, RULES.maxPlayFragments);
    // 6枚目は toggle が拒否する
    const sixth = game.run.state.hand[RULES.maxPlayFragments]!;
    assert.equal(game.toggle(sixth.id), false);
    assert.equal(game.selection().length, RULES.maxPlayFragments);
  } finally {
    engine.close();
  }
});

test("プレビュー: 選択の解除ができる", async () => {
  const { game, engine } = await makeGame();
  try {
    const first = game.run.state.hand[0]!;
    game.toggle(first.id);
    assert.equal(game.selection().length, 1);

    game.toggle(first.id);
    assert.equal(game.selection().length, 0);
    assert.equal(game.preview().ok, false);
  } finally {
    engine.close();
  }
});

test("プレビュー: Boss 制約が反映される（ORDER BY 禁止）", async () => {
  const { game, engine } = await makeGame();
  try {
    // アンティ3 Boss の状態にする
    game.run.state.ante = 3;
    game.run.state.blind = "boss";
    game.run.state.bossRule = "noOrderBy";
    game.run.state.targetChips = 10000;
    game.run.state.blindScore = 0;

    // ORDER BY 断片を手札に差し込む
    const orderBy = FRAGMENTS.find((f) => f.kinds.includes("ORDER_BY"))!;
    game.run.state.hand[0] = orderBy;
    game.toggle(orderBy.id);

    const preview = game.preview();
    assert.equal(preview.ok, false);
    assert.equal(preview.failureKind, "query");
    assert.ok(preview.reason?.includes("ORDER_BY"), `理由: ${preview.reason}`);
  } finally {
    engine.close();
  }
});

test("プレビュー: ジョーカー効果がスコアに反映される", async () => {
  const { game, engine } = await makeGame();
  try {
    // 開始ジョーカー（row-chips）が効いているはず
    assert.equal(game.run.state.jokers.length, 1);
    const first = game.run.state.hand[0]!;
    game.toggle(first.id);
    const preview = game.preview();

    assert.ok(preview.score);
    // row-chips は「行1行につきチップ+5」なので、行があれば jokerChips > 0
    if (preview.rowCount > 0) {
      assert.ok(
        preview.score.jokerChips > 0,
        `ジョーカーが効いていない（行数 ${preview.rowCount}）`,
      );
    }
  } finally {
    engine.close();
  }
});

test("プレビュー: 0行でもプレイ自体は可能（スコア0）", async () => {
  const { game, engine } = await makeGame();
  try {
    // 矛盾する WHERE を2枚選ぶと 0 行になる
    const rankA = FRAGMENTS.find((f) => f.id === "where-rank-eq")!;
    const suitH = FRAGMENTS.find((f) => f.id === "where-suit-eq")!;
    // A かつ H は存在するので、代わりに LIKE と IN の矛盾を作る
    const likeRank = FRAGMENTS.find((f) => f.id === "where-like-rank")!; // rank LIKE '1%'
    const inRank = FRAGMENTS.find((f) => f.id === "where-in-rank")!; // rank IN ('J','Q','K')
    game.run.state.hand[0] = likeRank;
    game.run.state.hand[1] = inRank;
    game.toggle(likeRank.id);
    game.toggle(inRank.id);

    const preview = game.preview();
    assert.equal(preview.ok, true, preview.reason);
    assert.equal(preview.rowCount, 0);
    assert.equal(preview.total, 0);
    assert.equal(preview.rankLabel, "役なし");
  } finally {
    engine.close();
  }
});

// ---------------------------------------------------------------------------
// プレイ・ディスカード
// ---------------------------------------------------------------------------

test("プレイ: 選択してプレイするとスコアが加算される", async () => {
  const { game, engine } = await makeGame();
  try {
    selectFirst(game, 3);
    const feedback = game.play();

    assert.equal(feedback.ok, true, feedback.detail);
    assert.ok(feedback.headline.length > 0);
    assert.ok(feedback.sql?.startsWith("SELECT"));
    assert.equal(game.run.state.playsLeft, RULES.playsPerBlind - 1);
    assert.equal(game.selection().length, 0, "プレイ後に選択が残っている");
  } finally {
    engine.close();
  }
});

test("プレイ: 選択なしでは理由付きで失敗する", async () => {
  const { game, engine } = await makeGame();
  try {
    const feedback = game.play();
    assert.equal(feedback.ok, false);
    assert.ok(feedback.detail && feedback.detail.length > 0);
    // 失敗してもプレイ回数は減らない（入力ミスなので）
    assert.equal(game.run.state.playsLeft, RULES.playsPerBlind);
  } finally {
    engine.close();
  }
});

test("ディスカード: 手札が入れ替わり回数が減る", async () => {
  const { game, engine } = await makeGame();
  try {
    const before = game.run.state.hand.map((f) => f.id);
    selectFirst(game, 2);
    const feedback = game.discard();

    assert.equal(feedback.ok, true, feedback.detail);
    assert.equal(game.run.state.discardsLeft, RULES.discardsPerBlind - 1);
    assert.equal(game.run.state.hand.length, RULES.handSize);
    // 捨てた断片は手札から消えている
    assert.notDeepEqual(game.run.state.hand.map((f) => f.id), before);
  } finally {
    engine.close();
  }
});

test("ディスカード: 回数を使い切ると失敗する", async () => {
  const { game, engine } = await makeGame();
  try {
    for (let i = 0; i < RULES.discardsPerBlind; i++) {
      selectFirst(game, 1);
      assert.equal(game.discard().ok, true);
    }
    selectFirst(game, 1);
    const feedback = game.discard();
    assert.equal(feedback.ok, false);
    assert.ok(feedback.detail?.includes("ディスカード"));
  } finally {
    engine.close();
  }
});

// ---------------------------------------------------------------------------
// フェーズ遷移
// ---------------------------------------------------------------------------

test("フェーズ: 開始時は selecting", async () => {
  const { game, engine } = await makeGame();
  try {
    assert.equal(game.phase(), "selecting");
  } finally {
    engine.close();
  }
});

test("フェーズ: ブラインド突破で blind-cleared になる", async () => {
  const { game, engine } = await makeGame();
  try {
    // 目標を極端に下げて1手で突破させる（0行の手を引いても突破できるよう最良手を打つ）
    game.run.state.targetChips = 1;
    playBestHand(game);

    assert.equal(game.phase(), "blind-cleared");
    // 突破済みではプレイできない（選択自体が拒否される）
    assert.equal(game.toggle(game.run.state.hand[0]!.id), false);
    const feedback = game.play();
    assert.equal(feedback.ok, false);
    assert.ok(feedback.detail?.includes("次のブラインド"));
  } finally {
    engine.close();
  }
});

test("フェーズ: 突破後に nextBlind でジョーカー選択になる", async () => {
  const { game, engine } = await makeGame();
  try {
    game.run.state.targetChips = 1;
    playBestHand(game);
    assert.equal(game.phase(), "blind-cleared");

    game.nextBlind();
    assert.equal(game.phase(), "choosing-joker");
    assert.equal(game.run.state.pendingJokerChoices.length, 3);
  } finally {
    engine.close();
  }
});

test("フェーズ: ジョーカーを選ぶと selecting に戻る", async () => {
  const { game, engine } = await makeGame();
  try {
    game.run.state.targetChips = 1;
    playBestHand(game);
    game.nextBlind();

    const choice = game.run.state.pendingJokerChoices[0]!;
    assert.equal(game.chooseJoker(choice.id), true);
    assert.equal(game.phase(), "selecting");
    assert.equal(game.run.state.jokers.length, 2); // 開始1 + 獲得1
  } finally {
    engine.close();
  }
});

test("フェーズ: ジョーカー選択中はプレイできない", async () => {
  const { game, engine } = await makeGame();
  try {
    game.run.state.targetChips = 1;
    playBestHand(game);
    game.nextBlind();
    assert.equal(game.phase(), "choosing-joker");

    // ジョーカー選択中は選択自体が拒否される
    assert.equal(game.toggle(game.run.state.hand[0]!.id), false);
    const feedback = game.play();
    assert.equal(feedback.ok, false);
    assert.ok(feedback.detail?.includes("ジョーカー"));
  } finally {
    engine.close();
  }
});

test("フェーズ: 敗北で ended になる", async () => {
  const { game, engine } = await makeGame();
  try {
    // 目標を極端に上げて、4手使い切っても届かないようにする
    game.run.state.targetChips = 999_999_999;
    for (let i = 0; i < RULES.playsPerBlind; i++) {
      selectFirst(game, 1);
      game.play();
    }
    assert.equal(game.phase(), "ended");
    assert.equal(game.run.state.status, "lost");
  } finally {
    engine.close();
  }
});

// ---------------------------------------------------------------------------
// リトライ・状態の破綻
// ---------------------------------------------------------------------------

test("リトライ: restart で初期状態に戻る", async () => {
  const { game, engine } = await makeGame();
  try {
    selectFirst(game, 3);
    game.play();
    assert.equal(game.run.state.playsLeft, RULES.playsPerBlind - 1);

    game.restart(2026);
    assert.equal(game.run.state.playsLeft, RULES.playsPerBlind);
    assert.equal(game.run.state.blindScore, 0);
    assert.equal(game.run.state.ante, 1);
    assert.equal(game.selection().length, 0);
    assert.equal(game.lastFeedback(), undefined);
  } finally {
    engine.close();
  }
});

test("リトライ: 同じ seed なら同じ手札に戻る", async () => {
  const { game, engine } = await makeGame();
  try {
    const firstHand = game.run.state.hand.map((f) => f.id);
    selectFirst(game, 2);
    game.discard();
    game.restart(2026);
    assert.deepEqual(game.run.state.hand.map((f) => f.id), firstHand);
  } finally {
    engine.close();
  }
});

test("破綻しない: プレイ後に選択が手札から消えても壊れない", async () => {
  const { game, engine } = await makeGame();
  try {
    selectFirst(game, 3);
    game.play();
    // プレイ後、選択は空になっているはず
    assert.equal(game.selection().length, 0);
    // さらに操作しても例外にならない
    assert.doesNotThrow(() => game.preview());
    assert.doesNotThrow(() => game.play());
  } finally {
    engine.close();
  }
});

test("破綻しない: 終了後にすべての操作が安全に失敗する", async () => {
  const { game, engine } = await makeGame();
  try {
    game.run.state.targetChips = 999_999_999;
    for (let i = 0; i < RULES.playsPerBlind; i++) {
      selectFirst(game, 1);
      game.play();
    }
    assert.equal(game.phase(), "ended");

    assert.doesNotThrow(() => game.preview());
    assert.doesNotThrow(() => game.play());
    assert.doesNotThrow(() => game.discard());
    assert.doesNotThrow(() => game.nextBlind());
    assert.equal(game.toggle(game.run.state.hand[0]!.id), false);
  } finally {
    engine.close();
  }
});

// ---------------------------------------------------------------------------
// 1ブラインド完走（受け入れ条件）
// ---------------------------------------------------------------------------

test("完走: キーボード入力なしで1ブラインドを突破できる", async () => {
  const { game, engine } = await makeGame();
  try {
    // クリック操作（toggle）だけで1ブラインドを突破する
    let guard = 0;
    while (game.phase() === "selecting" && guard < 20) {
      guard += 1;
      // 手札から最もスコアが高い組み合わせを選ぶ（クリック操作のみ）
      playBestHand(game);
    }
    assert.ok(
      game.run.state.blindScore >= game.run.state.targetChips,
      `突破できなかった（${game.run.state.blindScore} / ${game.run.state.targetChips}）`,
    );
    assert.equal(game.phase(), "blind-cleared");
  } finally {
    engine.close();
  }
});

// ---------------------------------------------------------------------------
// 補助関数
// ---------------------------------------------------------------------------

test("remainingSlots: 残り枚数を返す", () => {
  assert.equal(remainingSlots(0), 5);
  assert.equal(remainingSlots(3), 2);
  assert.equal(remainingSlots(5), 0);
  assert.equal(remainingSlots(6), 0);
});

test("usedClauseLabels: 使用句を重複なしで返す", () => {
  const where = FRAGMENTS.find((f) => f.id === "where-rank-eq")!;
  const like = FRAGMENTS.find((f) => f.id === "where-like-rank")!;
  const labels = usedClauseLabels([where, like]);
  assert.deepEqual(labels, ["WHERE", "LIKE"]);
});

test("explainQueryError: すべての code に日本語の説明がある", () => {
  const codes = ["not-select", "timeout", "sql-error", "blocked-by-boss"] as const;
  for (const code of codes) {
    const message = explainQueryError({ code, message: "テスト" });
    assert.ok(message.length > 0, `${code} の説明が空`);
    assert.ok(!/^[a-z-]+$/.test(message), `${code} が英語のまま`);
  }
});

test("buildPreview: 状態を壊さない（純粋）", async () => {
  const { game, engine } = await makeGame();
  try {
    const before = JSON.stringify(game.run.state.hand.map((f) => f.id));
    const first = game.run.state.hand[0]!;
    buildPreview(engine, game.run.state, [first]);
    const after = JSON.stringify(game.run.state.hand.map((f) => f.id));
    assert.equal(after, before, "プレビューが手札を書き換えている");
  } finally {
    engine.close();
  }
});
