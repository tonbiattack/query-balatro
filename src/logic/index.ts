/**
 * logic モジュールの公開窓口。
 *
 * CLI はこのファイル経由でのみ logic を参照する。
 * 依存方向は types ← data ← db ← logic ← cli なので、ここから上へは何も import しない。
 */

// --- スコア計算 ---
export { scoreQuery } from "./score.ts";

// --- ラン進行 ---
export { createRun, describeBlind, summarizeScore, availableJokers } from "./run.ts";

// --- 既定エンジンの遅延解決（CLI が明示的に後片付けしたい場合に使う） ---
export { resolveDefaultEngine, resetDefaultEngine } from "./engine-provider.ts";

// --- 乱数（バランス検証スクリプトが seed を扱うときに使う） ---
export { mulberry32, shuffleInPlace } from "./rng.ts";
