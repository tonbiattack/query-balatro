/**
 * logic モジュールの公開窓口（ブラウザでも安全な範囲）。
 *
 * ここには **Node 専用の依存を持たない**ものだけを置く。
 * CLI が使う「既定エンジンの遅延解決」は `./node.ts` にある
 * （`node:module` を使うため、ブラウザ向けバンドルに含めてはいけない）。
 *
 * 依存方向は types ← data ← db ← logic ← cli なので、ここから上へは何も import しない。
 */

// --- スコア計算 ---
export { scoreQuery } from "./score.ts";

// --- ラン進行 ---
export { createRun, describeBlind, summarizeScore, availableJokers } from "./run.ts";

// --- 乱数（バランス検証スクリプトが seed を扱うときに使う） ---
export { mulberry32, shuffleInPlace } from "./rng.ts";
