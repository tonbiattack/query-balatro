/**
 * ブラウザ互換のクエリ実行基盤（sql.js 版）。
 *
 * ## なぜ sql.js なのか
 *
 * Node 版（`src/db/engine.ts`）は `node:sqlite` を使うが、これはブラウザで動かない。
 * 一方 `sql.js` は SQLite を WebAssembly にコンパイルしたもので、
 * ブラウザでも Node でも同じ SQLite エンジンとして動く。
 *
 * 実測で確認したこと:
 *   - 全23断片のクエリで Node 版と行数が完全一致する
 *   - 行の形（列名 → 値、NULL は null）も一致する
 *
 * ## 責務の分離
 *
 * SQL の組み立て（`buildSql`）と構造検証・Boss妨害の判定は
 * Node 版と共通のロジックを使う。このファイルが担うのは
 * 「SQLite をどう動かすか」だけなので、差分を小さく保てる。
 *
 * ## 初期化が非同期な理由
 *
 * sql.js は WebAssembly の読み込みが必要なため `initSqlJs()` が Promise を返す。
 * そのため `createBrowserEngine()` も非同期になる。
 * ゲーム開始時に1度だけ await すればよい。
 */

import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
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
import { buildSql } from "../db/build.ts";
import {
  bossRowCap,
  collectUsedKinds,
  findBossViolation,
  friendlySqlError,
  hasDuplicateRow,
  hasNullValue,
  isSelect,
  validateStructure,
} from "../db/validate.ts";

/** sql.js のモジュール（初期化は1度だけ）。 */
let sqlJsPromise: Promise<SqlJsStatic> | undefined;

/**
 * sql.js を初期化する。2回目以降は同じ Promise を返す。
 *
 * `locateFile` で wasm の場所を指定できる。GitHub Pages のように
 * サブパスに配信する場合は、呼び出し側で `wasmUrl` を渡す。
 */
export function loadSqlJs(wasmUrl?: string): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs(
      wasmUrl === undefined
        ? undefined
        : {
            locateFile: (file: string) => (file.endsWith(".wasm") ? wasmUrl : file),
          },
    );
  }
  return sqlJsPromise;
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

/** 1つの sql.js Database を QueryEngine として扱えるようにする。 */
function makeEngine(db: Database): QueryEngine {
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
      return failure(
        "",
        { code: "sql-error", message: `SQL を組み立てられませんでした: ${message}` },
        elapsed(),
      );
    }

    // --- 2. SELECT 以外を拒否 ---
    if (!isSelect(sql)) {
      return failure(sql, { code: "not-select", message: "実行できるのは SELECT のみです。" }, elapsed());
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
        { code: "blocked-by-boss", message: `このブラインドでは ${violation} を使えません。` },
        elapsed(),
      );
    }

    // --- 5. 取得上限を決める ---
    const caps = [RULES.maxRows, options.maxRows, bossRowCap(options.bossRule)].filter(
      (cap): cap is number => typeof cap === "number",
    );
    const maxRows = Math.min(...caps);

    // --- 6. 実行 ---
    try {
      const statement = db.prepare(sql);
      const rows: Row[] = [];
      try {
        while (statement.step()) {
          rows.push(statement.getAsObject() as Row);
        }
      } finally {
        statement.free();
      }
      const elapsedMs = elapsed();

      // 実行後のタイムアウト判定（sql.js にも中断APIが無いため事後判定）
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

      const limited = rows.length > maxRows ? rows.slice(0, maxRows) : rows;

      return {
        sql,
        rows: limited,
        rowCount: limited.length,
        hasNull: hasNullValue(limited),
        hasDuplicateRows: hasDuplicateRow(limited),
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
 * ゲーム用スキーマを流し込んだブラウザ用エンジンを作る。
 *
 * ブラウザには「読み取り専用で開く」という概念がない（メモリ上のDBなので
 * そもそもファイルを壊せない）。プレイヤーが実行できるのは
 * 断片から組み立てた SELECT のみなので、書き込みの心配はない。
 */
export async function createBrowserEngine(wasmUrl?: string): Promise<QueryEngine> {
  const SQL = await loadSqlJs(wasmUrl);
  const db = new SQL.Database();
  for (const ddl of GAME_SCHEMA.ddl) db.run(ddl);
  for (const seed of GAME_SCHEMA.seed) db.run(seed);
  return makeEngine(db);
}

/** 既存の sql.js Database をエンジンとして包む（テスト用）。 */
export function wrapDatabase(db: Database): QueryEngine {
  return makeEngine(db);
}

/** テスト用に sql.js の初期化状態をリセットする。 */
export function resetSqlJs(): void {
  sqlJsPromise = undefined;
}

/** 型の再エクスポート（呼び出し側が sql.js を直接 import しなくて済むように）。 */
export type { Database as SqlJsDatabase } from "sql.js";

/** Boss ルールの型を再エクスポート（UI が参照する）。 */
export type { BossRuleId, FragmentKind };
