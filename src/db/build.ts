/**
 * SQL 組み立て。
 *
 * プレイヤーが並べた断片を、SQL の正規の句順に並べ替えて1つの SELECT にする。
 * 並び順の試行錯誤をプレイヤーに要求しないための正規化。
 *
 * 句順: SELECT_EXPR → JOIN → WHERE → GROUP_BY → HAVING → ORDER_BY → LIMIT
 */

import type { ClauseKind, FragmentCard, QueryPlan } from "../types.ts";

/** 句の正規順。 */
const CLAUSE_ORDER: ClauseKind[] = [
  "SELECT_EXPR",
  "JOIN",
  "WHERE",
  "GROUP_BY",
  "HAVING",
  "ORDER_BY",
  "LIMIT",
];

/** 句ごとの区切り方。 */
const CLAUSE_SEPARATOR: Record<ClauseKind, string> = {
  SELECT_EXPR: ", ",
  JOIN: " ",
  WHERE: " AND ",
  GROUP_BY: ", ",
  HAVING: " AND ",
  ORDER_BY: ", ",
  LIMIT: ", ",
};

/** 句ごとのキーワード（SELECT_EXPR と JOIN は断片側がキーワードを含む）。 */
const CLAUSE_KEYWORD: Partial<Record<ClauseKind, string>> = {
  WHERE: "WHERE",
  GROUP_BY: "GROUP BY",
  HAVING: "HAVING",
  ORDER_BY: "ORDER BY",
  LIMIT: "LIMIT",
};

/** 断片を句ごとにまとめる。 */
function groupByClause(fragments: FragmentCard[]): Map<ClauseKind, FragmentCard[]> {
  const grouped = new Map<ClauseKind, FragmentCard[]>();
  for (const fragment of fragments) {
    const list = grouped.get(fragment.clause);
    if (list) {
      list.push(fragment);
    } else {
      grouped.set(fragment.clause, [fragment]);
    }
  }
  return grouped;
}

/**
 * 断片から SELECT 文を組み立てる。
 *
 * - SELECT_EXPR が無ければ `SELECT *`
 * - GROUP BY がある場合は、集約していない列も SELECT に含める
 *   （SQLite は許容するが、何が返るか分かる方が UI で説明しやすい）
 * - HAVING だけを置いた場合は `SELECT COUNT(*) AS n` にする。
 *   `SELECT * ... HAVING` は SQLite が "HAVING clause on a non-aggregate query" で
 *   拒否するため、断片単体で使うと必ず失敗する。それでは「置いたのに何も起きない」
 *   断片になり、プレイヤーが理由を理解できない。集約クエリに正規化して成立させる。
 * - LIMIT は1つだけ採用する（複数指定は SQL エラーになるため）
 */
export function buildSql(plan: QueryPlan): string {
  const grouped = groupByClause(plan.fragments);
  const parts: string[] = [];

  // --- SELECT ---
  const selectExprs = (grouped.get("SELECT_EXPR") ?? []).map((f) => f.sql);
  const groupBys = (grouped.get("GROUP_BY") ?? []).map((f) => f.sql);
  const havings = grouped.get("HAVING") ?? [];
  const selectList = [...selectExprs, ...groupBys];

  if (selectList.length > 0) {
    parts.push(`SELECT ${selectList.join(", ")}`);
  } else if (havings.length > 0) {
    // HAVING 単体は集約クエリとして成立させる
    parts.push("SELECT COUNT(*) AS n");
  } else {
    parts.push("SELECT *");
  }

  // --- FROM ---
  parts.push(`FROM ${plan.baseTable}`);

  // --- 以降の句を正規順で ---
  for (const clause of CLAUSE_ORDER) {
    if (clause === "SELECT_EXPR") continue; // SELECT で処理済み
    const fragments = grouped.get(clause);
    if (!fragments || fragments.length === 0) continue;

    // LIMIT は1つだけ採用する
    const selected = clause === "LIMIT" ? fragments.slice(0, 1) : fragments;
    const body = selected.map((f) => f.sql).join(CLAUSE_SEPARATOR[clause]);
    const keyword = CLAUSE_KEYWORD[clause];

    if (clause === "JOIN") {
      // JOIN 断片はキーワードを含む完全な句
      parts.push(body);
    } else if (keyword) {
      parts.push(`${keyword} ${body}`);
    }
  }

  return parts.join(" ");
}
