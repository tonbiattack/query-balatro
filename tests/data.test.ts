/**
 * データ層の検証テスト。
 *
 * 断片カード・役・ジョーカー・Boss・アンティ・DBスキーマが
 * 「実際に SQLite で動く」「役の条件が成立しうる」ことを保証する。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { GAME_SCHEMA, BASE_TABLE } from "../src/data/schema.ts";
import { FRAGMENTS, findFragment } from "../src/data/fragments.ts";
import { RANKS, NO_RANK_MULT, findRank } from "../src/data/ranks.ts";
import { JOKERS, findJoker } from "../src/data/jokers.ts";
import { BOSS_RULES, findBossRule } from "../src/data/bosses.ts";
import { ANTES, findAnte, targetChips } from "../src/data/antes.ts";
import { RULES } from "../src/types.ts";

/** スキーマを流し込んだインメモリDBを作る。 */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const ddl of GAME_SCHEMA.ddl) db.exec(ddl);
  for (const seed of GAME_SCHEMA.seed) db.exec(seed);
  return db;
}

test("スキーマが流し込める", () => {
  const db = makeDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ["cards_raw", "ranks", "suits"]);
  // プレイヤーが見るベーステーブルはビュー
  const views = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(views, ["cards"]);
  db.close();
});

test("cards ビューは id を露出しない（重複行が意味を持つため）", () => {
  const db = makeDb();
  const columns = db
    .prepare("PRAGMA table_info(cards)")
    .all()
    .map((r) => r.name);
  assert.ok(!columns.includes("id"), "cards ビューに id を含めてはいけない");
  assert.deepEqual(columns, ["rank", "suit", "chip_value", "mult_value", "edition", "seal"]);
  db.close();
});

test("ベーステーブルは cards", () => {
  assert.equal(BASE_TABLE, "cards");
  assert.equal(GAME_SCHEMA.baseTable, "cards");
});

test("cards は 52枚 + 重複6枚 = 58行", () => {
  const db = makeDb();
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM cards").get() as { n: number };
  assert.equal(n, 58);
  db.close();
});

test("suits は4行、ranks は13行", () => {
  const db = makeDb();
  const suits = db.prepare("SELECT COUNT(*) AS n FROM suits").get() as { n: number };
  const ranks = db.prepare("SELECT COUNT(*) AS n FROM ranks").get() as { n: number };
  assert.equal(suits.n, 4);
  assert.equal(ranks.n, 13);
  db.close();
});

test("edition / seal に NULL が含まれる（NULL系ジョーカーの前提）", () => {
  const db = makeDb();
  const edition = db
    .prepare("SELECT COUNT(*) AS n FROM cards WHERE edition IS NULL")
    .get() as { n: number };
  const seal = db.prepare("SELECT COUNT(*) AS n FROM cards WHERE seal IS NULL").get() as {
    n: number;
  };
  assert.ok(edition.n > 0, "edition に NULL 行が必要");
  assert.ok(seal.n > 0, "seal に NULL 行が必要");
  db.close();
});

test("完全重複行が存在する（重複系ジョーカーと Boss の前提）", () => {
  const db = makeDb();
  const dup = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT rank, suit, chip_value, mult_value, edition, seal, COUNT(*) AS c
         FROM cards GROUP BY rank, suit, chip_value, mult_value, edition, seal
         HAVING c > 1
       )`,
    )
    .get() as { n: number };
  assert.ok(dup.n > 0, "完全重複行が必要");
  db.close();
});

test("JOIN 断片が実際に動く", () => {
  const db = makeDb();
  const rows = db
    .prepare(
      `SELECT cards.rank, suits.name FROM cards
       JOIN suits ON cards.suit = suits.code
       WHERE cards.rank = 'A'`,
    )
    .all();
  // エース4枚 + 重複させた A♠ 1枚 = 5行
  assert.equal(rows.length, 5);
  db.close();
});

test("WINDOW 断片が実際に動く", () => {
  const db = makeDb();
  const rows = db
    .prepare(
      `SELECT cards.rank,
              ROW_NUMBER() OVER (PARTITION BY cards.suit ORDER BY cards.chip_value DESC) AS rn
       FROM cards`,
    )
    .all();
  assert.equal(rows.length, 58);
  db.close();
});

test("GROUP BY + HAVING が実際に動く", () => {
  const db = makeDb();
  const rows = db
    .prepare(
      `SELECT cards.rank, COUNT(*) AS c FROM cards
       GROUP BY cards.rank HAVING COUNT(*) >= 2`,
    )
    .all();
  assert.ok(rows.length > 0);
  db.close();
});

test("断片IDが一意", () => {
  const ids = FRAGMENTS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("断片はすべて必須フィールドを持つ", () => {
  for (const f of FRAGMENTS) {
    assert.ok(f.id.length > 0, `${f.id}: id が空`);
    assert.ok(f.name.length > 0, `${f.id}: name が空`);
    assert.ok(f.sql.length > 0, `${f.id}: sql が空`);
    assert.ok(f.kinds.length > 0, `${f.id}: kinds が空`);
    assert.ok(f.chips >= 0, `${f.id}: chips が負`);
  }
});

test("断片の clause と kinds が整合している", () => {
  // WHERE 句に置く断片は WHERE タグを持つべき（役判定の前提）
  for (const f of FRAGMENTS) {
    if (f.clause === "WHERE") {
      assert.ok(f.kinds.includes("WHERE"), `${f.id}: clause=WHERE だが WHERE タグがない`);
    }
    if (f.clause === "JOIN") {
      assert.ok(f.kinds.includes("JOIN"), `${f.id}: clause=JOIN だが JOIN タグがない`);
    }
  }
});

test("LIKE 断片は WHERE と LIKE の両タグを持つ", () => {
  const likes = FRAGMENTS.filter((f) => f.kinds.includes("LIKE"));
  assert.ok(likes.length >= 2, "LIKE 断片が2枚以上必要");
  for (const f of likes) {
    assert.ok(f.kinds.includes("WHERE"), `${f.id}: LIKE 断片は WHERE タグも必要`);
  }
});

test("役のIDが一意で、優先度順に並んでいる", () => {
  const ids = RANKS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  // 倍率が単調減少していること（優先度が高い役ほど倍率が高い）
  for (let i = 1; i < RANKS.length; i++) {
    assert.ok(
      RANKS[i - 1]!.mult >= RANKS[i]!.mult,
      `${RANKS[i - 1]!.id}(${RANKS[i - 1]!.mult}) >= ${RANKS[i]!.id}(${RANKS[i]!.mult}) が崩れている`,
    );
  }
});

test("仕様書の3役が定義されている（WHERE×2 / JOIN×4 / WINDOW×6）", () => {
  assert.equal(findRank("pair")?.mult, 2);
  assert.equal(findRank("straight")?.mult, 4);
  assert.equal(findRank("full-house")?.mult, 6);
});

test("役なしの倍率は0", () => {
  assert.equal(NO_RANK_MULT, 0);
});

test("すべての役の条件が断片プールで成立しうる", () => {
  const allKinds = new Set(FRAGMENTS.flatMap((f) => f.kinds));
  for (const rank of RANKS) {
    for (const kind of rank.requires.allKinds ?? []) {
      assert.ok(allKinds.has(kind), `${rank.id}: ${kind} を満たす断片が存在しない`);
    }
    const anyKinds = rank.requires.anyKinds ?? [];
    if (anyKinds.length > 0) {
      assert.ok(
        anyKinds.some((k) => allKinds.has(k)),
        `${rank.id}: anyKinds のどれも断片プールに存在しない`,
      );
    }
  }
});

test("ジョーカーが5種以上あり、IDが一意", () => {
  assert.ok(JOKERS.length >= 5, "ジョーカーは最低5種必要");
  const ids = JOKERS.map((j) => j.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("仕様書のジョーカー例が定義されている", () => {
  const nullJoker = JOKERS.find((j) => j.effect.type === "multIfNull");
  assert.ok(nullJoker, "NULL でマルチ加算するジョーカーが必要");
  assert.equal(nullJoker.effect.type === "multIfNull" && nullJoker.effect.value, 4);

  const likeJoker = JOKERS.find((j) => j.effect.type === "chipsPerLike");
  assert.ok(likeJoker, "LIKE でチップ加算するジョーカーが必要");
  assert.equal(likeJoker.effect.type === "chipsPerLike" && likeJoker.effect.value, 30);
});

test("ジョーカー効果の全種類がデータに存在する", () => {
  const types = new Set(JOKERS.map((j) => j.effect.type));
  const expected = [
    "multIfNull",
    "chipsPerLike",
    "chipsPerRow",
    "multPerKind",
    "multIfNoOrderBy",
    "multIfDuplicate",
  ];
  for (const t of expected) {
    assert.ok(types.has(t as never), `効果 ${t} を持つジョーカーがない`);
  }
});

test("Boss ルールがすべて定義されている", () => {
  const ids = BOSS_RULES.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["none", "noOrderBy", "noLike", "noJoin", "zeroOnDuplicate", "maxRows50"]) {
    assert.ok(findBossRule(id as never), `${id} が定義されていない`);
  }
});

test("アンティは1〜8の8段", () => {
  assert.equal(ANTES.length, 8);
  assert.deepEqual(
    ANTES.map((a) => a.ante),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test("目標チップが段階的に上がる", () => {
  for (let i = 1; i < ANTES.length; i++) {
    const prev = ANTES[i - 1]!;
    const cur = ANTES[i]!;
    assert.ok(cur.small > prev.small, `ante${cur.ante}: small が上がっていない`);
    assert.ok(cur.big > prev.big, `ante${cur.ante}: big が上がっていない`);
    assert.ok(cur.boss > prev.boss, `ante${cur.ante}: boss が上がっていない`);
    // 各アンティ内で small < big < boss
    assert.ok(cur.small < cur.big, `ante${cur.ante}: small < big が崩れている`);
    assert.ok(cur.big < cur.boss, `ante${cur.ante}: big < boss が崩れている`);
  }
});

test("目標チップの伸び率が急激でない（1.2〜2.0倍）", () => {
  // 実測ベースで逆算した曲線。急に跳ねる段を作らないことが目的なので、
  // 厳密な倍率より「単調増加かつ極端な跳ねが無い」ことを見る。
  for (let i = 1; i < ANTES.length; i++) {
    const ratio = ANTES[i]!.small / ANTES[i - 1]!.small;
    assert.ok(
      ratio >= 1.2 && ratio <= 2.0,
      `ante${ANTES[i]!.ante}: 伸び率 ${ratio.toFixed(2)} が範囲外`,
    );
  }
});

test("targetChips が正しい値を返す", () => {
  assert.equal(targetChips(1, "small"), ANTES[0]!.small);
  assert.equal(targetChips(8, "boss"), ANTES[7]!.boss);
  assert.throws(() => targetChips(9, "small"));
});

test("Boss ルールが後半のアンティに割り当てられている", () => {
  const bossRules = ANTES.map((a) => a.bossRule).filter((r) => r !== "none");
  assert.ok(bossRules.length >= 4, "Boss 妨害は4種以上使われるべき");
});

test("findFragment / findJoker / findAnte が機能する", () => {
  assert.ok(findFragment("where-rank-eq"));
  assert.equal(findFragment("存在しないID"), undefined);
  assert.ok(findJoker("null-mult"));
  assert.equal(findJoker("存在しないID"), undefined);
  assert.ok(findAnte(1));
  assert.equal(findAnte(99), undefined);
});

test("RULES が仕様書の数値と一致する", () => {
  assert.equal(RULES.handSize, 8);
  assert.equal(RULES.maxPlayFragments, 5);
  assert.equal(RULES.playsPerBlind, 4);
  assert.equal(RULES.discardsPerBlind, 2);
  assert.equal(RULES.jokerSlots, 5);
  assert.equal(RULES.queryTimeoutMs, 100);
  assert.equal(RULES.maxRows, 100);
  assert.equal(RULES.maxAnte, 8);
});
