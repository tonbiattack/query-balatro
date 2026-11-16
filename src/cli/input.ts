/**
 * CLI の入力パース。
 *
 * 対話ループから切り離した純粋関数にして、テストできるようにする。
 * 「押して何も起きない」を作らないため、解釈できない入力は必ず理由付きで返す。
 */

import { RULES } from "../types.ts";

/** プレイヤーが入力した1コマンド。 */
export type Command =
  /** 手札の番号（0始まり）を並べてプレイする */
  | { kind: "play"; indices: number[] }
  /** 手札の番号（0始まり）を並べてディスカードする */
  | { kind: "discard"; indices: number[] }
  | { kind: "help" }
  | { kind: "quit" }
  /** ブラインド突破後に次へ進む */
  | { kind: "next" }
  /** ジョーカーの効果を見る */
  | { kind: "joker" }
  /** 何も入力されなかった（Enter だけ） */
  | { kind: "empty" }
  /** 解釈できなかった。理由を必ず添える */
  | { kind: "invalid"; message: string };

/** プレイを表す語。 */
const PLAY_WORDS = new Set(["p", "play", "プレイ"]);
/** ディスカードを表す語。 */
const DISCARD_WORDS = new Set(["d", "discard", "すてる", "捨てる"]);
/** ヘルプを表す語。 */
const HELP_WORDS = new Set(["h", "help", "?", "？", "ヘルプ"]);
/** 終了を表す語。 */
const QUIT_WORDS = new Set(["q", "quit", "exit", "終了", "やめる"]);
/** 次へ進む語。 */
const NEXT_WORDS = new Set(["n", "next", "次", "つぎ"]);
/** ジョーカー表示の語。 */
const JOKER_WORDS = new Set(["j", "joker", "ジョーカー"]);

/** 入力を空白・カンマ・読点で区切る。 */
function tokenize(raw: string): string[] {
  return raw
    .trim()
    .split(/[\s,、]+/)
    .filter((token) => token !== "");
}

/** 番号の並びを 0 始まりの添字へ変換する。問題があれば理由を返す。 */
function parseIndices(
  tokens: string[],
  handSize: number,
  actionLabel: string,
): { indices: number[] } | { message: string } {
  if (tokens.length === 0) {
    return {
      message: `${actionLabel}する断片の番号を指定してください（例: 1 3 5）。`,
    };
  }
  if (tokens.length > RULES.maxPlayFragments) {
    return {
      message: `一度に${actionLabel}できるのは最大${RULES.maxPlayFragments}枚です（${tokens.length}枚指定されました）。`,
    };
  }

  const indices: number[] = [];
  const seen = new Set<number>();
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) {
      return {
        message: `「${token}」は番号として読めません。手札の左に付いている番号を指定してください（例: 1 3 5）。`,
      };
    }
    const number = Number(token);
    if (number < 1 || number > handSize) {
      return {
        message: `手札は 1〜${handSize} 番です。「${token}」は範囲外です。`,
      };
    }
    if (seen.has(number)) {
      return {
        message: `${number} 番が2回指定されています。同じ断片は1回だけ選べます。`,
      };
    }
    seen.add(number);
    indices.push(number - 1);
  }
  return { indices };
}

/**
 * 入力行をコマンドに変換する。
 *
 * - `p 1 3 5` / `1 3 5` … プレイ（数字だけでも通す。毎回 `p` を打たせない）
 * - `d 2 4` … ディスカード
 * - `h` / `n` / `j` / `q` … ヘルプ・次へ・ジョーカー・終了
 * - 空行 … empty（呼び出し側が状況に応じて案内する）
 */
export function parseCommand(raw: string, handSize: number): Command {
  const tokens = tokenize(raw);
  if (tokens.length === 0) return { kind: "empty" };

  const head = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  if (PLAY_WORDS.has(head)) {
    const parsed = parseIndices(rest, handSize, "プレイ");
    if ("message" in parsed) return { kind: "invalid", message: parsed.message };
    return { kind: "play", indices: parsed.indices };
  }
  if (DISCARD_WORDS.has(head)) {
    const parsed = parseIndices(rest, handSize, "ディスカード");
    if ("message" in parsed) return { kind: "invalid", message: parsed.message };
    return { kind: "discard", indices: parsed.indices };
  }
  if (HELP_WORDS.has(head)) return { kind: "help" };
  if (QUIT_WORDS.has(head)) return { kind: "quit" };
  if (NEXT_WORDS.has(head)) return { kind: "next" };
  if (JOKER_WORDS.has(head)) return { kind: "joker" };

  // 数字だけならプレイ扱い（テンポ優先）
  if (/^\d+$/.test(head)) {
    const parsed = parseIndices(tokens, handSize, "プレイ");
    if ("message" in parsed) return { kind: "invalid", message: parsed.message };
    return { kind: "play", indices: parsed.indices };
  }

  return {
    kind: "invalid",
    message: `「${tokens[0]}」は分かりません。p 1 3 5 = プレイ / d 2 = ディスカード / h = ヘルプ / q = 終了。`,
  };
}
