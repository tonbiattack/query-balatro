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
 * - HAVING があるのに GROUP BY が無い場合は、SELECT に集約関数を足す。
 *   `SELECT * ... HAVING` も `SELECT ROW_NUMBER() OVER (...) ... HAVING` も
 *   SQLite が "HAVING clause on a non-aggregate query" で拒否するため、
 *   そのままだと「HAVING を置いたら必ず失敗する」断片になる。
 *   プレイヤーは理由を理解できないので、集約クエリに正規化して成立させる。
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

  // HAVING は集約クエリでないと成立しない。GROUP BY が無いのに HAVING がある場合は
  // 集約関数を SELECT に足して「集約クエリ」にする。
  const needsAggregate = havings.length > 0 && groupBys.length === 0;

  if (selectList.length > 0) {
    parts.push(
      needsAggregate
        ? `SELECT ${[...selectList, "COUNT(*) AS n"].join(", ")}`
        : `SELECT ${selectList.join(", ")}`,
    );
  } else if (needsAggregate) {
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

    if (clause === "JOIN") {
      // JOIN 断片はキーワードを含む完全な句。
      // 同じテーブルを2回 JOIN すると `ambiguous column name` で必ず失敗するため、
      // テーブル単位で重複を除く（先に並べた断片を優先する）。
      parts.push(dedupeJoins(fragments).map((f) => f.sql).join(" "));
      continue;
    }

    // LIMIT は1つだけ採用する
    const selected = clause === "LIMIT" ? fragments.slice(0, 1) : fragments;
    const body = selected.map((f) => f.sql).join(CLAUSE_SEPARATOR[clause]);
    const keyword = CLAUSE_KEYWORD[clause];
    if (keyword) {
      parts.push(`${keyword} ${body}`);
    }
  }

  return parts.join(" ");
}

/**
 * JOIN 断片から、結合先テーブルが重複するものを除く。
 *
 * 例: `join-suits`（suits に JOIN）と `join-both`（suits と ranks に JOIN）を
 * 同時に並べると、suits が2回 JOIN されて `ambiguous column name` になる。
 * 先に並べた断片を優先し、すでに結合済みのテーブルに触れる断片は捨てる。
 *
 * `joins` が未指定の断片（古い定義や外部から注入されたもの）は
 * 安全側に倒してそのまま残す（重複除去の対象にしない）。
 */
function dedupeJoins(fragments: FragmentCard[]): FragmentCard[] {
  const joined = new Set<string>();
  const kept: FragmentCard[] = [];
  for (const fragment of fragments) {
    const tables = fragment.joins;
    if (!tables || tables.length === 0) {
      kept.push(fragment);
      continue;
    }
    // すでに結合済みのテーブルを含むなら、この断片は捨てる
    if (tables.some((table) => joined.has(table))) continue;
    for (const table of tables) joined.add(table);
    kept.push(fragment);
  }
  return kept;
}
