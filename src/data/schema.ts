/**
 * ゲーム用 SQLite スキーマ定義。
 *
 * 設計方針:
 * - プレイヤーが FROM に置くベーステーブルは `cards`（ビュー）のみ
 * - 実体は `cards_raw`。`cards` は id を除いたビュー
 *   → `SELECT *` に主キーが混ざらず、**完全重複行が実際に発生する**。
 *     これがないと重複系ジョーカーと Boss「重複でスコア0」が永久に発動しない
 * - JOIN 断片の的になる小さな参照テーブル（suits / ranks）を用意する
 * - NULL を含む列（edition / seal）を意図的に用意し、NULL 系ジョーカーと役の条件を作る
 */

import type { GameSchema } from "../types.ts";

/** ベーステーブル名。断片カードの SQL はこのテーブルを前提に書く。 */
export const BASE_TABLE = "cards";

/** テーブル作成 DDL（依存順）。 */
export const DDL: string[] = [
  `CREATE TABLE suits (
     code  TEXT PRIMARY KEY,
     name  TEXT NOT NULL,
     color TEXT NOT NULL
   )`,
  `CREATE TABLE ranks (
     rank        TEXT PRIMARY KEY,
     ordinal     INTEGER NOT NULL,
     base_chips  INTEGER NOT NULL
   )`,
  `CREATE TABLE cards_raw (
     id         INTEGER PRIMARY KEY,
     rank       TEXT NOT NULL REFERENCES ranks(rank),
     suit       TEXT NOT NULL REFERENCES suits(code),
     chip_value INTEGER NOT NULL,
     mult_value INTEGER NOT NULL,
     edition    TEXT,
     seal       TEXT
   )`,
  // プレイヤーが見るベーステーブル。id を落とすことで重複行が意味を持つ。
  `CREATE VIEW cards AS
     SELECT rank, suit, chip_value, mult_value, edition, seal
     FROM cards_raw`,
];

/** 初期データ投入 SQL。 */
export const SEED: string[] = [
  // --- suits ---
  `INSERT INTO suits (code, name, color) VALUES
     ('S', 'スペード', 'black'),
     ('H', 'ハート',   'red'),
     ('D', 'ダイヤ',   'red'),
     ('C', 'クラブ',   'black')`,

  // --- ranks ---
  `INSERT INTO ranks (rank, ordinal, base_chips) VALUES
     ('2', 2, 2), ('3', 3, 3), ('4', 4, 4), ('5', 5, 5),
     ('6', 6, 6), ('7', 7, 7), ('8', 8, 8), ('9', 9, 9),
     ('10', 10, 10), ('J', 11, 10), ('Q', 12, 10),
     ('K', 13, 10), ('A', 14, 11)`,

  // --- cards_raw ---
  // 52枚の標準デッキ + 重複行を出せるよう一部を二重に持つ。
  // edition / seal は NULL を多く含む（NULL 系ジョーカー・役の条件になる）。
  `INSERT INTO cards_raw (id, rank, suit, chip_value, mult_value, edition, seal) VALUES
     ( 1, 'A', 'S', 11, 1, NULL,      NULL),
     ( 2, 'K', 'S', 10, 1, 'foil',    NULL),
     ( 3, 'Q', 'S', 10, 1, NULL,      'red'),
     ( 4, 'J', 'S', 10, 1, NULL,      NULL),
     ( 5, '10','S', 10, 1, NULL,      NULL),
     ( 6, '9', 'S',  9, 1, 'holo',    NULL),
     ( 7, '8', 'S',  8, 1, NULL,      NULL),
     ( 8, '7', 'S',  7, 1, NULL,      'blue'),
     ( 9, '6', 'S',  6, 1, NULL,      NULL),
     (10, '5', 'S',  5, 1, NULL,      NULL),
     (11, '4', 'S',  4, 1, NULL,      NULL),
     (12, '3', 'S',  3, 1, NULL,      NULL),
     (13, '2', 'S',  2, 1, NULL,      NULL),
     (14, 'A', 'H', 11, 1, NULL,      NULL),
     (15, 'K', 'H', 10, 1, NULL,      'gold'),
     (16, 'Q', 'H', 10, 1, 'foil',    NULL),
     (17, 'J', 'H', 10, 1, NULL,      NULL),
     (18, '10','H', 10, 1, NULL,      NULL),
     (19, '9', 'H',  9, 1, NULL,      NULL),
     (20, '8', 'H',  8, 1, NULL,      NULL),
     (21, '7', 'H',  7, 1, 'poly',    NULL),
     (22, '6', 'H',  6, 1, NULL,      NULL),
     (23, '5', 'H',  5, 1, NULL,      NULL),
     (24, '4', 'H',  4, 1, NULL,      NULL),
     (25, '3', 'H',  3, 1, NULL,      NULL),
     (26, '2', 'H',  2, 1, NULL,      NULL),
     (27, 'A', 'D', 11, 1, NULL,      NULL),
     (28, 'K', 'D', 10, 1, NULL,      NULL),
     (29, 'Q', 'D', 10, 1, NULL,      NULL),
     (30, 'J', 'D', 10, 1, NULL,      'red'),
     (31, '10','D', 10, 1, NULL,      NULL),
     (32, '9', 'D',  9, 1, NULL,      NULL),
     (33, '8', 'D',  8, 1, NULL,      NULL),
     (34, '7', 'D',  7, 1, NULL,      NULL),
     (35, '6', 'D',  6, 1, NULL,      NULL),
     (36, '5', 'D',  5, 1, NULL,      NULL),
     (37, '4', 'D',  4, 1, NULL,      NULL),
     (38, '3', 'D',  3, 1, NULL,      NULL),
     (39, '2', 'D',  2, 1, NULL,      NULL),
     (40, 'A', 'C', 11, 1, NULL,      NULL),
     (41, 'K', 'C', 10, 1, NULL,      NULL),
     (42, 'Q', 'C', 10, 1, NULL,      NULL),
     (43, 'J', 'C', 10, 1, NULL,      NULL),
     (44, '10','C', 10, 1, NULL,      NULL),
     (45, '9', 'C',  9, 1, NULL,      NULL),
     (46, '8', 'C',  8, 1, NULL,      NULL),
     (47, '7', 'C',  7, 1, NULL,      NULL),
     (48, '6', 'C',  6, 1, NULL,      NULL),
     (49, '5', 'C',  5, 1, NULL,      NULL),
     (50, '4', 'C',  4, 1, NULL,      NULL),
     (51, '3', 'C',  3, 1, NULL,      NULL),
     (52, '2', 'C',  2, 1, NULL,      NULL),
     -- 重複行（ビューで id を落としているので、6列が完全一致する）。
     -- 重複系ジョーカーと Boss「重複でスコア0」の餌。
     (53, 'A', 'S', 11, 1, NULL,      NULL),
     (54, 'K', 'H', 10, 1, NULL,      'gold'),
     (55, '7', 'H',  7, 1, 'poly',    NULL),
     (56, '9', 'S',  9, 1, 'holo',    NULL),
     (57, 'Q', 'S', 10, 1, NULL,      'red'),
     (58, '2', 'C',  2, 1, NULL,      NULL)`,
];

/** ゲーム用スキーマ一式。 */
export const GAME_SCHEMA: GameSchema = {
  baseTable: BASE_TABLE,
  ddl: DDL,
  seed: SEED,
};
