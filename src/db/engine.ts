/**
 * 読み取り専用クエリ実行基盤。
 *
 * 仕様書（docs/SPEC.md「共通前提」）に従い、次を保証する:
 *   1. DB は読み取り専用で開く（書き込みは必ず失敗する）
 *   2. 実行するのは組み立て済みの SELECT のみ
 *   3. 1クエリ 100ms / 取得上限 100行の制限を適用する
 *   4. 役判定に必要な情報（使用句・返却行数・NULL有無・重複有無）を返す
 *
 * ## タイムアウトについて
 *
 * `node:sqlite` には実行中断（interrupt）API が無く、同期 API しかないため、
 * 「実行中に割り込んで止める」ことはできない。代わりに二段構えで守る:
 *
 *   - 実行前: SQL の構造を検証し、暴走しうる形（再帰CTE・ON の無い JOIN）を拒否する
 *   - 実行後: 経過時間を測り、上限を超えていたら timeout として扱う
 *
 * プレイヤーが使える断片は data/fragments.ts の定義済み集合に限られ、
 * 任意の SQL を書くことはできない。そのため構造検証で実用上は十分に守れる。
 */

import { DatabaseSync } from "node:sqlite";
import type {
  BossRuleId,
  FragmentKind,
  QueryEngine,
  QueryError,
  QueryPlan,
  QueryResult,
  Row,
  RunQueryOptions,
} from "../types.ts";
import { RULES } from "../types.ts";
import { GAME_SCHEMA } from "../data/schema.ts";
import { buildSql } from "./build.ts";

// ---------------------------------------------------------------------------
// 構造検証
// ---------------------------------------------------------------------------

/**
 * 暴走しうる SQL の形。実行前に拒否する。
 *
 * `node:sqlite` は同期APIしかなく実行中断ができないため、**ハングは実行前に防ぐしかない**。
 * 実測（Node v26.13.0 / 本スキーマ）:
 *   - 4way クロス結合: 48ms
 *   - 5way クロス結合: 3,838ms
 *   - 6way クロス結合: 120秒以上ハング
 *   - 等値結合6段 + WINDOW + ORDER BY: 20,139ms
 * この実測から、JOIN は 3 段までに制限する。
 */
const MAX_JOINS = 3;

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
function isSelect(sql: string): boolean {
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
function hasMultipleStatements(sql: string): boolean {
  const withoutTrailing = sql.replace(/[\s;]+$/, "");
  return withoutTrailing.includes(";");
}

/** JOIN の段数を数える。 */
function countJoins(sql: string): number {
  return (sql.match(/\bJOIN\b/gi) ?? []).length;
}

/** 構造検証。問題があれば理由を返す。 */
function validateStructure(sql: string): string | undefined {
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
function friendlySqlError(message: string): string {
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
function findBossViolation(
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
function bossRowCap(bossRule: BossRuleId | undefined): number | undefined {
  return bossRule === "maxRows50" ? 50 : undefined;
}

// ---------------------------------------------------------------------------
// 結果の集計
// ---------------------------------------------------------------------------

/** 行に NULL が1つでも含まれるか。 */
function hasNullValue(rows: Row[]): boolean {
  return rows.some((row) => Object.values(row).some((value) => value === null));
}

/** 完全重複行が含まれるか（全列の値が一致する行が2つ以上あるか）。 */
function hasDuplicateRow(rows: Row[]): boolean {
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
function collectUsedKinds(fragments: QueryPlan["fragments"]): FragmentKind[] {
  const used: FragmentKind[] = [];
  for (const fragment of fragments) {
    for (const kind of fragment.kinds) {
      if (!used.includes(kind)) used.push(kind);
    }
  }
  return used;
}

/** 失敗結果を組み立てる。 */
function failure(sql: string, error: QueryError, elapsedMs: number): QueryResult {
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

// ---------------------------------------------------------------------------
// エンジン
// ---------------------------------------------------------------------------

/** エンジンの内部実装。DB の開き方だけが違う2つのファクトリで共有する。 */
function makeEngine(db: DatabaseSync): QueryEngine {
  let closed = false;

  const run = (plan: QueryPlan, options: RunQueryOptions = {}): QueryResult => {
    const startedAt = performance.now();
    const elapsed = (): number => performance.now() - startedAt;

    if (closed) {
      return failure("", { code: "sql-error", message: "DB はすでに閉じられています。" }, elapsed());
    }

    // --- 1. SQL 組み立て ---
    let sql: string;
    try {
      sql = buildSql(plan);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return failure("", { code: "sql-error", message: `SQL を組み立てられませんでした: ${message}` }, elapsed());
    }

    // --- 2. SELECT 以外を拒否 ---
    if (!isSelect(sql)) {
      return failure(
        sql,
        { code: "not-select", message: "実行できるのは SELECT のみです。" },
        elapsed(),
      );
    }

    // --- 3. 構造検証（暴走しうる形を拒否） ---
    const structural = validateStructure(sql);
    if (structural) {
      return failure(sql, { code: "sql-error", message: structural }, elapsed());
    }

    // --- 4. Boss 妨害（実行前に拒否） ---
    const violation = findBossViolation(options.bossRule, plan.fragments);
    if (violation) {
      return failure(
        sql,
        {
          code: "blocked-by-boss",
          message: `このブラインドでは ${violation} を使えません。`,
        },
        elapsed(),
      );
    }

    // --- 5. 取得上限を決める ---
    // 優先度: Boss の上限 < 呼び出し側の指定 < 既定
    const caps = [RULES.maxRows, options.maxRows, bossRowCap(options.bossRule)].filter(
      (cap): cap is number => typeof cap === "number",
    );
    const maxRows = Math.min(...caps);

    // --- 6. 実行 ---
    try {
      const statement = db.prepare(sql);
      const raw = statement.all() as Row[];
      const elapsedMs = elapsed();

      // 実行後のタイムアウト判定（node:sqlite に中断APIが無いため事後判定）
      if (elapsedMs > RULES.queryTimeoutMs) {
        return failure(
          sql,
          {
            code: "timeout",
            message: `クエリが制限時間（${RULES.queryTimeoutMs}ms）を超えました（${Math.round(elapsedMs)}ms）。`,
          },
          elapsedMs,
        );
      }

      // 取得上限で切り詰める（SQL 側の LIMIT と二重に掛けても結果は同じ）
      const rows = raw.length > maxRows ? raw.slice(0, maxRows) : raw;

      return {
        sql,
        rows,
        rowCount: rows.length,
        hasNull: hasNullValue(rows),
        hasDuplicateRows: hasDuplicateRow(rows),
        usedKinds: collectUsedKinds(plan.fragments),
        elapsedMs,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return failure(sql, { code: "sql-error", message: friendlySqlError(message) }, elapsed());
    }
  };

  const buildSqlOnly = (plan: QueryPlan): string => buildSql(plan);

  const close = (): void => {
    if (closed) return;
    closed = true;
    db.close();
  };

  return { run, buildSql: buildSqlOnly, close };
}

/**
 * 既存の SQLite ファイルを読み取り専用で開く。
 *
 * `readOnly: true` に加えて `PRAGMA query_only = ON` も設定する（二重の防御）。
 * ファイルが存在しない場合は例外を投げる（呼び出し側で扱う）。
 */
export function createEngine(dbPath: string): QueryEngine {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  return makeEngine(db);
}

/**
 * ゲーム用スキーマを流し込んだインメモリDBでエンジンを作る。
 *
 * テストと CLI の既定で使う。DDL と seed を流し込んだ後に `query_only` を
 * 有効化するので、プレイヤーのクエリからは書き込みできない。
 */
export function createEngineFromSchema(): QueryEngine {
  const db = new DatabaseSync(":memory:");
  for (const ddl of GAME_SCHEMA.ddl) db.exec(ddl);
  for (const seed of GAME_SCHEMA.seed) db.exec(seed);
  // 初期化が終わってから読み取り専用に固定する
  db.exec("PRAGMA query_only = ON");
  return makeEngine(db);
}
