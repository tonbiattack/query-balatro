/**
 * クエリ実行の共通検証ロジック。
 *
 * Node 版（`engine.ts` / `node:sqlite`）とブラウザ版（`browser-engine.ts` / `sql.js`）は
 * 「SQLite をどう動かすか」だけが違う。実行前の検証・Boss妨害の判定・
 * 結果の集計は**完全に同じ規則**でなければならない。
 *
 * そのため、それらをここに集約して両方から使う。
 * 片方だけ規則が変わって「Node では通るがブラウザでは弾かれる」という
 * 事故を構造的に防ぐのが目的。
 */

import type {
  BossRuleId,
  FragmentKind,
  QueryError,
  QueryPlan,
  QueryResult,
  Row,
} from "../types.ts";

// ---------------------------------------------------------------------------
// 構造検証
// ---------------------------------------------------------------------------

/**
 * 暴走しうる SQL の形。実行前に拒否する。
 *
 * `node:sqlite` も `sql.js` も同期APIしかなく実行中断ができないため、
 * **ハングは実行前に防ぐしかない**。
 * 実測（Node v26.13.0 / 本スキーマ）:
 *   - 4way クロス結合: 48ms
 *   - 5way クロス結合: 3,838ms
 *   - 6way クロス結合: 120秒以上ハング
 *   - 等値結合6段 + WINDOW + ORDER BY: 20,139ms
 * この実測から、JOIN は 3 段までに制限する。
 */
export const MAX_JOINS = 3;

/** 暴走しうる SQL の形。実行前に拒否する。 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bWITH\s+RECURSIVE\b/i, reason: "再帰CTEは実行できません。" },
  { pattern: /\bCROSS\s+JOIN\b/i, reason: "CROSS JOIN は実行できません。" },
  // ON も USING も無い JOIN は直積になるため拒否する
  {
    pattern: /\bJOIN\s+[A-Za-z_][\w]*\s*(?!ON\b|USING\b)(?=JOIN\b|WHERE\b|GROUP\b|ORDER\b|LIMIT\b|$)/i,
    reason: "JOIN には ON か USING が必要です。",
  },
  // ON 1=1 / ON true のような定数条件はクロス結合と等価
  { pattern: /\bON\s+(?:1\s*=\s*1|true|1)\b/i, reason: "ON の定数条件（常に真）は実行できません。" },
  // FROM a, b 形式のカンマ結合は直積になりやすい
  { pattern: /\bFROM\s+[A-Za-z_][\w]*\s*,/i, reason: "FROM のカンマ結合は実行できません。" },
];

/** SQL が SELECT で始まるか（先頭のコメント・空白を許容）。 */
export function isSelect(sql: string): boolean {
  const stripped = sql
    .replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/g, "")
    .trimStart();
  return /^SELECT\b/i.test(stripped);
}

/**
 * 複文を拒否する。
 *
 * `node:sqlite` の `prepare().all()` は2文目以降を**黙って無視する**ため、
 * 一見安全に見えるが、先頭が非SELECTなら実行されてしまう。
 * 事故を防ぐため、末尾のセミコロン以外の `;` を拒否する。
 */
export function hasMultipleStatements(sql: string): boolean {
  const withoutTrailing = sql.replace(/[\s;]+$/, "");
  return withoutTrailing.includes(";");
}

/** JOIN の段数を数える。 */
export function countJoins(sql: string): number {
  return (sql.match(/\bJOIN\b/gi) ?? []).length;
}

/** 構造検証。問題があれば理由を返す。 */
export function validateStructure(sql: string): string | undefined {
  if (hasMultipleStatements(sql)) {
    return "1つのクエリに複数の文を含めることはできません。";
  }
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(sql)) return reason;
  }
  const joins = countJoins(sql);
  if (joins > MAX_JOINS) {
    return `JOIN は最大${MAX_JOINS}段までです（${joins}段あります）。`;
  }
  return undefined;
}

/**
 * SQLite のエラーメッセージをプレイヤー向けの日本語に変換する。
 * 生の英語エラーをそのまま出さない（何が悪いか分からないため）。
 */
export function friendlySqlError(message: string): string {
  if (/HAVING clause on a non-aggregate query/i.test(message)) {
    return "HAVING は GROUP BY と一緒に使ってください。";
  }
  if (/no such column/i.test(message)) {
    return `存在しない列を参照しています（${message}）。`;
  }
  if (/no such table/i.test(message)) {
    return `存在しないテーブルを参照しています（${message}）。`;
  }
  if (/misuse of aggregate/i.test(message)) {
    return "集約関数の使い方が正しくありません。GROUP BY と組み合わせてください。";
  }
  if (/syntax error/i.test(message)) {
    return `SQL の構文が正しくありません（${message}）。`;
  }
  return message;
}

// ---------------------------------------------------------------------------
// Boss 妨害
// ---------------------------------------------------------------------------

/** Boss ルールが禁止する kind。 */
const BOSS_FORBIDDEN_KINDS: Partial<Record<BossRuleId, FragmentKind>> = {
  noOrderBy: "ORDER_BY",
  noLike: "LIKE",
  noJoin: "JOIN",
};

/** Boss ルールが禁止する kind を含んでいれば、その kind を返す。 */
export function findBossViolation(
  bossRule: BossRuleId | undefined,
  fragments: QueryPlan["fragments"],
): FragmentKind | undefined {
  if (!bossRule) return undefined;
  const forbidden = BOSS_FORBIDDEN_KINDS[bossRule];
  if (!forbidden) return undefined;
  for (const fragment of fragments) {
    if (fragment.kinds.includes(forbidden)) return forbidden;
  }
  return undefined;
}

/** Boss ルールごとの取得上限の上限値。 */
export function bossRowCap(bossRule: BossRuleId | undefined): number | undefined {
  return bossRule === "maxRows50" ? 50 : undefined;
}

// ---------------------------------------------------------------------------
// 結果の集計
// ---------------------------------------------------------------------------

/** 行に NULL が1つでも含まれるか。 */
export function hasNullValue(rows: Row[]): boolean {
  return rows.some((row) => Object.values(row).some((value) => value === null));
}

/** 完全重複行が含まれるか（全列の値が一致する行が2つ以上あるか）。 */
export function hasDuplicateRow(rows: Row[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const keys = Object.keys(row).sort();
    const key = JSON.stringify(keys.map((k) => [k, row[k]]));
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/** 断片が使った kind を出現順・重複なしで集約する。 */
export function collectUsedKinds(fragments: QueryPlan["fragments"]): FragmentKind[] {
  const used: FragmentKind[] = [];
  for (const fragment of fragments) {
    for (const kind of fragment.kinds) {
      if (!used.includes(kind)) used.push(kind);
    }
  }
  return used;
}

/** 失敗結果を組み立てる。 */
export function failure(sql: string, error: QueryError, elapsedMs: number): QueryResult {
  return {
    sql,
    rows: [],
    rowCount: 0,
    hasNull: false,
    hasDuplicateRows: false,
    usedKinds: [],
    elapsedMs,
    error,
  };
}
