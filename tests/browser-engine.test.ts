/**
 * Node 版エンジンとブラウザ版エンジンの一致テスト。
 *
 * Issue #7 / #8 の受け入れ条件「CLIの計算結果との一致を自動テストで保証する」に対応する。
 *
 * ブラウザ版は `sql.js`（WebAssembly 版 SQLite）、Node 版は `node:sqlite` を使う。
 * どちらも同じ SQLite だが、ラッパーが違うため次の点でズレる可能性がある:
 *   - 行の形（列名 → 値、NULL の表現）
 *   - 数値の型（integer / real の扱い）
 *   - エラーメッセージ
 *   - 取得上限の切り詰め
 *
 * ここでは**ゲームの判定に影響する値**（行数・NULL有無・重複有無・使用句）が
 * 完全に一致することを、断片の全組み合わせに対して検証する。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createEngineFromSchema } from "../src/db/engine.ts";
import { createBrowserEngine } from "../src/db/browser-engine.ts";
import { FRAGMENTS } from "../src/data/fragments.ts";
import { JOKERS } from "../src/data/jokers.ts";
import { ANTES } from "../src/data/antes.ts";
import { scoreQuery } from "../src/logic/score.ts";
import { createRun } from "../src/logic/run.ts";
import type { BossRuleId, FragmentCard, QueryEngine, QueryPlan } from "../src/types.ts";

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

/** 2つの QueryResult の「ゲーム判定に効く部分」が一致することを検証する。 */
function assertSameVerdict(
  nodeResult: ReturnType<QueryEngine["run"]>,
  browserResult: ReturnType<QueryEngine["run"]>,
  label: string,
): void {
  assert.equal(
    browserResult.error?.code,
    nodeResult.error?.code,
    `${label}: エラーコードが違う（node=${nodeResult.error?.code} browser=${browserResult.error?.code}）`,
  );
  if (nodeResult.error) return; // エラーなら以降の比較は不要

  assert.equal(browserResult.rowCount, nodeResult.rowCount, `${label}: 行数が違う`);
  assert.equal(browserResult.hasNull, nodeResult.hasNull, `${label}: NULL有無が違う`);
  assert.equal(
    browserResult.hasDuplicateRows,
    nodeResult.hasDuplicateRows,
    `${label}: 重複有無が違う`,
  );
  assert.deepEqual(browserResult.usedKinds, nodeResult.usedKinds, `${label}: 使用句が違う`);
  assert.equal(browserResult.sql, nodeResult.sql, `${label}: 生成SQLが違う`);
}

/** 断片の並びから QueryPlan を作る。 */
function plan(fragments: FragmentCard[]): QueryPlan {
  return { baseTable: "cards", fragments };
}

// ---------------------------------------------------------------------------
// 単体断片
// ---------------------------------------------------------------------------

test("一致: 全断片が単体で同じ結果を返す", async () => {
  const nodeEngine = createEngineFromSchema();
  const browserEngine = await createBrowserEngine();
  try {
    for (const fragment of FRAGMENTS) {
      const p = plan([fragment]);
      assertSameVerdict(nodeEngine.run(p), browserEngine.run(p), fragment.id);
    }
  } finally {
    nodeEngine.close();
    browserEngine.close();
  }
});

// ---------------------------------------------------------------------------
// 組み合わせ
// ---------------------------------------------------------------------------

test("一致: 2枚の全組み合わせ（276通り）で同じ結果を返す", async () => {
  const nodeEngine = createEngineFromSchema();
  const browserEngine = await createBrowserEngine();
  try {
    let checked = 0;
    for (let i = 0; i < FRAGMENTS.length; i++) {
      for (let j = i + 1; j < FRAGMENTS.length; j++) {
        const p = plan([FRAGMENTS[i]!, FRAGMENTS[j]!]);
        assertSameVerdict(nodeEngine.run(p), browserEngine.run(p), `${FRAGMENTS[i]!.id}+${FRAGMENTS[j]!.id}`);
        checked += 1;
      }
    }
    assert.ok(checked > 200, `組み合わせ数が少なすぎる: ${checked}`);
  } finally {
    nodeEngine.close();
    browserEngine.close();
  }
});

test("一致: 3枚の組み合わせ（一部）で同じ結果を返す", async () => {
  const nodeEngine = createEngineFromSchema();
  const browserEngine = await createBrowserEngine();
  try {
    // 全組み合わせは 1771 通りあるので、決定的に間引いて検証する
    let checked = 0;
    for (let i = 0; i < FRAGMENTS.length; i += 2) {
      for (let j = i + 1; j < FRAGMENTS.length; j += 3) {
        for (let k = j + 1; k < FRAGMENTS.length; k += 5) {
          const p = plan([FRAGMENTS[i]!, FRAGMENTS[j]!, FRAGMENTS[k]!]);
          assertSameVerdict(
            nodeEngine.run(p),
            browserEngine.run(p),
            `${FRAGMENTS[i]!.id}+${FRAGMENTS[j]!.id}+${FRAGMENTS[k]!.id}`,
          );
          checked += 1;
        }
      }
    }
    assert.ok(checked > 50, `組み合わせ数が少なすぎる: ${checked}`);
  } finally {
    nodeEngine.close();
    browserEngine.close();
  }
});

// ---------------------------------------------------------------------------
// Boss 妨害
// ---------------------------------------------------------------------------

test("一致: 全 Boss ルールで同じ判定を返す", async () => {
  const nodeEngine = createEngineFromSchema();
  const browserEngine = await createBrowserEngine();
  const rules: BossRuleId[] = ["none", "noOrderBy", "noLike", "noJoin", "zeroOnDuplicate", "maxRows50"];
  try {
    for (const rule of rules) {
      for (const fragment of FRAGMENTS) {
        const p = plan([fragment]);
        assertSameVerdict(
          nodeEngine.run(p, { bossRule: rule }),
          browserEngine.run(p, { bossRule: rule }),
          `${rule}/${fragment.id}`,
        );
      }
    }
  } finally {
    nodeEngine.close();
    browserEngine.close();
  }
});

// ---------------------------------------------------------------------------
// 取得上限
// ---------------------------------------------------------------------------

test("一致: 取得上限の切り詰めが同じ", async () => {
  const nodeEngine = createEngineFromSchema();
  const browserEngine = await createBrowserEngine();
  try {
    for (const maxRows of [1, 5, 10, 50, 100]) {
      const p = plan([]);
      assertSameVerdict(
        nodeEngine.run(p, { maxRows }),
        browserEngine.run(p, { maxRows }),
        `maxRows=${maxRows}`,
      );
    }
  } finally {
    nodeEngine.close();
    browserEngine.close();
  }
});

// ---------------------------------------------------------------------------
// スコア計算の一致
// ---------------------------------------------------------------------------

test("一致: 同じクエリならスコア内訳が完全に一致する", async () => {
  const nodeEngine = createEngineFromSchema();
  const browserEngine = await createBrowserEngine();
  try {
    // ジョーカーの全組み合わせ（6種から0〜2個）で検証
    const jokerSets: (typeof JOKERS)[] = [[]];
    for (const joker of JOKERS) jokerSets.push([joker]);
    for (let i = 0; i < JOKERS.length; i++) {
      for (let j = i + 1; j < JOKERS.length; j++) {
        jokerSets.push([JOKERS[i]!, JOKERS[j]!]);
      }
    }

    for (const fragments of [
      [FRAGMENTS[0]!],
      [FRAGMENTS[5]!],
      [FRAGMENTS[10]!],
      [FRAGMENTS[0]!, FRAGMENTS[10]!],
      [FRAGMENTS[5]!, FRAGMENTS[10]!, FRAGMENTS[15]!],
    ]) {
      const p = plan(fragments);
      const nodeResult = nodeEngine.run(p);
      const browserResult = browserEngine.run(p);
      for (const jokers of jokerSets) {
        const nodeScore = scoreQuery({ result: nodeResult, fragments, jokers, bossRule: "none" });
        const browserScore = scoreQuery({
          result: browserResult,
          fragments,
          jokers,
          bossRule: "none",
        });
        assert.deepEqual(
          browserScore,
          nodeScore,
          `スコアが違う（断片 ${fragments.map((f) => f.id).join("+")} / ジョーカー ${jokers.map((j) => j.id).join("+") || "なし"}）`,
        );
      }
    }
  } finally {
    nodeEngine.close();
    browserEngine.close();
  }
});

// ---------------------------------------------------------------------------
// ラン進行の一致（最重要: ゲーム全体が同じ結果になるか）
// ---------------------------------------------------------------------------

test("一致: 同じ seed なら同じ手札・同じ進行になる", async () => {
  const nodeEngine = createEngineFromSchema();
  const browserEngine = await createBrowserEngine();
  try {
    for (const seed of [1, 7, 42, 2026]) {
      const nodeRun = createRun({ seed }, nodeEngine);
      const browserRun = createRun({ seed }, browserEngine);

      assert.deepEqual(
        browserRun.state.hand.map((f) => f.id),
        nodeRun.state.hand.map((f) => f.id),
        `seed=${seed}: 手札が違う`,
      );
      assert.equal(browserRun.state.targetChips, nodeRun.state.targetChips);
      assert.equal(browserRun.state.ante, nodeRun.state.ante);
      assert.equal(browserRun.state.blind, nodeRun.state.blind);
    }
  } finally {
    nodeEngine.close();
    browserEngine.close();
  }
});

test("一致: 同じ手を打つとスコアと進行が完全に一致する", async () => {
  const nodeEngine = createEngineFromSchema();
  const browserEngine = await createBrowserEngine();
  try {
    const seed = 2026;
    const nodeRun = createRun({ seed }, nodeEngine);
    const browserRun = createRun({ seed }, browserEngine);

    // 同じ手札から同じ5枚を打ち続け、ブラインドを進める
    for (let step = 0; step < 40; step++) {
      if (nodeRun.state.status !== "playing" || browserRun.state.status !== "playing") break;

      // ジョーカー報酬は同じ選択をする
      if (nodeRun.state.pendingJokerChoices.length > 0) {
        const nodeChoice = nodeRun.state.pendingJokerChoices[0]!;
        const browserChoice = browserRun.state.pendingJokerChoices[0]!;
        assert.equal(browserChoice.id, nodeChoice.id, "ジョーカー候補が違う");
        nodeRun.chooseJoker(nodeChoice.id);
        browserRun.chooseJoker(browserChoice.id);
        continue;
      }

      if (nodeRun.state.blindScore >= nodeRun.state.targetChips) {
        nodeRun.nextBlind();
        browserRun.nextBlind();
        continue;
      }

      const ids = nodeRun.state.hand.slice(0, 5).map((f) => f.id);
      const nodeOutcome = nodeRun.play(ids);
      const browserOutcome = browserRun.play(ids);

      assert.equal(browserOutcome.ok, nodeOutcome.ok, `step${step}: 成否が違う`);
      assert.deepEqual(browserOutcome.score, nodeOutcome.score, `step${step}: スコアが違う`);
      assert.equal(browserRun.state.blindScore, nodeRun.state.blindScore, `step${step}: 累計が違う`);
      assert.equal(browserRun.state.playsLeft, nodeRun.state.playsLeft, `step${step}: 残り回数が違う`);
    }

    assert.equal(browserRun.state.status, nodeRun.state.status, "最終状態が違う");
    assert.equal(browserRun.state.ante, nodeRun.state.ante, "到達アンティが違う");
  } finally {
    nodeEngine.close();
    browserEngine.close();
  }
});

// ---------------------------------------------------------------------------
// 拒否系の一致
// ---------------------------------------------------------------------------

test("一致: 不正な SQL はどちらも拒否する", async () => {
  const nodeEngine = createEngineFromSchema();
  const browserEngine = await createBrowserEngine();
  try {
    const badPlans: QueryPlan[] = [
      { baseTable: "存在しないテーブル", fragments: [] },
      { baseTable: "cards; DROP TABLE cards", fragments: [] },
      {
        baseTable: "cards",
        fragments: [
          { id: "x", name: "x", sql: "cards.存在しない列 = 1", clause: "WHERE", kinds: ["WHERE"], chips: 0 },
        ],
      },
      {
        baseTable: "cards",
        fragments: [
          { id: "y", name: "y", sql: "1; DELETE FROM cards_raw", clause: "WHERE", kinds: ["WHERE"], chips: 0 },
        ],
      },
      {
        baseTable: "cards",
        fragments: [
          { id: "z", name: "z", sql: "CROSS JOIN suits", clause: "JOIN", kinds: ["JOIN"], chips: 0 },
        ],
      },
    ];
    for (const p of badPlans) {
      assertSameVerdict(nodeEngine.run(p), browserEngine.run(p), JSON.stringify(p).slice(0, 60));
    }
  } finally {
    nodeEngine.close();
    browserEngine.close();
  }
});

// ---------------------------------------------------------------------------
// 全アンティの目標値が同じ（データ層の一致）
// ---------------------------------------------------------------------------

test("一致: アンティ設定が両エンジンで同じ", async () => {
  const nodeEngine = createEngineFromSchema();
  const browserEngine = await createBrowserEngine();
  try {
    for (const ante of ANTES) {
      for (const blind of ["small", "big", "boss"] as const) {
        const nodeRun = createRun({ seed: 1 }, nodeEngine);
        const browserRun = createRun({ seed: 1 }, browserEngine);
        // 状態を直接進めて目標値を比較する
        nodeRun.state.ante = ante.ante;
        nodeRun.state.blind = blind;
        browserRun.state.ante = ante.ante;
        browserRun.state.blind = blind;
        assert.equal(browserRun.state.targetChips, nodeRun.state.targetChips);
      }
    }
  } finally {
    nodeEngine.close();
    browserEngine.close();
  }
});
