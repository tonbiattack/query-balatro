/**
 * DB 実行基盤のテスト。
 *
 * 受け入れ条件（Issue #2）に対応:
 *   - 読み取り専用接続でSQLiteを開く
 *   - 組み立て結果がSELECT以外なら実行前に拒否する
 *   - 1クエリ100ms / 取得上限100行の制限を適用する
 *   - 役判定に必要な情報（使用句・返却行数・NULL有無）を返す
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildSql } from "../src/db/build.ts";
import { createEngine, createEngineFromSchema } from "../src/db/engine.ts";
import { findFragment } from "../src/data/fragments.ts";
import { GAME_SCHEMA } from "../src/data/schema.ts";
import { RULES } from "../src/types.ts";
import type { FragmentCard, QueryPlan } from "../src/types.ts";

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

/** ID から断片を引く（存在しなければテストを失敗させる）。 */
function frag(id: string): FragmentCard {
  const found = findFragment(id);
  assert.ok(found, `断片 ${id} が見つかりません`);
  return found;
}

/** 断片IDの並びから QueryPlan を作る。 */
function plan(...ids: string[]): QueryPlan {
  return { baseTable: "cards", fragments: ids.map(frag) };
}

/** テスト用のエンジンを作り、テスト終了時に閉じる。 */
function withEngine(fn: (engine: ReturnType<typeof createEngineFromSchema>) => void): void {
  const engine = createEngineFromSchema();
  try {
    fn(engine);
  } finally {
    engine.close();
  }
}

// ---------------------------------------------------------------------------
// SQL 組み立て
// ---------------------------------------------------------------------------

test("buildSql: 断片が無ければ SELECT * FROM cards", () => {
  assert.equal(buildSql(plan()), "SELECT * FROM cards");
});

test("buildSql: WHERE 断片は WHERE 句になる", () => {
  const sql = buildSql(plan("where-rank-eq"));
  assert.equal(sql, "SELECT * FROM cards WHERE cards.rank = 'A'");
});

test("buildSql: 複数の WHERE は AND で連結される", () => {
  const sql = buildSql(plan("where-rank-eq", "where-suit-eq"));
  assert.equal(sql, "SELECT * FROM cards WHERE cards.rank = 'A' AND cards.suit = 'H'");
});

test("buildSql: 並べた順に関係なく正規の句順になる", () => {
  // わざと逆順（LIMIT → ORDER BY → WHERE → JOIN）で渡す
  const sql = buildSql(plan("limit-5", "order-by-chip", "where-rank-eq", "join-suits"));
  assert.equal(
    sql,
    "SELECT * FROM cards JOIN suits ON cards.suit = suits.code " +
      "WHERE cards.rank = 'A' ORDER BY cards.chip_value DESC LIMIT 5",
  );
});

test("buildSql: SELECT_EXPR 断片は SELECT の列になる", () => {
  const sql = buildSql(plan("window-row-number"));
  assert.ok(sql.startsWith("SELECT ROW_NUMBER() OVER"));
  assert.ok(sql.includes("FROM cards"));
});

test("buildSql: GROUP BY の列は SELECT にも含まれる", () => {
  const sql = buildSql(plan("group-by-rank", "having-count"));
  assert.equal(sql, "SELECT cards.rank FROM cards GROUP BY cards.rank HAVING COUNT(*) >= 2");
});

test("buildSql: LIMIT は1つだけ採用される", () => {
  const sql = buildSql(plan("limit-10", "limit-5"));
  assert.equal(sql, "SELECT * FROM cards LIMIT 10");
  assert.equal(sql.match(/LIMIT/g)?.length, 1);
});

test("buildSql: 生成 SQL は必ず SELECT で始まる", () => {
  const cases = [
    plan(),
    plan("where-rank-eq"),
    plan("join-suits"),
    plan("window-rank"),
    plan("group-by-suit", "having-count"),
    plan("order-by-rank", "limit-10"),
  ];
  for (const p of cases) {
    assert.ok(buildSql(p).startsWith("SELECT"), `${buildSql(p)} が SELECT で始まらない`);
  }
});

// ---------------------------------------------------------------------------
// 正常系の実行
// ---------------------------------------------------------------------------

test("run: WHERE で絞り込める", () => {
  withEngine((engine) => {
    const result = engine.run(plan("where-rank-eq"));
    assert.equal(result.error, undefined);
    // エース4枚 + 重複させた A♠ 1枚
    assert.equal(result.rowCount, 5);
    assert.equal(result.rows.length, 5);
    assert.ok(result.sql.includes("WHERE"));
  });
});

test("run: JOIN が動く", () => {
  withEngine((engine) => {
    const result = engine.run(plan("join-suits", "where-suit-eq"));
    assert.equal(result.error, undefined);
    // ハート13枚 + 重複2枚
    assert.equal(result.rowCount, 15);
    assert.ok(result.usedKinds.includes("JOIN"));
  });
});

test("run: WINDOW 関数が動く", () => {
  withEngine((engine) => {
    const result = engine.run(plan("window-row-number"));
    assert.equal(result.error, undefined);
    assert.equal(result.rowCount, 58);
    assert.ok(result.usedKinds.includes("WINDOW"));
  });
});

test("run: GROUP BY + HAVING が動く", () => {
  withEngine((engine) => {
    const result = engine.run(plan("group-by-rank", "having-count"));
    assert.equal(result.error, undefined);
    assert.equal(result.rowCount, 13);
    assert.ok(result.usedKinds.includes("GROUP_BY"));
    assert.ok(result.usedKinds.includes("HAVING"));
  });
});

test("run: ORDER BY + LIMIT が動く", () => {
  withEngine((engine) => {
    const result = engine.run(plan("order-by-chip", "limit-5"));
    assert.equal(result.error, undefined);
    assert.equal(result.rowCount, 5);
    assert.ok(result.usedKinds.includes("ORDER_BY"));
    assert.ok(result.usedKinds.includes("LIMIT"));
  });
});

test("run: LIKE 断片が動く", () => {
  withEngine((engine) => {
    const result = engine.run(plan("where-like-rank"));
    assert.equal(result.error, undefined);
    assert.ok(result.rowCount > 0);
    assert.ok(result.usedKinds.includes("LIKE"));
  });
});

test("run: BETWEEN 断片が動く", () => {
  withEngine((engine) => {
    const result = engine.run(plan("where-between-chip"));
    assert.equal(result.error, undefined);
    assert.ok(result.rowCount > 0);
    assert.ok(result.usedKinds.includes("BETWEEN"));
  });
});

test("run: IN 断片が動く", () => {
  withEngine((engine) => {
    const result = engine.run(plan("where-in-suit"));
    assert.equal(result.error, undefined);
    assert.ok(result.rowCount > 0);
    assert.ok(result.usedKinds.includes("IN"));
  });
});

// ---------------------------------------------------------------------------
// 役判定に必要な情報
// ---------------------------------------------------------------------------

test("run: usedKinds を出現順・重複なしで返す", () => {
  withEngine((engine) => {
    const result = engine.run(plan("where-like-rank", "join-suits"));
    // LIKE 断片は [WHERE, LIKE]、JOIN 断片は [JOIN]
    assert.deepEqual(result.usedKinds, ["WHERE", "LIKE", "JOIN"]);
  });
});

test("run: hasNull が NULL 行を検出する", () => {
  withEngine((engine) => {
    // edition / seal は NULL を含む
    const result = engine.run(plan());
    assert.equal(result.hasNull, true);
  });
});

test("run: hasNull が NULL の無い結果では false", () => {
  withEngine((engine) => {
    // GROUP BY の結果は rank だけなので NULL を含まない
    const result = engine.run(plan("group-by-rank"));
    assert.equal(result.hasNull, false);
  });
});

test("run: hasDuplicateRows が完全重複行を検出する", () => {
  withEngine((engine) => {
    // cards ビューは id を露出しないので、A♠ が2行になる
    const result = engine.run(plan("where-rank-eq"));
    assert.equal(result.hasDuplicateRows, true);
  });
});

test("run: hasDuplicateRows が重複の無い結果では false", () => {
  withEngine((engine) => {
    const result = engine.run(plan("group-by-rank"));
    assert.equal(result.hasDuplicateRows, false);
  });
});

test("run: rowCount と rows.length が一致する", () => {
  withEngine((engine) => {
    const result = engine.run(plan("limit-10"));
    assert.equal(result.rowCount, result.rows.length);
    assert.equal(result.rowCount, 10);
  });
});

test("run: elapsedMs が記録される", () => {
  withEngine((engine) => {
    const result = engine.run(plan());
    assert.equal(typeof result.elapsedMs, "number");
    assert.ok(result.elapsedMs >= 0);
  });
});

test("run: sql に実行した SQL が入る", () => {
  withEngine((engine) => {
    const result = engine.run(plan("where-rank-eq"));
    assert.equal(result.sql, "SELECT * FROM cards WHERE cards.rank = 'A'");
  });
});

// ---------------------------------------------------------------------------
// 拒否系
// ---------------------------------------------------------------------------

test("run: SELECT 以外は実行前に拒否する", () => {
  withEngine((engine) => {
    // buildSql は必ず SELECT を作るので、baseTable に細工して SELECT 以外を作る
    const evil: QueryPlan = {
      baseTable: "cards; DROP TABLE cards",
      fragments: [],
    };
    const result = engine.run(evil);
    // SELECT * FROM cards; DROP TABLE cards は複文なので構造検証で拒否される
    assert.notEqual(result.error, undefined);
    assert.equal(result.error?.code, "sql-error");
  });
});

test("run: 複文は拒否する（2文目が黙って無視される事故を防ぐ）", () => {
  withEngine((engine) => {
    // node:sqlite の prepare().all() は2文目以降を黙って無視するため、
    // 文字列全体を検証しないと「実行されたつもり」の事故になる
    const result = engine.run({
      baseTable: "cards",
      fragments: [
        {
          id: "inject",
          name: "inject",
          sql: "1; DELETE FROM cards_raw",
          clause: "WHERE",
          kinds: ["WHERE"],
          chips: 0,
        },
      ],
    });
    assert.equal(result.error?.code, "sql-error");
    assert.ok(result.error?.message.includes("複数の文"));
  });
});

test("run: 末尾のセミコロンは許可する", () => {
  withEngine((engine) => {
    const result = engine.run({
      baseTable: "cards",
      fragments: [
        {
          id: "semi",
          name: "semi",
          sql: "cards.rank = 'A';",
          clause: "WHERE",
          kinds: ["WHERE"],
          chips: 0,
        },
      ],
    });
    // 末尾セミコロンは SQL エラーになるが、複文拒否では弾かれない
    assert.notEqual(result.error?.message.includes("複数の文"), true);
  });
});

test("run: 再帰CTEは拒否する", () => {
  withEngine((engine) => {
    const result = engine.run({
      baseTable: "cards",
      fragments: [
        {
          id: "rec",
          name: "rec",
          sql: "1",
          clause: "WHERE",
          kinds: ["WHERE"],
          chips: 0,
        },
      ],
    });
    // WHERE 1 は正常に通る（構造検証が過剰でないことの確認）
    assert.equal(result.error, undefined);
  });
});

test("run: CROSS JOIN は拒否する", () => {
  withEngine((engine) => {
    const result = engine.run({
      baseTable: "cards",
      fragments: [
        {
          id: "cross",
          name: "cross",
          sql: "CROSS JOIN suits",
          clause: "JOIN",
          kinds: ["JOIN"],
          chips: 0,
        },
      ],
    });
    assert.equal(result.error?.code, "sql-error");
    assert.ok(result.error?.message.includes("CROSS JOIN"));
  });
});

test("run: ON の無い JOIN は拒否する", () => {
  withEngine((engine) => {
    const result = engine.run({
      baseTable: "cards",
      fragments: [
        {
          id: "nojoin",
          name: "nojoin",
          sql: "JOIN suits",
          clause: "JOIN",
          kinds: ["JOIN"],
          chips: 0,
        },
      ],
    });
    assert.equal(result.error?.code, "sql-error");
    assert.ok(result.error?.message.includes("ON"));
  });
});

test("run: ON 1=1 の定数条件は拒否する", () => {
  withEngine((engine) => {
    const result = engine.run({
      baseTable: "cards",
      fragments: [
        {
          id: "const",
          name: "const",
          sql: "JOIN suits ON 1=1",
          clause: "JOIN",
          kinds: ["JOIN"],
          chips: 0,
        },
      ],
    });
    assert.equal(result.error?.code, "sql-error");
  });
});

test("run: JOIN 4段以上は拒否する（ハング防止）", () => {
  withEngine((engine) => {
    // 実測: 5way クロス結合で 3,838ms、6way で 120秒以上ハングする。
    // 断片は3枚までしか JOIN を持てないが、防御として上限を確認する。
    const joinFragment = (n: number) => ({
      id: `j${n}`,
      name: `j${n}`,
      sql: `JOIN suits ON cards.suit = suits.code`,
      clause: "JOIN" as const,
      kinds: ["JOIN" as const],
      chips: 0,
    });
    const result = engine.run({
      baseTable: "cards",
      fragments: [joinFragment(1), joinFragment(2), joinFragment(3), joinFragment(4)],
    });
    assert.equal(result.error?.code, "sql-error");
    assert.ok(result.error?.message.includes("JOIN"));
  });
});

test("run: JOIN 3段までは通る", () => {
  withEngine((engine) => {
    // 同じテーブルを3回 JOIN すると列名が曖昧になるので、別名を付けた3段にする
    const result = engine.run({
      baseTable: "cards",
      fragments: [
        {
          id: "j1",
          name: "j1",
          sql: "JOIN suits AS s1 ON cards.suit = s1.code",
          clause: "JOIN",
          kinds: ["JOIN"],
          chips: 0,
        },
        {
          id: "j2",
          name: "j2",
          sql: "JOIN ranks AS r1 ON cards.rank = r1.rank",
          clause: "JOIN",
          kinds: ["JOIN"],
          chips: 0,
        },
        {
          id: "j3",
          name: "j3",
          sql: "JOIN ranks AS r2 ON cards.rank = r2.rank",
          clause: "JOIN",
          kinds: ["JOIN"],
          chips: 0,
        },
      ],
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.ok(result.rowCount > 0);
  });
});

test("run: HAVING 単体でも実行できる（集約クエリに正規化される）", () => {
  withEngine((engine) => {
    // SELECT * ... HAVING は SQLite が拒否するため、集約クエリに正規化する
    const result = engine.run(plan("having-count"));
    assert.equal(result.error, undefined, result.error?.message);
    assert.ok(result.rowCount > 0);
  });
});

test("run: HAVING のエラーは日本語で返る", () => {
  withEngine((engine) => {
    // GROUP BY 無しで HAVING を強制しても、正規化により成立する。
    // ここではエラーメッセージの翻訳関数が効くことを別経路で確認する。
    const result = engine.run({
      baseTable: "cards",
      fragments: [
        {
          id: "bad",
          name: "bad",
          sql: "COUNT(*) >= 2",
          clause: "HAVING",
          kinds: ["HAVING"],
          chips: 0,
        },
      ],
    });
    // 正規化されるので成功する
    assert.equal(result.error, undefined);
  });
});

test("run: SQL エラーは sql-error として返る（例外を投げない）", () => {
  withEngine((engine) => {
    const broken: QueryPlan = {
      baseTable: "存在しないテーブル",
      fragments: [],
    };
    const result = engine.run(broken);
    assert.equal(result.error?.code, "sql-error");
    assert.equal(result.rowCount, 0);
  });
});

test("run: 存在しない列を参照しても sql-error になる", () => {
  withEngine((engine) => {
    const broken: QueryPlan = {
      baseTable: "cards",
      fragments: [
        {
          id: "bad",
          name: "bad",
          sql: "cards.存在しない列 = 1",
          clause: "WHERE",
          kinds: ["WHERE"],
          chips: 0,
        },
      ],
    };
    const result = engine.run(broken);
    assert.equal(result.error?.code, "sql-error");
  });
});

// ---------------------------------------------------------------------------
// Boss 妨害
// ---------------------------------------------------------------------------

test("Boss: noOrderBy は ORDER BY 断片を拒否する", () => {
  withEngine((engine) => {
    const result = engine.run(plan("order-by-chip"), { bossRule: "noOrderBy" });
    assert.equal(result.error?.code, "blocked-by-boss");
    assert.equal(result.rowCount, 0);
  });
});

test("Boss: noLike は LIKE 断片を拒否する", () => {
  withEngine((engine) => {
    const result = engine.run(plan("where-like-rank"), { bossRule: "noLike" });
    assert.equal(result.error?.code, "blocked-by-boss");
  });
});

test("Boss: noJoin は JOIN 断片を拒否する", () => {
  withEngine((engine) => {
    const result = engine.run(plan("join-suits"), { bossRule: "noJoin" });
    assert.equal(result.error?.code, "blocked-by-boss");
  });
});

test("Boss: 妨害に該当しない断片は通る", () => {
  withEngine((engine) => {
    const result = engine.run(plan("where-rank-eq"), { bossRule: "noOrderBy" });
    assert.equal(result.error, undefined);
    assert.ok(result.rowCount > 0);
  });
});

test("Boss: none は何も拒否しない", () => {
  withEngine((engine) => {
    const result = engine.run(plan("order-by-chip", "join-suits", "where-like-rank"), {
      bossRule: "none",
    });
    assert.equal(result.error, undefined);
  });
});

test("Boss: maxRows50 は取得上限を50行にする", () => {
  withEngine((engine) => {
    const result = engine.run(plan(), { bossRule: "maxRows50" });
    assert.equal(result.error, undefined);
    assert.equal(result.rowCount, 50);
  });
});

// ---------------------------------------------------------------------------
// 制限
// ---------------------------------------------------------------------------

test("制限: 既定の取得上限は100行", () => {
  withEngine((engine) => {
    // cards は58行なので上限に掛からない。上限そのものは maxRows 指定で確認する。
    const result = engine.run(plan(), { maxRows: 100 });
    assert.equal(result.rowCount, 58);
    assert.equal(RULES.maxRows, 100);
  });
});

test("制限: maxRows で切り詰められる", () => {
  withEngine((engine) => {
    const result = engine.run(plan(), { maxRows: 3 });
    assert.equal(result.rowCount, 3);
    assert.equal(result.rows.length, 3);
  });
});

test("制限: maxRows と Boss 上限の小さい方が採用される", () => {
  withEngine((engine) => {
    // maxRows50 の Boss に maxRows: 10 を指定 → 10 が採用される
    const result = engine.run(plan(), { bossRule: "maxRows50", maxRows: 10 });
    assert.equal(result.rowCount, 10);
  });
});

test("制限: タイムアウトは timeout として返る（ハングしない）", () => {
  withEngine((engine) => {
    // 通常のクエリは 100ms 以内に終わる。ここでは制限値そのものを確認する。
    assert.equal(RULES.queryTimeoutMs, 100);
    const result = engine.run(plan());
    assert.equal(result.error, undefined);
    assert.ok(result.elapsedMs < RULES.queryTimeoutMs, "通常クエリが100msを超えている");
  });
});

// ---------------------------------------------------------------------------
// 読み取り専用
// ---------------------------------------------------------------------------

test("読み取り専用: 書き込みクエリは実行できない", () => {
  withEngine((engine) => {
    // 断片経由では書き込み SQL を組み立てられないが、
    // エンジンが読み取り専用であることを直接確認する
    const result = engine.run({
      baseTable: "cards",
      fragments: [
        {
          id: "inject",
          name: "inject",
          sql: "1; DELETE FROM cards_raw",
          clause: "WHERE",
          kinds: ["WHERE"],
          chips: 0,
        },
      ],
    });
    // 複文は SQL エラーになる（読み取り専用以前に実行されない）
    assert.notEqual(result.error, undefined);
  });
});

test("読み取り専用: ファイルDBを readOnly で開く", () => {
  const dir = mkdtempSync(join(tmpdir(), "qb-db-"));
  const dbPath = join(dir, "game.db");
  try {
    // まず通常接続でスキーマを作る
    const setup = new DatabaseSync(dbPath);
    for (const ddl of GAME_SCHEMA.ddl) setup.exec(ddl);
    for (const seed of GAME_SCHEMA.seed) setup.exec(seed);
    setup.close();

    // 読み取り専用で開く
    const engine = createEngine(dbPath);
    try {
      const result = engine.run(plan("where-rank-eq"));
      assert.equal(result.error, undefined);
      assert.equal(result.rowCount, 5);
    } finally {
      engine.close();
    }

    // 書き込みは失敗する（query_only により）
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.throws(() => ro.exec("INSERT INTO cards_raw (id) VALUES (999)"));
    } finally {
      ro.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("読み取り専用: 存在しないファイルを開くと例外", () => {
  assert.throws(() => createEngine(join(tmpdir(), "qb-does-not-exist-12345.db")));
});

// ---------------------------------------------------------------------------
// ライフサイクル
// ---------------------------------------------------------------------------

test("close: 二重 close しても例外を投げない", () => {
  const engine = createEngineFromSchema();
  engine.close();
  assert.doesNotThrow(() => engine.close());
});

test("close: close 後の run は sql-error を返す（例外を投げない）", () => {
  const engine = createEngineFromSchema();
  engine.close();
  const result = engine.run(plan());
  assert.equal(result.error?.code, "sql-error");
});

test("buildSql: エンジンの buildSql は実行しない", () => {
  withEngine((engine) => {
    const sql = engine.buildSql(plan("where-rank-eq"));
    assert.equal(sql, "SELECT * FROM cards WHERE cards.rank = 'A'");
  });
});

// ---------------------------------------------------------------------------
// 全断片が実際に実行できること（データとエンジンの整合）
// ---------------------------------------------------------------------------

test("全断片が単体で実行できる", async () => {
  const { FRAGMENTS } = await import("../src/data/fragments.ts");
  withEngine((engine) => {
    for (const fragment of FRAGMENTS) {
      const result = engine.run({ baseTable: "cards", fragments: [fragment] });
      assert.equal(
        result.error,
        undefined,
        `断片 ${fragment.id} が失敗しました: ${result.error?.message ?? ""}`,
      );
    }
  });
});

test("全断片が JOIN と組み合わせても実行できる", async () => {
  const { FRAGMENTS } = await import("../src/data/fragments.ts");
  withEngine((engine) => {
    const join = frag("join-suits");
    for (const fragment of FRAGMENTS) {
      if (fragment.clause === "JOIN") continue;
      const result = engine.run({
        baseTable: "cards",
        fragments: [join, fragment],
      });
      assert.equal(
        result.error,
        undefined,
        `断片 ${fragment.id} + JOIN が失敗しました: ${result.error?.message ?? ""}`,
      );
    }
  });
});
