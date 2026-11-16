/**
 * logic モジュールのテスト。
 *
 * 方針:
 * - scoreQuery は純粋関数なので、QueryResult を直接組み立てて数値を検証する
 * - createRun はフェイク QueryEngine を注入して、db 実装に依存せずに検証する
 * - 期待値は仕様書（docs/SPEC.md）の式から手計算した値を使う
 */

import test from "node:test";
import assert from "node:assert/strict";

import type {
  FragmentCard,
  FragmentKind,
  QueryEngine,
  QueryError,
  QueryPlan,
  QueryResult,
  Row,
  RunController,
  RunQueryOptions,
} from "../src/types.ts";
import { RULES } from "../src/types.ts";
import { findFragment, findJoker, targetChips } from "../src/data/index.ts";
import { scoreQuery } from "../src/logic/score.ts";
import { createRun, describeBlind, summarizeScore } from "../src/logic/run.ts";
import { mulberry32 } from "../src/logic/rng.ts";

// ---------------------------------------------------------------------------
// テスト用ヘルパ
// ---------------------------------------------------------------------------

/** 断片IDから断片を引く（存在しなければテストを失敗させる）。 */
function frag(id: string): FragmentCard {
  const found = findFragment(id);
  assert.ok(found, `断片が見つかりません: ${id}`);
  return found;
}

/** 断片の kinds を出現順・重複なしで集約する（エンジン実装と同じ規則）。 */
function collectKinds(fragments: FragmentCard[]): FragmentKind[] {
  const out: FragmentKind[] = [];
  for (const fragment of fragments) {
    for (const kind of fragment.kinds) {
      if (!out.includes(kind)) out.push(kind);
    }
  }
  return out;
}

/** QueryResult を組み立てる（scoreQuery のテスト用）。 */
function makeResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    sql: "SELECT * FROM cards",
    rows: [],
    rowCount: 0,
    hasNull: false,
    hasDuplicateRows: false,
    usedKinds: [],
    elapsedMs: 0,
    ...overrides,
  };
}

/** フェイクエンジンの設定。 */
interface FakeConfig {
  /** 返す行数 */
  rowCount?: number;
  /** 返す行 */
  rows?: Row[];
  /** 完全重複行を含むか */
  hasDuplicateRows?: boolean;
  /** 常に返すエラー */
  error?: QueryError;
  /** Boss 妨害を再現する（bossRule が none 以外なら blocked-by-boss を返す） */
  honorBoss?: boolean;
}

/** フェイクエンジンと、呼び出し記録へのアクセサ。 */
interface FakeEngine {
  engine: QueryEngine;
  /** run() が呼ばれた回数 */
  calls: () => number;
  /** 最後に run() へ渡されたオプション */
  lastOptions: () => RunQueryOptions | undefined;
  /** 最後に run() へ渡された計画 */
  lastPlan: () => QueryPlan | undefined;
}

/** テスト用のフェイク QueryEngine を作る。 */
function makeEngine(config: FakeConfig = {}): FakeEngine {
  let calls = 0;
  let lastOptions: RunQueryOptions | undefined;
  let lastPlan: QueryPlan | undefined;

  const engine: QueryEngine = {
    run(plan: QueryPlan, options?: RunQueryOptions): QueryResult {
      calls += 1;
      lastOptions = options;
      lastPlan = plan;
      const usedKinds = collectKinds(plan.fragments);
      const rows = config.rows ?? [];
      const result: QueryResult = {
        sql: `SELECT * FROM ${plan.baseTable}`,
        rows,
        rowCount: config.rowCount ?? 0,
        hasNull: rows.some((row) => Object.values(row).some((value) => value === null)),
        hasDuplicateRows: config.hasDuplicateRows ?? false,
        usedKinds,
        elapsedMs: 0,
      };
      if (config.error) return { ...result, error: config.error };
      if (config.honorBoss && options?.bossRule && options.bossRule !== "none") {
        return {
          ...result,
          error: { code: "blocked-by-boss", message: `Boss妨害: ${options.bossRule}` },
        };
      }
      return result;
    },
    buildSql(plan: QueryPlan): string {
      return `SELECT * FROM ${plan.baseTable}`;
    },
    close(): void {
      // 何もしない
    },
  };

  return {
    engine,
    calls: () => calls,
    lastOptions: () => lastOptions,
    lastPlan: () => lastPlan,
  };
}

/** 手札の先頭 n 枚のIDを返す。 */
function handIds(run: RunController, n: number): string[] {
  return run.state.hand.slice(0, n).map((fragment) => fragment.id);
}

/**
 * 現在のブラインドを突破して次のブラインドへ進める。
 * 突破できなければテストを失敗させる。
 */
function clearBlind(run: RunController): void {
  let guard = 0;
  while (
    run.state.blindScore < run.state.targetChips &&
    run.state.playsLeft > 0 &&
    run.state.status === "playing"
  ) {
    const outcome = run.play(handIds(run, RULES.maxPlayFragments));
    assert.equal(outcome.ok, true, `プレイが失敗しました: ${outcome.error?.message ?? ""}`);
    guard += 1;
    assert.ok(guard <= RULES.playsPerBlind, "プレイ回数の上限を超えてループしています");
  }
  assert.ok(
    run.state.blindScore >= run.state.targetChips,
    `ブラインドを突破できませんでした（${run.state.blindScore} / ${run.state.targetChips}）`,
  );
  run.nextBlind();
}

// ---------------------------------------------------------------------------
// 役判定とスコア式
// ---------------------------------------------------------------------------

test("役判定: WHERE のみ → ペア相当 ×2", () => {
  const fragments = [frag("where-rank-eq")]; // chips 10
  const result = makeResult({ rowCount: 10, usedKinds: ["WHERE"] });
  const score = scoreQuery({ result, fragments, jokers: [], bossRule: "none" });

  assert.equal(score.rankId, "pair");
  assert.equal(score.rankMult, 2);
  // チップ = 10 + 10行×1 = 20、マルチ = 2
  assert.equal(score.fragmentChips, 10);
  assert.equal(score.rowChips, 10);
  assert.equal(score.chips, 20);
  assert.equal(score.mult, 2);
  assert.equal(score.total, 40);
});

test("役判定: JOIN → ストレート相当 ×4", () => {
  const fragments = [frag("join-suits")]; // chips 20
  const result = makeResult({ rowCount: 10, usedKinds: ["JOIN"] });
  const score = scoreQuery({ result, fragments, jokers: [], bossRule: "none" });

  assert.equal(score.rankId, "straight");
  assert.equal(score.rankMult, 4);
  assert.equal(score.chips, 30); // 20 + 10
  assert.equal(score.mult, 4);
  assert.equal(score.total, 120);
});

test("役判定: WINDOW → フルハウス相当 ×6", () => {
  const fragments = [frag("window-row-number")]; // chips 35
  const result = makeResult({ rowCount: 10, usedKinds: ["WINDOW"] });
  const score = scoreQuery({ result, fragments, jokers: [], bossRule: "none" });

  assert.equal(score.rankId, "full-house");
  assert.equal(score.rankMult, 6);
  assert.equal(score.chips, 45); // 35 + 10
  assert.equal(score.mult, 6);
  assert.equal(score.total, 270);
});

test("役判定: JOIN + WINDOW + GROUP BY → ロイヤル相当 ×10", () => {
  const fragments = [frag("join-suits"), frag("window-count"), frag("group-by-suit")];
  const result = makeResult({ rowCount: 4, usedKinds: ["JOIN", "WINDOW", "GROUP_BY"] });
  const score = scoreQuery({ result, fragments, jokers: [], bossRule: "none" });

  assert.equal(score.rankId, "royal");
  assert.equal(score.rankMult, 10);
  // チップ = 20 + 40 + 25 + 4 = 89
  assert.equal(score.chips, 89);
  assert.equal(score.total, 890);
});

test("役判定: BETWEEN → フラッシュ相当 ×3", () => {
  const fragments = [frag("where-between-chip")]; // chips 30
  const result = makeResult({ rowCount: 5, usedKinds: ["WHERE", "BETWEEN"] });
  const score = scoreQuery({ result, fragments, jokers: [], bossRule: "none" });

  assert.equal(score.rankId, "flush");
  assert.equal(score.rankMult, 3);
  assert.equal(score.chips, 35);
  assert.equal(score.total, 105);
});

test("役判定: LIKE → ツーペア相当 ×2.5", () => {
  const fragments = [frag("where-like-rank")]; // chips 25
  const result = makeResult({ rowCount: 4, usedKinds: ["WHERE", "LIKE"] });
  const score = scoreQuery({ result, fragments, jokers: [], bossRule: "none" });

  assert.equal(score.rankId, "two-pair");
  assert.equal(score.rankMult, 2.5);
  assert.equal(score.chips, 29);
  assert.equal(score.total, 73); // Math.round(29 * 2.5) = 72.5 → 73
});

test("役判定: 条件を満たさない断片のみ → ハイカード相当 ×1", () => {
  const fragments = [frag("limit-10")]; // chips 10, kinds [LIMIT]
  const result = makeResult({ rowCount: 3, usedKinds: ["LIMIT"] });
  const score = scoreQuery({ result, fragments, jokers: [], bossRule: "none" });

  assert.equal(score.rankId, "high-card");
  assert.equal(score.rankMult, 1);
  assert.equal(score.chips, 13);
  assert.equal(score.total, 13);
});

test("役判定: 0行 → 役なし・マルチ0・スコア0", () => {
  const fragments = [frag("where-rank-eq")];
  const result = makeResult({ rowCount: 0, usedKinds: ["WHERE"] });
  const score = scoreQuery({ result, fragments, jokers: [], bossRule: "none" });

  assert.equal(score.rankId, "none");
  assert.equal(score.rankMult, 0);
  assert.equal(score.mult, 0);
  assert.equal(score.total, 0);
  assert.ok(score.notes.some((note) => note.includes("0行")));
});

test("スコア式: 端数は最終スコアのみ四捨五入する", () => {
  // チップ 29 × マルチ 2.5 = 72.5 → 73（途中では丸めない）
  const fragments = [frag("where-like-rank")];
  const result = makeResult({ rowCount: 4, usedKinds: ["WHERE", "LIKE"] });
  const score = scoreQuery({ result, fragments, jokers: [], bossRule: "none" });

  assert.equal(score.chips * score.mult, 72.5);
  assert.equal(score.total, 73);
});

test("notes は計算過程を順序どおり含む", () => {
  const fragments = [frag("where-rank-eq")];
  const result = makeResult({ rowCount: 10, usedKinds: ["WHERE"] });
  const score = scoreQuery({ result, fragments, jokers: [], bossRule: "none" });

  assert.ok(score.notes.length >= 4);
  assert.ok(score.notes[0].includes("役判定"));
  assert.ok(score.notes.some((note) => note.includes("断片チップ")));
  assert.ok(score.notes.some((note) => note.includes("行チップ")));
  assert.ok(score.notes.some((note) => note.includes("チップ合計")));
  assert.ok(score.notes.some((note) => note.includes("マルチ合計")));
  assert.ok(score.notes[score.notes.length - 1].includes("スコア"));
});

// ---------------------------------------------------------------------------
// ジョーカー効果（6種）
// ---------------------------------------------------------------------------

test("ジョーカー: NULL の使者（NULLを含む行があればマルチ+4の定額）", () => {
  const fragments = [frag("where-rank-eq")]; // chips 10
  const rows: Row[] = [{ edition: null }, { edition: "foil" }, { seal: null }];
  const result = makeResult({ rows, rowCount: 3, hasNull: true, usedKinds: ["WHERE"] });
  const joker = findJoker("null-mult");
  assert.ok(joker);

  const score = scoreQuery({ result, fragments, jokers: [joker], bossRule: "none" });

  // NULL を含む行が2行あっても、加算は定額 +4（行数に比例しない）
  assert.equal(score.jokerMult, 4);
  assert.equal(score.mult, 6); // 役2 + 4
  assert.equal(score.chips, 13); // 10 + 3
  assert.equal(score.total, 78);
});

test("ジョーカー: NULL の使者は NULL が無ければ加算されない", () => {
  const fragments = [frag("where-rank-eq")];
  const rows: Row[] = [{ edition: "foil" }, { edition: "holo" }];
  const result = makeResult({ rows, rowCount: 2, usedKinds: ["WHERE"] });
  const joker = findJoker("null-mult");
  assert.ok(joker);

  const score = scoreQuery({ result, fragments, jokers: [joker], bossRule: "none" });

  assert.equal(score.jokerMult, 0);
  assert.equal(score.mult, 2); // 役2のみ
});

test("ジョーカー: LIKE の釣り人（LIKE断片1枚につきチップ+30）", () => {
  const fragments = [frag("where-like-rank"), frag("where-like-seal")]; // LIKE 2枚
  const result = makeResult({ rowCount: 5, usedKinds: ["WHERE", "LIKE"] });
  const joker = findJoker("like-chips");
  assert.ok(joker);

  const score = scoreQuery({ result, fragments, jokers: [joker], bossRule: "none" });

  assert.equal(score.jokerChips, 60); // 30 × 2
  assert.equal(score.fragmentChips, 50); // 25 + 25
  assert.equal(score.chips, 115); // 50 + 5 + 60
  assert.equal(score.total, 288); // 115 × 2.5 = 287.5 → 288
});

test("ジョーカー: 行の蒐集家（返却行1行につきチップ+5）", () => {
  const fragments = [frag("where-rank-eq")]; // chips 10
  const result = makeResult({ rowCount: 10, usedKinds: ["WHERE"] });
  const joker = findJoker("row-chips");
  assert.ok(joker);

  const score = scoreQuery({ result, fragments, jokers: [joker], bossRule: "none" });

  assert.equal(score.jokerChips, 50); // 5 × 10
  assert.equal(score.chips, 70); // 10 + 10 + 50
  assert.equal(score.total, 140);
});

test("ジョーカー: 窓の魔術師（WINDOW断片1枚につきマルチ+3）", () => {
  const fragments = [frag("window-row-number"), frag("window-count")]; // WINDOW 2枚
  const result = makeResult({ rowCount: 5, usedKinds: ["WINDOW"] });
  const joker = findJoker("window-mult");
  assert.ok(joker);

  const score = scoreQuery({ result, fragments, jokers: [joker], bossRule: "none" });

  assert.equal(score.jokerMult, 6); // 3 × 2
  assert.equal(score.mult, 12); // 役6 + 6
  assert.equal(score.chips, 80); // 35 + 40 + 5
  assert.equal(score.total, 960);
});

test("ジョーカー: 秩序の否定（ORDER BY 不使用ならマルチ+5）", () => {
  const joker = findJoker("no-order-mult");
  assert.ok(joker);

  // ORDER BY なし → 加算される
  const withoutOrder = scoreQuery({
    result: makeResult({ rowCount: 5, usedKinds: ["WHERE"] }),
    fragments: [frag("where-rank-eq")],
    jokers: [joker],
    bossRule: "none",
  });
  assert.equal(withoutOrder.jokerMult, 5);
  assert.equal(withoutOrder.mult, 7); // 役2 + 5
  assert.equal(withoutOrder.total, 105); // 15 × 7

  // ORDER BY あり → 加算されない
  const withOrder = scoreQuery({
    result: makeResult({ rowCount: 5, usedKinds: ["WHERE", "ORDER_BY"] }),
    fragments: [frag("where-rank-eq"), frag("order-by-chip")],
    jokers: [joker],
    bossRule: "none",
  });
  assert.equal(withOrder.jokerMult, 0);
  assert.equal(withOrder.mult, 2);
  assert.equal(withOrder.total, 60); // 30 × 2
});

test("ジョーカー: 重複の鏡（完全重複行があればマルチ+6の定額）", () => {
  const fragments = [frag("where-rank-eq")]; // chips 10
  const rows: Row[] = [
    { rank: "A", suit: "S" },
    { rank: "A", suit: "S" },
    { rank: "K", suit: "H" },
  ];
  const result = makeResult({
    rows,
    rowCount: 3,
    hasDuplicateRows: true,
    usedKinds: ["WHERE"],
  });
  const joker = findJoker("dup-mult");
  assert.ok(joker);

  const score = scoreQuery({ result, fragments, jokers: [joker], bossRule: "none" });

  // 重複行が2行あっても、加算は定額 +6（行数に比例しない）
  assert.equal(score.jokerMult, 6);
  assert.equal(score.mult, 8); // 役2 + 6
  assert.equal(score.chips, 13);
  assert.equal(score.total, 104); // 13 × 8
});

test("ジョーカー: 重複の鏡は重複行が無ければ加算されない", () => {
  const fragments = [frag("where-rank-eq")];
  const rows: Row[] = [{ rank: "A", suit: "S" }, { rank: "K", suit: "H" }];
  const result = makeResult({
    rows,
    rowCount: 2,
    hasDuplicateRows: false,
    usedKinds: ["WHERE"],
  });
  const joker = findJoker("dup-mult");
  assert.ok(joker);

  const score = scoreQuery({ result, fragments, jokers: [joker], bossRule: "none" });

  assert.equal(score.jokerMult, 0);
  assert.equal(score.mult, 2); // 役2のみ
});

test("ジョーカー: 複数同時に適用され、チップとマルチが別枠で積まれる", () => {
  const fragments = [frag("where-like-rank")]; // chips 25, LIKE 1枚
  const rows: Row[] = [{ edition: null }, { edition: null }];
  const result = makeResult({ rows, rowCount: 2, hasNull: true, usedKinds: ["WHERE", "LIKE"] });
  const jokers = [findJoker("null-mult"), findJoker("like-chips"), findJoker("row-chips")];
  assert.ok(jokers.every((joker) => joker !== undefined));

  const score = scoreQuery({
    result,
    fragments,
    jokers: jokers as NonNullable<(typeof jokers)[number]>[],
    bossRule: "none",
  });

  assert.equal(score.jokerChips, 40); // LIKE 30 + 行 5×2=10
  assert.equal(score.jokerMult, 4); // NULL を含むので定額 +4
  assert.equal(score.chips, 67); // 25 + 2 + 40
  assert.equal(score.mult, 6.5); // 役2.5 + 4
  assert.equal(score.total, 436); // 67 × 6.5 = 435.5 → 436
});

// ---------------------------------------------------------------------------
// Boss 妨害（スコア側）
// ---------------------------------------------------------------------------

test("Boss zeroOnDuplicate: 完全重複行を含むとスコア0", () => {
  const fragments = [frag("where-rank-eq")];
  const rows: Row[] = [{ rank: "A" }, { rank: "A" }];
  const result = makeResult({
    rows,
    rowCount: 2,
    hasDuplicateRows: true,
    usedKinds: ["WHERE"],
  });

  const normal = scoreQuery({ result, fragments, jokers: [], bossRule: "none" });
  assert.ok(normal.total > 0);

  const zeroed = scoreQuery({ result, fragments, jokers: [], bossRule: "zeroOnDuplicate" });
  assert.equal(zeroed.total, 0);
  assert.ok(zeroed.notes.some((note) => note.includes("重複でスコア0")));
});

test("Boss zeroOnDuplicate: 重複が無ければ通常どおりスコアが出る", () => {
  const fragments = [frag("where-rank-eq")];
  const result = makeResult({ rowCount: 2, usedKinds: ["WHERE"] });
  const score = scoreQuery({ result, fragments, jokers: [], bossRule: "zeroOnDuplicate" });

  assert.equal(score.total, 24); // (10+2) × 2
});

// ---------------------------------------------------------------------------
// 乱数
// ---------------------------------------------------------------------------

test("mulberry32: 同じ seed なら同じ数列を返す", () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const seqA = [a(), a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b(), b()];

  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((value) => value >= 0 && value < 1));
});

test("mulberry32: seed が違えば数列も違う", () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  assert.notDeepEqual([a(), a(), a()], [b(), b(), b()]);
});

// ---------------------------------------------------------------------------
// ラン生成と初期状態
// ---------------------------------------------------------------------------

test("createRun: 初期状態が仕様どおり（アンティ1 / Small / 手札8枚）", () => {
  const { engine } = makeEngine();
  const run = createRun({ seed: 1 }, engine);

  assert.equal(run.state.ante, 1);
  assert.equal(run.state.blind, "small");
  // 目標チップは data 側の調整値なので、直書きせず targetChips() と突き合わせる
  assert.equal(run.state.targetChips, targetChips(1, "small"));
  assert.equal(run.state.blindScore, 0);
  assert.equal(run.state.playsLeft, RULES.playsPerBlind);
  assert.equal(run.state.discardsLeft, RULES.discardsPerBlind);
  assert.equal(run.state.hand.length, RULES.handSize);
  assert.equal(run.state.status, "playing");
  assert.equal(run.state.bossRule, "none");
  assert.deepEqual(run.state.history, []);
  // 開始ジョーカーを1つ持つ（data/antes.ts のコメント参照）
  assert.equal(run.state.jokers.length, 1);
  assert.equal(run.state.jokers[0].id, "row-chips");
  assert.deepEqual(run.state.pendingJokerChoices, []);
});

test("createRun: エンジン未注入でも生成自体は成功する（遅延解決）", () => {
  // db が未実装でも、play() を呼ぶまではエンジンを解決しない
  const run = createRun({ seed: 3 });
  assert.equal(run.state.hand.length, RULES.handSize);
});

test("createRun: 同じ seed なら同じ手札になる（決定性）", () => {
  const { engine } = makeEngine();
  const a = createRun({ seed: 2026 }, engine);
  const b = createRun({ seed: 2026 }, engine);

  assert.deepEqual(
    a.state.hand.map((fragment) => fragment.id),
    b.state.hand.map((fragment) => fragment.id),
  );
});

test("createRun: seed が違えば手札も変わる", () => {
  const { engine } = makeEngine();
  const a = createRun({ seed: 1 }, engine);
  const b = createRun({ seed: 2 }, engine);

  assert.notDeepEqual(
    a.state.hand.map((fragment) => fragment.id),
    b.state.hand.map((fragment) => fragment.id),
  );
});

test("createRun: 山札を共有定数から壊さない", () => {
  const { engine } = makeEngine();
  const before = findFragment("where-rank-eq");
  createRun({ seed: 99 }, engine);
  const after = findFragment("where-rank-eq");

  assert.equal(before, after);
  assert.equal(after?.id, "where-rank-eq");
});

test("createRun: initialJokers で初期ジョーカーを積める", () => {
  const { engine } = makeEngine();
  const run = createRun({ seed: 1, initialJokers: ["null-mult", "row-chips"] }, engine);

  // 開始ジョーカー（row-chips）1個 + null-mult 1個。row-chips は重複しない。
  assert.equal(run.state.jokers.length, 2);
  assert.equal(run.state.jokers[0].id, "row-chips");
  assert.equal(run.state.jokers[1].id, "null-mult");
});

test("createRun: 未知の初期ジョーカーIDは無視する", () => {
  const { engine } = makeEngine();
  const run = createRun({ seed: 1, initialJokers: ["no-such-joker"] }, engine);

  // 未知IDは無視され、開始ジョーカー1個だけが残る
  assert.equal(run.state.jokers.length, 1);
});

// ---------------------------------------------------------------------------
// プレイの制限
// ---------------------------------------------------------------------------

test("制限: 6枚並べると拒否される", () => {
  const { engine } = makeEngine({ rowCount: 10 });
  const run = createRun({ seed: 5 }, engine);

  const outcome = run.play(handIds(run, 6));

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, "invalid-count");
  assert.ok(outcome.error?.message.includes("最大"));
  // 拒否された手はプレイ回数を消費しない
  assert.equal(run.state.playsLeft, RULES.playsPerBlind);
});

test("制限: 0枚は拒否される", () => {
  const { engine } = makeEngine({ rowCount: 10 });
  const run = createRun({ seed: 5 }, engine);

  const outcome = run.play([]);

  assert.equal(outcome.ok, false);
  assert.equal(run.state.playsLeft, RULES.playsPerBlind);
});

test("制限: 手札にないIDは拒否される", () => {
  const { engine } = makeEngine({ rowCount: 10 });
  const run = createRun({ seed: 5 }, engine);

  const outcome = run.play(["not-in-hand"]);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, "unknown-fragment");
  assert.ok(outcome.error?.message.includes("手札にない"));
  assert.equal(run.state.playsLeft, RULES.playsPerBlind);
});

test("制限: 同じ断片を2回選ぶと拒否される", () => {
  const { engine } = makeEngine({ rowCount: 10 });
  const run = createRun({ seed: 5 }, engine);
  const id = run.state.hand[0].id;

  const outcome = run.play([id, id]);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, "duplicate-fragment");
  assert.ok(outcome.error?.message.includes("2回"));
});

test("制限: プレイ5回目は拒否される", () => {
  // 0行を返すフェイクなら、どの断片を引いてもスコアは必ず0になる（手札の運に依存しない）
  const { engine } = makeEngine({ rowCount: 0 });
  const run = createRun({ seed: 11 }, engine);

  for (let i = 0; i < RULES.playsPerBlind; i += 1) {
    const outcome = run.play([run.state.hand[0].id]);
    assert.equal(outcome.ok, true, `${i + 1}回目のプレイが失敗しました`);
  }
  assert.equal(run.state.playsLeft, 0);

  const fifth = run.play([run.state.hand[0].id]);
  assert.equal(fifth.ok, false);
  assert.equal(run.state.playsLeft, 0);
});

test("制限: ディスカード3回目は拒否される", () => {
  const { engine } = makeEngine({ rowCount: 10 });
  const run = createRun({ seed: 5 }, engine);

  const first = run.discard([run.state.hand[0].id]);
  assert.equal(first.discarded, 1);
  assert.equal(run.state.discardsLeft, 1);

  const second = run.discard([run.state.hand[0].id]);
  assert.equal(second.discarded, 1);
  assert.equal(run.state.discardsLeft, 0);

  const third = run.discard([run.state.hand[0].id]);
  assert.equal(third.discarded, 0);
  assert.equal(third.error?.code, "no-discards-left");
  assert.ok(third.error?.message.includes("ディスカード回数"));
  assert.equal(run.state.discardsLeft, 0);
});

test("ディスカード: 手札から消えて山札から補充される", () => {
  const { engine } = makeEngine({ rowCount: 10 });
  const run = createRun({ seed: 5 }, engine);
  const target = run.state.hand[0].id;
  const handSizeBefore = run.state.hand.length;

  const outcome = run.discard([target]);

  assert.equal(outcome.discarded, 1);
  assert.equal(run.state.hand.length, handSizeBefore);
  assert.ok(!run.state.hand.some((fragment) => fragment.id === target));
  assert.ok(run.state.discardPile.some((fragment) => fragment.id === target));
});

test("ディスカード: 6枚は拒否される", () => {
  const { engine } = makeEngine({ rowCount: 10 });
  const run = createRun({ seed: 5 }, engine);

  const outcome = run.discard(handIds(run, 6));

  assert.equal(outcome.discarded, 0);
  assert.equal(run.state.discardsLeft, RULES.discardsPerBlind);
});

// ---------------------------------------------------------------------------
// プレイの成功・失敗
// ---------------------------------------------------------------------------

test("play: 成功するとスコアが加算され、履歴に残る", () => {
  const { engine } = makeEngine({ rowCount: 10 });
  const run = createRun({ seed: 5 }, engine);
  const ids = [run.state.hand[0].id];

  const outcome = run.play(ids);

  assert.equal(outcome.ok, true);
  assert.ok(outcome.score);
  assert.ok(outcome.result);
  assert.equal(run.state.blindScore, outcome.score.total);
  assert.equal(run.state.playsLeft, RULES.playsPerBlind - 1);
  assert.equal(run.state.history.length, 1);
  assert.deepEqual(run.state.history[0].fragmentIds, ids);
  assert.equal(run.state.hand.length, RULES.handSize);
});

test("play: クエリ失敗なら ok=false でプレイ回数は消費する", () => {
  const { engine } = makeEngine({
    error: { code: "sql-error", message: "no such column: nope" },
  });
  const run = createRun({ seed: 5 }, engine);

  const outcome = run.play([run.state.hand[0].id]);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, "query-failed");
  assert.equal(outcome.error?.code === "query-failed" && outcome.error.cause.code, "sql-error");
  assert.equal(run.state.playsLeft, RULES.playsPerBlind - 1);
  assert.equal(run.state.blindScore, 0);
  assert.equal(run.state.history.length, 1);
  assert.equal(run.state.history[0].error?.code, "sql-error");
});

test("play: エンジンが例外を投げても ok=false に変換する", () => {
  const engine: QueryEngine = {
    run(): QueryResult {
      throw new Error("想定外の失敗");
    },
    buildSql(): string {
      return "SELECT 1";
    },
    close(): void {},
  };
  const run = createRun({ seed: 5 }, engine);

  const outcome = run.play([run.state.hand[0].id]);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, "query-failed");
  assert.equal(outcome.error?.code === "query-failed" && outcome.error.cause.code, "sql-error");
  assert.ok(outcome.error?.message.includes("想定外の失敗"));
});

test("play: 目標チップ到達で blindCleared=true", () => {
  // 1手で 300 を超えるスコアを出す
  const { engine } = makeEngine({ rowCount: 100 });
  const run = createRun({ seed: 5 }, engine);

  const outcome = run.play(handIds(run, 5));

  assert.equal(outcome.ok, true);
  assert.equal(outcome.blindCleared, true);
  assert.equal(outcome.runEnded, false);
  assert.ok(run.state.blindScore >= run.state.targetChips);
});

test("play: 突破済みのブラインドでは拒否される", () => {
  const { engine } = makeEngine({ rowCount: 100 });
  const run = createRun({ seed: 5 }, engine);

  run.play(handIds(run, 5));
  const second = run.play(handIds(run, 5));

  assert.equal(second.ok, false);
  assert.equal(second.error?.code, "no-plays-left");
  assert.ok(second.error?.message.includes("突破済み"));
});

test("play: 目標未達のままプレイ回数を使い切ると lost", () => {
  // 0行を返すフェイクなら、どの断片を引いてもスコアは必ず0になる（手札の運に依存しない）
  const { engine } = makeEngine({ rowCount: 0 });
  const run = createRun({ seed: 11 }, engine);

  let last;
  for (let i = 0; i < RULES.playsPerBlind; i += 1) {
    last = run.play([run.state.hand[0].id]);
  }

  assert.ok(last);
  assert.equal(last.runEnded, true);
  assert.equal(run.state.status, "lost");
  assert.equal(run.state.blindScore, 0);
  assert.ok(run.state.blindScore < run.state.targetChips);
});

test("play: ラン終了後はプレイできない", () => {
  const { engine } = makeEngine({ rowCount: 0 });
  const run = createRun({ seed: 11 }, engine);

  for (let i = 0; i < RULES.playsPerBlind; i += 1) {
    run.play([run.state.hand[0].id]);
  }
  assert.equal(run.state.status, "lost");

  const after = run.play([run.state.hand[0].id]);
  assert.equal(after.ok, false);
  assert.equal(after.runEnded, true);
});

// ---------------------------------------------------------------------------
// Boss 妨害（ラン側）
// ---------------------------------------------------------------------------

test("Boss: 妨害ルールがエンジンへ渡される", () => {
  const fake = makeEngine({ rowCount: 10 });
  const run = createRun({ seed: 5 }, fake.engine);

  // アンティ2の Boss は ORDER BY 禁止
  run.state.ante = 2;
  run.state.blind = "boss";
  run.state.bossRule = "noOrderBy";
  run.state.targetChips = 1400;
  run.state.blindScore = 0;

  run.play([run.state.hand[0].id]);

  assert.equal(fake.lastOptions()?.bossRule, "noOrderBy");
});

test("Boss: maxRows50 のとき取得上限50行をエンジンへ渡す", () => {
  const fake = makeEngine({ rowCount: 10 });
  const run = createRun({ seed: 5 }, fake.engine);

  run.state.ante = 8;
  run.state.blind = "boss";
  run.state.bossRule = "maxRows50";
  run.state.targetChips = 180000;
  run.state.blindScore = 0;

  run.play([run.state.hand[0].id]);

  assert.equal(fake.lastOptions()?.maxRows, 50);
});

test("Boss: 妨害で拒否されると ok=false でプレイ回数を消費する", () => {
  const { engine } = makeEngine({ rowCount: 10, honorBoss: true });
  const run = createRun({ seed: 5 }, engine);

  run.state.ante = 2;
  run.state.blind = "boss";
  run.state.bossRule = "noOrderBy";
  run.state.targetChips = 1400;
  run.state.blindScore = 0;

  const outcome = run.play([run.state.hand[0].id]);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, "query-failed");
  assert.equal(outcome.error?.code === "query-failed" && outcome.error.cause.code, "blocked-by-boss");
  assert.equal(run.state.playsLeft, RULES.playsPerBlind - 1);
  assert.equal(run.state.blindScore, 0);
});

test("Boss: 通常ブラインドでは妨害ルールが none", () => {
  const fake = makeEngine({ rowCount: 10 });
  const run = createRun({ seed: 5 }, fake.engine);

  run.play([run.state.hand[0].id]);

  assert.equal(fake.lastOptions()?.bossRule, "none");
});

// ---------------------------------------------------------------------------
// ブラインド進行
// ---------------------------------------------------------------------------

test("進行: small → big → boss → アンティ2 の small", () => {
  const { engine } = makeEngine({ rowCount: 100 });
  const run = createRun({ seed: 7 }, engine);

  assert.equal(run.state.blind, "small");
  clearBlind(run);
  assert.equal(run.state.blind, "big");
  assert.equal(run.state.targetChips, targetChips(1, "big"));

  clearBlind(run);
  assert.equal(run.state.blind, "boss");
  assert.equal(run.state.targetChips, targetChips(1, "boss"));

  clearBlind(run);
  assert.equal(run.state.ante, 2);
  assert.equal(run.state.blind, "small");
  assert.equal(run.state.targetChips, targetChips(2, "small"));
});

test("進行: nextBlind でプレイ回数・ディスカード回数・スコアがリセットされる", () => {
  const { engine } = makeEngine({ rowCount: 100 });
  const run = createRun({ seed: 7 }, engine);

  run.play(handIds(run, 5));
  run.discard([run.state.hand[0].id]);
  assert.ok(run.state.blindScore > 0);

  run.nextBlind();

  assert.equal(run.state.blindScore, 0);
  assert.equal(run.state.playsLeft, RULES.playsPerBlind);
  assert.equal(run.state.discardsLeft, RULES.discardsPerBlind);
  assert.equal(run.state.hand.length, RULES.handSize);
});

test("進行: 未突破なら nextBlind は何もしない", () => {
  const { engine } = makeEngine({ rowCount: 1 });
  const run = createRun({ seed: 7 }, engine);

  run.play([run.state.hand[0].id]);
  const before = { blind: run.state.blind, target: run.state.targetChips };

  run.nextBlind();

  assert.equal(run.state.blind, before.blind);
  assert.equal(run.state.targetChips, before.target);
});

test("進行: アンティ2の Boss で bossRule が zeroOnDuplicate になる", () => {
  const { engine } = makeEngine({ rowCount: 100 });
  const run = createRun({ seed: 7 }, engine);

  // アンティ1 を3ブラインド抜ける
  clearBlind(run); // small
  clearBlind(run); // big
  clearBlind(run); // boss → ante2 small
  assert.equal(run.state.ante, 2);
  assert.equal(run.state.bossRule, "none");

  clearBlind(run); // ante2 small
  clearBlind(run); // ante2 big
  assert.equal(run.state.blind, "boss");
  assert.equal(run.state.bossRule, "zeroOnDuplicate");
});

test("進行: アンティ8の Boss 突破で won", () => {
  const { engine } = makeEngine({ rowCount: 100 });
  const run = createRun({ seed: 7 }, engine);

  // アンティ8の Boss 直前に状態を合わせる（到達までの手数はここでは検証しない）
  run.state.ante = 8;
  run.state.blind = "boss";
  run.state.bossRule = "maxRows50";
  run.state.targetChips = 1;
  run.state.blindScore = 0;

  const outcome = run.play([run.state.hand[0].id]);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.blindCleared, true);
  assert.equal(outcome.runEnded, true);
  assert.equal(run.state.status, "won");
});

test("進行: won のあと nextBlind しても状態が壊れない", () => {
  const { engine } = makeEngine({ rowCount: 100 });
  const run = createRun({ seed: 7 }, engine);

  run.state.ante = 8;
  run.state.blind = "boss";
  run.state.targetChips = 1;
  run.state.blindScore = 0;
  run.play([run.state.hand[0].id]);
  assert.equal(run.state.status, "won");

  run.nextBlind();

  assert.equal(run.state.status, "won");
  assert.equal(run.state.ante, 8);
});

// ---------------------------------------------------------------------------
// ジョーカー枠
// ---------------------------------------------------------------------------

test("addJoker: 枠5まで積めて6個目は拒否される", () => {
  const { engine } = makeEngine();
  const run = createRun({ seed: 1 }, engine);
  // 開始ジョーカー（row-chips）が1個あるので、追加できるのは残り4枠
  const ids = ["null-mult", "like-chips", "window-mult", "no-order-mult"];

  for (const id of ids) {
    assert.equal(run.addJoker(id), true, `${id} を追加できませんでした`);
  }
  assert.equal(run.state.jokers.length, RULES.jokerSlots);
  assert.equal(run.addJoker("dup-mult"), false);
  assert.equal(run.state.jokers.length, RULES.jokerSlots);
});

test("addJoker: 未知のIDは拒否される", () => {
  const { engine } = makeEngine();
  const run = createRun({ seed: 1 }, engine);

  assert.equal(run.addJoker("no-such-joker"), false);
  // 開始ジョーカー1個のまま増えない
  assert.equal(run.state.jokers.length, 1);
});

test("addJoker: 積んだジョーカーがスコアに反映される", () => {
  const { engine } = makeEngine({ rowCount: 10 });
  // 開始ジョーカーが row-chips（行1行につきチップ+5）なので、
  // さらに like-chips を足して加算が積み上がることを確認する
  const run = createRun({ seed: 5 }, engine);
  assert.equal(run.addJoker("like-chips"), true);

  const outcome = run.play([run.state.hand[0].id]);

  assert.equal(outcome.ok, true);
  assert.ok(outcome.score);
  // row-chips: 5 × 10行 = 50。like-chips は LIKE 断片が無ければ 0。
  assert.equal(outcome.score.jokerChips, 50);
});

// ---------------------------------------------------------------------------
// ジョーカー報酬（突破ごとに1つ獲得できる）
// ---------------------------------------------------------------------------

test("報酬: ブラインド突破でジョーカー候補が3つ出る", () => {
  const { engine } = makeEngine({ rowCount: 100 });
  const run = createRun({ seed: 7 }, engine);

  assert.equal(run.state.pendingJokerChoices.length, 0, "開始時は候補なし");

  clearBlind(run); // small を突破して nextBlind()

  assert.equal(run.state.pendingJokerChoices.length, 3);
});

test("報酬: chooseJoker で候補から1つ獲得できる", () => {
  const { engine } = makeEngine({ rowCount: 100 });
  const run = createRun({ seed: 7 }, engine);

  clearBlind(run);
  const choice = run.state.pendingJokerChoices[0];

  assert.equal(run.chooseJoker(choice.id), true);
  // 開始ジョーカー1個 + 獲得1個
  assert.equal(run.state.jokers.length, 2);
  assert.equal(run.state.jokers[1].id, choice.id);
  // 獲得すると候補は空になる
  assert.equal(run.state.pendingJokerChoices.length, 0);
});

test("報酬: 候補にないIDは拒否される", () => {
  const { engine } = makeEngine({ rowCount: 100 });
  const run = createRun({ seed: 7 }, engine);

  clearBlind(run);
  const before = run.state.jokers.length;

  assert.equal(run.chooseJoker("no-such-joker"), false);
  assert.equal(run.state.jokers.length, before);
  // 候補は残ったまま
  assert.equal(run.state.pendingJokerChoices.length, 3);
});

test("報酬: 候補が無い状態で chooseJoker すると false", () => {
  const { engine } = makeEngine();
  const run = createRun({ seed: 7 }, engine);

  assert.equal(run.chooseJoker("null-mult"), false);
  // 開始ジョーカー1個のまま増えない
  assert.equal(run.state.jokers.length, 1);
});

test("報酬: 枠が埋まっていると候補が出ない", () => {
  const { engine } = makeEngine({ rowCount: 100 });
  const run = createRun({ seed: 7 }, engine);

  // 枠5を埋める（開始ジョーカー1個 + 追加4個）
  for (const id of ["null-mult", "like-chips", "window-mult", "no-order-mult"]) {
    assert.equal(run.addJoker(id), true);
  }
  assert.equal(run.state.jokers.length, RULES.jokerSlots);

  clearBlind(run);

  assert.equal(run.state.pendingJokerChoices.length, 0);
});

test("報酬: 候補にすでに持っているジョーカーは含まれない", () => {
  const { engine } = makeEngine({ rowCount: 100 });
  const run = createRun({ seed: 7 }, engine);

  run.addJoker("null-mult");
  clearBlind(run);

  const ids = run.state.pendingJokerChoices.map((joker) => joker.id);
  assert.ok(!ids.includes("null-mult"), "所持済みのジョーカーが候補に出ている");
});

test("報酬: 突破のたびに候補が出る（連続したブラインド）", () => {
  const { engine } = makeEngine({ rowCount: 100 });
  const run = createRun({ seed: 7 }, engine);

  clearBlind(run); // small
  assert.equal(run.state.pendingJokerChoices.length, 3);
  run.chooseJoker(run.state.pendingJokerChoices[0].id);
  // 開始ジョーカー1個 + 獲得1個
  assert.equal(run.state.jokers.length, 2);

  clearBlind(run); // big
  // 突破しただけでは候補が出るだけで、まだ獲得していない
  assert.equal(run.state.pendingJokerChoices.length, 3);
  assert.equal(run.state.jokers.length, 2);

  run.chooseJoker(run.state.pendingJokerChoices[0].id);
  assert.equal(run.state.jokers.length, 3);
});

test("報酬: 未突破では nextBlind しても候補が出ない", () => {
  const { engine } = makeEngine({ rowCount: 1 });
  const run = createRun({ seed: 7 }, engine);

  run.play([run.state.hand[0].id]);
  run.nextBlind();

  assert.equal(run.state.pendingJokerChoices.length, 0);
});

test("報酬: ジョーカーを積むとスコアが伸びる（クリア可能性の担保）", () => {
  // ジョーカー無しではアンティ8に到達できないため、報酬系が機能することが必須
  const { engine } = makeEngine({ rowCount: 100 });
  const run = createRun({ seed: 5 }, engine);

  const before = run.play(handIds(run, 5));
  assert.equal(before.ok, true);
  const scoreWithout = before.score?.total ?? 0;

  const run2 = createRun({ seed: 5 }, engine);
  run2.addJoker("row-chips"); // 行1行につきチップ+5
  const after = run2.play(handIds(run2, 5));
  assert.equal(after.ok, true);
  const scoreWith = after.score?.total ?? 0;

  assert.ok(scoreWith > scoreWithout, `ジョーカーでスコアが伸びていない（${scoreWithout} → ${scoreWith}）`);
});

// ---------------------------------------------------------------------------
// 表示ヘルパ
// ---------------------------------------------------------------------------

test("describeBlind: アンティとブラインド種別を表示する", () => {
  const { engine } = makeEngine();
  const run = createRun({ seed: 1 }, engine);

  assert.equal(describeBlind(run.state), "アンティ1 / Small");
});

test("summarizeScore: 役・チップ・マルチ・合計を1行にまとめる", () => {
  const fragments = [frag("where-rank-eq")];
  const result = makeResult({ rowCount: 10, usedKinds: ["WHERE"] });
  const score = scoreQuery({ result, fragments, jokers: [], bossRule: "none" });

  const summary = summarizeScore(score);

  assert.ok(summary.includes("ペア相当"));
  assert.ok(summary.includes("40"));
});

// ---------------------------------------------------------------------------
// 通し確認（1ランを最後まで自動で進められること）
// ---------------------------------------------------------------------------

test("通し: フェイクエンジンでアンティ8の Boss まで到達できる", () => {
  // ここで見たいのは「ループと進行が最後まで破綻しないこと」であり、バランスではない。
  // アンティ8の目標（数万）に届くよう、フェイクは大きめの行数を返す。
  // 実際のバランス検証は scripts/balance.ts（task-3）の担当。
  const { engine } = makeEngine({ rowCount: 5000 });
  const run = createRun({ seed: 2026 }, engine);

  let guard = 0;
  while (run.state.status === "playing" && guard < 200) {
    if (run.state.blindScore >= run.state.targetChips) {
      run.nextBlind();
      continue;
    }
    const outcome = run.play(handIds(run, RULES.maxPlayFragments));
    assert.equal(outcome.ok, true, `プレイが失敗しました: ${outcome.error?.message ?? ""}`);
    guard += 1;
  }

  assert.equal(run.state.status, "won");
  assert.equal(run.state.ante, RULES.maxAnte);
  assert.equal(run.state.blind, "boss");
  assert.ok(run.state.history.length > 0);
});
