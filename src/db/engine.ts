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
import type { QueryEngine, QueryPlan, QueryResult, Row, RunQueryOptions } from "../types.ts";
import { RULES } from "../types.ts";
import { GAME_SCHEMA } from "../data/schema.ts";
import { buildSql } from "./build.ts";
import {
  bossRowCap,
  collectUsedKinds,
  failure,
  findBossViolation,
  friendlySqlError,
  hasDuplicateRow,
  hasNullValue,
  isSelect,
  validateStructure,
} from "./validate.ts";

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
