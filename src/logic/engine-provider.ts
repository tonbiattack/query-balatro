/**
 * 既定 QueryEngine の遅延解決。
 *
 * logic は `QueryEngine` インターフェースにのみ依存する（依存方向 types ← db ← logic）。
 * 既定エンジンは `src/db/engine.ts` の `createEngineFromSchema()` だが、
 * db モジュールは並行実装中のため、**静的 import にしない**。
 *
 * 静的 import にすると次の2つの問題が出る:
 *   1. db が未完成の間、logic のテストが import 時点で失敗する
 *   2. tsc が存在しないファイルを解決しようとして型エラーになる
 *
 * そこで createRequire で実行時にだけ解決する。db が完成すれば、
 * このファイルを変更せずにそのまま既定エンジンとして使われる。
 */

import { createRequire } from "node:module";
import type { QueryEngine } from "../types.ts";

/** 既定エンジンのシングルトン（読み取り専用なのでラン間で共有してよい）。 */
let defaultEngine: QueryEngine | undefined;

/** 既定エンジンの生成に失敗した理由（2回目以降は同じ理由を即返す）。 */
let defaultEngineError: Error | undefined;

/** `src/db/engine.ts` が公開するはずの関数の形。 */
type CreateEngineFromSchema = () => QueryEngine;

/**
 * `src/db/engine.ts` を実行時に読み込み、`createEngineFromSchema()` を返す。
 * モジュールが無い・関数が無い場合は、原因の分かる Error を投げる。
 */
function loadCreateEngineFromSchema(): CreateEngineFromSchema {
  // このファイル自身を基準に解決する（cwd に依存させない）
  const requireFromHere = createRequire(import.meta.url);
  let mod: unknown;
  try {
    mod = requireFromHere("../db/engine.ts");
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      "既定の QueryEngine を読み込めませんでした。" +
        "src/db/engine.ts が未実装か、読み込みに失敗しています。" +
        "createRun(options, engine) の第2引数でエンジンを注入してください。" +
        `（原因: ${detail}）`,
    );
  }
  const factory = (mod as { createEngineFromSchema?: unknown }).createEngineFromSchema;
  if (typeof factory !== "function") {
    throw new Error(
      "src/db/engine.ts に createEngineFromSchema() が公開されていません。" +
        "createRun(options, engine) の第2引数でエンジンを注入してください。",
    );
  }
  return factory as CreateEngineFromSchema;
}

/**
 * 既定の QueryEngine を返す。初回だけ生成し、以降は同じインスタンスを返す。
 * 生成に失敗した場合は Error を投げる（呼び出し側が注入を促す）。
 */
export function resolveDefaultEngine(): QueryEngine {
  if (defaultEngine) return defaultEngine;
  if (defaultEngineError) throw defaultEngineError;
  try {
    defaultEngine = loadCreateEngineFromSchema()();
    return defaultEngine;
  } catch (cause) {
    defaultEngineError = cause instanceof Error ? cause : new Error(String(cause));
    throw defaultEngineError;
  }
}

/** 既定エンジンを破棄する（テストの後片付け用）。 */
export function resetDefaultEngine(): void {
  if (defaultEngine) {
    try {
      defaultEngine.close();
    } catch {
      // 後片付けの失敗は握りつぶす（テストの成否に影響させない）
    }
  }
  defaultEngine = undefined;
  defaultEngineError = undefined;
}
