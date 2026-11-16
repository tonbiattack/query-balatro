/**
 * ゲームデータの公開窓口。
 *
 * 他モジュールはこのファイル経由でのみデータを参照する。
 * 個別ファイルを直接 import してもよいが、一覧が要る場合はここを使う。
 */

export { BASE_TABLE, DDL, SEED, GAME_SCHEMA } from "./schema.ts";
export { FRAGMENTS, findFragment } from "./fragments.ts";
export { RANKS, NO_RANK_MULT, findRank } from "./ranks.ts";
export { JOKERS, findJoker } from "./jokers.ts";
export { BOSS_RULES, findBossRule } from "./bosses.ts";
export { ANTES, findAnte, targetChips } from "./antes.ts";
