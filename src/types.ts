/**
 * Query Balatro — 共有型契約（全モジュールが依存する唯一の型定義）
 *
 * このファイルはモジュール境界の契約。実装側の都合で破壊的変更をしない。
 * 変更が必要な場合は Issue で合意してから行う。
 *
 * 依存方向（逆方向の import は禁止）:
 *   types.ts  ←  data/  ←  db/  ←  logic/  ←  cli/
 *   types.ts  ←  db/    ←  logic/
 */

// ---------------------------------------------------------------------------
// ルール定数（【】で括った数値はここに集約する）
// ---------------------------------------------------------------------------

/** ゲーム全体の固定ルール。調整値は data/ 側に置き、ここは構造だけを持つ。 */
export const RULES = {
  /** 手札の枚数 */
  handSize: 8,
  /** 1回のプレイで並べられる断片の最大枚数 */
  maxPlayFragments: 5,
  /** 1ブラインドあたりのプレイ回数 */
  playsPerBlind: 4,
  /** 1ブラインドあたりのディスカード回数 */
  discardsPerBlind: 2,
  /** ジョーカー枠 */
  jokerSlots: 5,
  /** 1クエリの実行制限（ミリ秒） */
  queryTimeoutMs: 100,
  /** 1クエリの取得上限（行） */
  maxRows: 100,
  /** 最終アンティ */
  maxAnte: 8,
} as const;

// ---------------------------------------------------------------------------
// 断片カード
// ---------------------------------------------------------------------------

/**
 * 断片が寄与する SQL 句の種類（＝組み立て時の配置先）。
 * 組み立て順は SELECT_EXPR → JOIN → WHERE → GROUP_BY → HAVING → ORDER_BY → LIMIT。
 */
export type ClauseKind =
  | "SELECT_EXPR"
  | "JOIN"
  | "WHERE"
  | "GROUP_BY"
  | "HAVING"
  | "ORDER_BY"
  | "LIMIT";

/**
 * 断片のタグ。役判定・Boss妨害・ジョーカー条件はすべてこれで表す。
 * `clause` とは独立で、1枚が複数タグを持てる（例: LIKE 断片は clause=WHERE, kinds=[WHERE, LIKE]）。
 */
export type FragmentKind =
  | "WHERE"
  | "JOIN"
  | "LIKE"
  | "BETWEEN"
  | "IN"
  | "WINDOW"
  | "GROUP_BY"
  | "HAVING"
  | "ORDER_BY"
  | "LIMIT";

/** 断片カード1枚。プレイヤーはこれを並べて SELECT を組み立てる。 */
export interface FragmentCard {
  /** 一意ID（例: "where-eq"） */
  id: string;
  /** 表示名（例: "WHERE 等値"） */
  name: string;
  /**
   * 句の本体。キーワード（WHERE / JOIN 等）は含めない。
   * - clause=SELECT_EXPR: 式（例: "ROW_NUMBER() OVER (...) AS rn"）
   * - clause=JOIN: 完全な JOIN 句（例: "JOIN suits ON cards.suit = suits.code"）
   * - clause=WHERE: 条件式（例: "cards.rank = 'A'"）
   * - clause=ORDER_BY: 式（例: "cards.chip_value DESC"）
   * - clause=LIMIT: 数値（例: "10"）
   */
  sql: string;
  /** 配置先の句 */
  clause: ClauseKind;
  /** タグ（役・Boss・ジョーカー判定用）。先頭が主タグ（UI の色分けに使う）。 */
  kinds: FragmentKind[];
  /** この断片を使ったときに加算される基礎チップ */
  chips: number;
  /** フレーバーテキスト（任意） */
  flavor?: string;
}

// ---------------------------------------------------------------------------
// クエリ組み立て・実行
// ---------------------------------------------------------------------------

/** プレイヤーが確定した1手。 */
export interface QueryPlan {
  /** FROM に置くベーステーブル名（例: "cards"） */
  baseTable: string;
  /** 並べた断片（順序は保持されるが、組み立ては正規の句順で行う） */
  fragments: FragmentCard[];
}

/** 1行分の値。列名 → 値。 */
export type Row = Record<string, string | number | null>;

/** クエリ実行結果。役判定に必要な情報をすべて含む。 */
export interface QueryResult {
  /** 実際に実行した SQL（UI 表示・デバッグ用） */
  sql: string;
  /** 返却行（maxRows で切り詰め済み） */
  rows: Row[];
  /** 返却行数（切り詰め後） */
  rowCount: number;
  /** 返却行に NULL が1つでも含まれるか */
  hasNull: boolean;
  /** 返却行に完全重複行が含まれるか */
  hasDuplicateRows: boolean;
  /** 使用した句の種類（重複なし・出現順） */
  usedKinds: FragmentKind[];
  /** 実行時間（ミリ秒） */
  elapsedMs: number;
  /** 実行できなかった場合の理由。成功時は undefined。 */
  error?: QueryError;
}

/** クエリが実行できなかった理由。 */
export type QueryError =
  | { code: "not-select"; message: string }
  | { code: "timeout"; message: string }
  | { code: "sql-error"; message: string }
  | { code: "blocked-by-boss"; message: string };

/**
 * プレイが成立しなかった理由。
 *
 * `QueryError` は「クエリを実行したが失敗した」ことを表す。
 * それとは別に「プレイの前提が満たされていない」入力検証エラーがあり、
 * UI はこの2つを出し分ける必要がある（前者はプレイヤーの組み方の問題、
 * 後者は操作ミスなので、同じ文言で出すとプレイヤーが混乱する）。
 */
export type PlayError =
  /** 断片の枚数が 1〜maxPlayFragments の範囲外 */
  | { code: "invalid-count"; message: string }
  /** 手札にない断片IDが指定された */
  | { code: "unknown-fragment"; message: string }
  /** 同じ断片を2回以上指定した */
  | { code: "duplicate-fragment"; message: string }
  /** プレイ回数が残っていない */
  | { code: "no-plays-left"; message: string }
  /** ディスカード回数が残っていない */
  | { code: "no-discards-left"; message: string }
  /** クエリ実行に失敗した（QueryError を内包する） */
  | { code: "query-failed"; message: string; cause: QueryError };

/** クエリ実行基盤のインターフェース。logic はこれにのみ依存する。 */
export interface QueryEngine {
  /** 断片から SELECT を組み立てて実行する。例外は投げず QueryResult.error に載せる。 */
  run(plan: QueryPlan, options?: RunQueryOptions): QueryResult;
  /** 組み立てだけ行う（実行しない）。テスト・UI 表示用。 */
  buildSql(plan: QueryPlan): string;
  /** DB を閉じる */
  close(): void;
}

/** run() のオプション。 */
export interface RunQueryOptions {
  /** Boss 妨害ルール。指定時は実行前に拒否判定を行う。 */
  bossRule?: BossRuleId;
  /** 取得上限の上書き（既定は RULES.maxRows） */
  maxRows?: number;
}

// ---------------------------------------------------------------------------
// 役（ランク）
// ---------------------------------------------------------------------------

/** 役の成立条件。すべての指定を満たしたときに成立する。 */
export interface RankCondition {
  /** これらの kind をすべて含む */
  allKinds?: FragmentKind[];
  /** これらの kind のうち1つ以上を含む */
  anyKinds?: FragmentKind[];
  /** これらの kind を1つも含まない */
  noneKinds?: FragmentKind[];
  /** 返却行数がこの数以上 */
  minRows?: number;
}

/** 役の定義。RANKS は優先度の高い順に並べ、最初に成立したものを採用する。 */
export interface RankDef {
  id: string;
  /** 表示名（例: "ストレート相当"） */
  label: string;
  /** 役の倍率 */
  mult: number;
  /** 成立条件 */
  requires: RankCondition;
  /** フレーバーテキスト（任意） */
  flavor?: string;
}

// ---------------------------------------------------------------------------
// ジョーカー
// ---------------------------------------------------------------------------

/** ジョーカーの効果。データ側で宣言し、logic 側が評価する。 */
export type JokerEffect =
  /**
   * NULL を含む行が1行でもあればマルチ +value（行数に比例しない）。
   * 仕様書の「NULL行を含むクエリはマルチ+4」は**定額**の意味。
   * 行数に比例させると 58行 × 4 = +232 マルチになり、目標値を桁違いに超えて崩壊する。
   */
  | { type: "multIfNull"; value: number }
  /** LIKE タグを含む断片1枚につきチップ +value */
  | { type: "chipsPerLike"; value: number }
  /** 指定 kind を含む断片1枚につきマルチ +value */
  | { type: "multPerKind"; kind: FragmentKind; value: number }
  /** 返却行1行につきチップ +value */
  | { type: "chipsPerRow"; value: number }
  /** ORDER BY を使っていなければマルチ +value */
  | { type: "multIfNoOrderBy"; value: number }
  /**
   * 完全重複行が1組でもあればマルチ +value（組数に比例しない）。
   * 行数に比例させると、WINDOW 断片1枚で58行中57行が重複するため
   * +114 マルチになり、このジョーカー1個で勝敗が決まる退化戦略になる（実測20倍）。
   */
  | { type: "multIfDuplicate"; value: number };

/** ジョーカー定義。 */
export interface JokerDef {
  id: string;
  name: string;
  /** 効果の説明文（UI 表示用） */
  description: string;
  /** ショップ価格（MVP は報酬固定なので表示のみ） */
  cost: number;
  effect: JokerEffect;
}

// ---------------------------------------------------------------------------
// Boss 妨害
// ---------------------------------------------------------------------------

/** Boss ブラインドの妨害ルール。データ側ではなくルール側を縛る。 */
export type BossRuleId =
  | "none"
  /** ORDER BY を含むクエリを拒否する */
  | "noOrderBy"
  /** LIKE を含むクエリを拒否する */
  | "noLike"
  /** JOIN を含むクエリを拒否する */
  | "noJoin"
  /** 完全重複行を含むクエリはスコア0 */
  | "zeroOnDuplicate"
  /** 取得上限を 50 行に下げる */
  | "maxRows50";

/** Boss ルールの定義。 */
export interface BossRuleDef {
  id: BossRuleId;
  name: string;
  description: string;
}

// ---------------------------------------------------------------------------
// アンティ・ブラインド
// ---------------------------------------------------------------------------

/** ブラインドの種類。 */
export type BlindKind = "small" | "big" | "boss";

/** アンティ1段分の設定。 */
export interface AnteConfig {
  ante: number;
  /** Small ブラインドの目標チップ */
  small: number;
  /** Big ブラインドの目標チップ */
  big: number;
  /** Boss ブラインドの目標チップ */
  boss: number;
  /** Boss ブラインドの妨害ルール */
  bossRule: BossRuleId;
}

// ---------------------------------------------------------------------------
// スコア
// ---------------------------------------------------------------------------

/** スコア計算の入力。 */
export interface ScoreContext {
  result: QueryResult;
  fragments: FragmentCard[];
  jokers: JokerDef[];
  bossRule: BossRuleId;
}

/** スコア計算の内訳。UI はこれをそのまま表示する。 */
export interface ScoreBreakdown {
  /** 合計チップ */
  chips: number;
  /** 合計マルチ */
  mult: number;
  /** 最終スコア（chips × mult、整数に丸め） */
  total: number;
  /** 成立した役 */
  rankId: string;
  rankLabel: string;
  /** 役の倍率 */
  rankMult: number;
  /** 断片由来のチップ */
  fragmentChips: number;
  /** 返却行由来のチップ */
  rowChips: number;
  /** ジョーカー由来のチップ */
  jokerChips: number;
  /** ジョーカー由来のマルチ加算 */
  jokerMult: number;
  /** 計算過程の説明（UI 表示用、順序どおり） */
  notes: string[];
}

// ---------------------------------------------------------------------------
// ラン状態
// ---------------------------------------------------------------------------

/** ランの進行状態。 */
export interface RunState {
  ante: number;
  blind: BlindKind;
  /** 現在のブラインドの目標チップ */
  targetChips: number;
  /** 現在のブラインドで稼いだチップ */
  blindScore: number;
  playsLeft: number;
  discardsLeft: number;
  /** 手札 */
  hand: FragmentCard[];
  /** 山札（手札の補充元） */
  deck: FragmentCard[];
  /** 捨て札 */
  discardPile: FragmentCard[];
  jokers: JokerDef[];
  bossRule: BossRuleId;
  status: "playing" | "won" | "lost";
  /** プレイ履歴（1手ごとの結果） */
  history: PlayRecord[];
  /**
   * Boss 突破後にもらえるジョーカーの候補（最大3）。
   * 空でなければ報酬を受け取っていない状態。`chooseJoker()` で1つ選ぶと空になる。
   */
  pendingJokerChoices: JokerDef[];
}

/** 1手の記録。 */
export interface PlayRecord {
  ante: number;
  blind: BlindKind;
  /** 並べた断片のID */
  fragmentIds: string[];
  /** 実行した SQL */
  sql: string;
  /** スコア内訳 */
  score: ScoreBreakdown;
  /** 実行エラー（あれば） */
  error?: QueryError;
}

// ---------------------------------------------------------------------------
// ラン進行の契約（logic が実装し、cli が依存する）
// ---------------------------------------------------------------------------

/** 1手プレイした結果。 */
export interface PlayOutcome {
  /** クエリが実行できたか（Boss 妨害・SQL エラー・タイムアウトは false） */
  ok: boolean;
  /** 実行結果（ok のときのみ） */
  result?: QueryResult;
  /** スコア内訳（ok のときのみ） */
  score?: ScoreBreakdown;
  /** 失敗理由（ok が false のときのみ） */
  error?: PlayError;
  /** この手でブラインドを突破したか */
  blindCleared: boolean;
  /** この手でランが終了したか（勝利または敗北） */
  runEnded: boolean;
}

/** ディスカードした結果。 */
export interface DiscardOutcome {
  /** 捨てられた枚数 */
  discarded: number;
  /** 失敗理由（残り回数不足・不正なIDなど） */
  error?: PlayError;
}

/** ランの進行を司るコントローラ。CLI はこれにのみ依存する。 */
export interface RunController {
  /** 現在のラン状態（読み取り専用として扱う） */
  readonly state: RunState;
  /**
   * 断片IDを並べてプレイする。
   * - 枚数が 1〜RULES.maxPlayFragments の範囲外なら ok=false
   * - 手札にないIDなら ok=false
   * - プレイ回数が残っていなければ ok=false
   */
  play(fragmentIds: string[]): PlayOutcome;
  /** 断片IDを捨てて山札から引き直す。 */
  discard(fragmentIds: string[]): DiscardOutcome;
  /**
   * ブラインド突破後に次のブラインドへ進む。
   * 突破していなければ何もしない。突破済みなら報酬のジョーカー候補を用意する。
   */
  nextBlind(): void;
  /**
   * 報酬のジョーカーを1つ選んで獲得する。
   * 候補が無い、または枠が埋まっていれば false。
   */
  chooseJoker(jokerId: string): boolean;
  /** ジョーカーを追加する。枠が空いていなければ false。 */
  addJoker(jokerId: string): boolean;
}

/** ラン生成のオプション。 */
export interface CreateRunOptions {
  /** 乱数の種（未指定なら非決定的） */
  seed?: number;
  /** 初期ジョーカーID（テスト・デバッグ用） */
  initialJokers?: string[];
}

// ---------------------------------------------------------------------------
// ゲームデータ（DB スキーマ）
// ---------------------------------------------------------------------------

/** ゲーム用 SQLite DB のスキーマ定義。seed と db の両方がこれを参照する。 */
export interface GameSchema {
  /** ベーステーブル名（プレイヤーが FROM に置くテーブル） */
  baseTable: string;
  /** テーブル作成 DDL（依存順） */
  ddl: string[];
  /** 初期データ投入 SQL */
  seed: string[];
}
