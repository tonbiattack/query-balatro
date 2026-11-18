/**
 * 断片カードプール。
 *
 * 設計方針:
 * - 1枚で意味が通る SQL 断片にする（プレイヤーが並べた順ではなく、句の正規順で組み立てる）
 * - 役の条件（WHERE / JOIN / WINDOW 等）を満たせるよう、句の種類を散らす
 * - チップは「使いにくい断片ほど高い」ではなく「役に寄与する断片ほど高い」に寄せる
 * - すべて cards テーブルを FROM に置く前提で書く
 */

import type { FragmentCard } from "../types.ts";

/** 断片カードの全プール。 */
export const FRAGMENTS: FragmentCard[] = [
  // -------------------------------------------------------------------------
  // WHERE 系（役: ペア相当 ×2）
  // -------------------------------------------------------------------------
  {
    id: "where-rank-eq",
    name: "WHERE ランク一致",
    sql: "cards.rank = 'A'",
    clause: "WHERE",
    kinds: ["WHERE"],
    chips: 10,
    flavor: "エースを引っ張り出す。",
  },
  {
    id: "where-suit-eq",
    name: "WHERE スート一致",
    sql: "cards.suit = 'H'",
    clause: "WHERE",
    kinds: ["WHERE"],
    chips: 10,
    flavor: "ハートだけを残す。",
  },
  {
    id: "where-chip-gte",
    name: "WHERE チップ以上",
    sql: "cards.chip_value >= 10",
    clause: "WHERE",
    kinds: ["WHERE"],
    chips: 15,
    flavor: "強い札だけを通す。",
  },
  {
    id: "where-null-edition",
    name: "WHERE エディション無し",
    sql: "cards.edition IS NULL",
    clause: "WHERE",
    kinds: ["WHERE"],
    chips: 20,
    flavor: "加工されていない素の札。",
  },
  {
    id: "where-like-rank",
    name: "WHERE LIKE ランク",
    sql: "cards.rank LIKE '1%'",
    clause: "WHERE",
    kinds: ["WHERE", "LIKE"],
    chips: 25,
    flavor: "10 と 1 の付くランクを拾う。",
  },
  {
    id: "where-like-seal",
    name: "WHERE LIKE シール",
    sql: "cards.seal LIKE '%e%'",
    clause: "WHERE",
    kinds: ["WHERE", "LIKE"],
    chips: 25,
    flavor: "シールの名前を部分一致で探す。",
  },
  {
    id: "where-between-chip",
    name: "WHERE BETWEEN チップ",
    sql: "cards.chip_value BETWEEN 5 AND 9",
    clause: "WHERE",
    kinds: ["WHERE", "BETWEEN"],
    chips: 30,
    flavor: "中くらいの札をまとめて掴む。",
  },
  {
    id: "where-between-ordinal",
    name: "WHERE BETWEEN 倍率",
    sql: "cards.mult_value BETWEEN 1 AND 2",
    clause: "WHERE",
    kinds: ["WHERE", "BETWEEN"],
    chips: 30,
    flavor: "倍率の低い札だけを残す。",
  },
  {
    id: "where-in-suit",
    name: "WHERE IN スート",
    sql: "cards.suit IN ('S', 'H')",
    clause: "WHERE",
    kinds: ["WHERE", "IN"],
    chips: 30,
    flavor: "黒と赤、2色だけ。",
  },
  {
    id: "where-in-rank",
    name: "WHERE IN ランク",
    sql: "cards.rank IN ('J', 'Q', 'K')",
    clause: "WHERE",
    kinds: ["WHERE", "IN"],
    chips: 35,
    flavor: "絵札をまとめて。",
  },

  // -------------------------------------------------------------------------
  // JOIN 系（役: ストレート相当 ×4）
  // -------------------------------------------------------------------------
  {
    id: "join-suits",
    name: "JOIN スート",
    sql: "JOIN suits ON cards.suit = suits.code",
    clause: "JOIN",
    kinds: ["JOIN"],
    joins: ["suits"],
    chips: 20,
    flavor: "スートの名前を引く。",
  },
  {
    id: "join-ranks",
    name: "JOIN ランク",
    sql: "JOIN ranks ON cards.rank = ranks.rank",
    clause: "JOIN",
    kinds: ["JOIN"],
    joins: ["ranks"],
    chips: 20,
    flavor: "ランクの基礎値と繋ぐ。",
  },
  {
    id: "join-both",
    name: "JOIN 両方",
    sql: "JOIN suits ON cards.suit = suits.code JOIN ranks ON cards.rank = ranks.rank",
    clause: "JOIN",
    kinds: ["JOIN"],
    joins: ["suits", "ranks"],
    chips: 40,
    flavor: "2つの参照テーブルを同時に。",
  },

  // -------------------------------------------------------------------------
  // ウィンドウ関数系（役: フルハウス相当 ×6）
  // -------------------------------------------------------------------------
  {
    id: "window-row-number",
    name: "WINDOW 行番号",
    sql: "ROW_NUMBER() OVER (PARTITION BY cards.suit ORDER BY cards.chip_value DESC) AS rn",
    clause: "SELECT_EXPR",
    kinds: ["WINDOW"],
    chips: 35,
    flavor: "スートごとに順位を振る。",
  },
  {
    id: "window-rank",
    name: "WINDOW 順位",
    sql: "RANK() OVER (ORDER BY cards.chip_value DESC) AS rnk",
    clause: "SELECT_EXPR",
    kinds: ["WINDOW"],
    chips: 35,
    flavor: "全体での順位。",
  },
  {
    id: "window-count",
    name: "WINDOW 件数",
    sql: "COUNT(*) OVER (PARTITION BY cards.rank) AS same_rank",
    clause: "SELECT_EXPR",
    kinds: ["WINDOW"],
    chips: 40,
    flavor: "同じランクが何枚あるか。",
  },

  // -------------------------------------------------------------------------
  // GROUP BY / HAVING 系
  // -------------------------------------------------------------------------
  {
    id: "group-by-suit",
    name: "GROUP BY スート",
    sql: "cards.suit",
    clause: "GROUP_BY",
    kinds: ["GROUP_BY"],
    chips: 25,
    flavor: "スートでまとめる。",
  },
  {
    id: "group-by-rank",
    name: "GROUP BY ランク",
    sql: "cards.rank",
    clause: "GROUP_BY",
    kinds: ["GROUP_BY"],
    chips: 25,
    flavor: "ランクでまとめる。",
  },
  {
    id: "having-count",
    name: "HAVING 件数",
    sql: "COUNT(*) >= 2",
    clause: "HAVING",
    kinds: ["HAVING"],
    chips: 30,
    flavor: "2枚以上ある組だけ残す。",
  },

  // -------------------------------------------------------------------------
  // ORDER BY / LIMIT 系
  // -------------------------------------------------------------------------
  {
    id: "order-by-chip",
    name: "ORDER BY チップ",
    sql: "cards.chip_value DESC",
    clause: "ORDER_BY",
    kinds: ["ORDER_BY"],
    chips: 15,
    flavor: "強い順に並べる。",
  },
  {
    id: "order-by-rank",
    name: "ORDER BY ランク",
    sql: "cards.rank ASC",
    clause: "ORDER_BY",
    kinds: ["ORDER_BY"],
    chips: 15,
    flavor: "ランク順に並べる。",
  },
  {
    id: "limit-10",
    name: "LIMIT 10",
    sql: "10",
    clause: "LIMIT",
    kinds: ["LIMIT"],
    chips: 10,
    flavor: "10行だけ。",
  },
  {
    id: "limit-5",
    name: "LIMIT 5",
    sql: "5",
    clause: "LIMIT",
    kinds: ["LIMIT"],
    chips: 15,
    flavor: "5行だけ。",
  },
];

/** ID から断片を引く。 */
export function findFragment(id: string): FragmentCard | undefined {
  return FRAGMENTS.find((f) => f.id === id);
}
