/**
 * CLI の表示整形。
 *
 * すべて純粋関数にして、対話ループから切り離す（tests/cli.test.ts で検証する）。
 * 桜井スキルの UI 原則に従い、次を守る:
 *   - 大事なものを大きく: 目標チップ・現在スコア・残り回数を最上部にまとめる
 *   - 押して何も起きないボタンを作らない: 失敗は必ず理由を返す
 *   - ヘルプ文は専門用語を避ける（SQL 用語自体は題材なので可）
 */

import type {
  DiscardOutcome,
  FragmentCard,
  JokerDef,
  PlayError,
  PlayOutcome,
  RunState,
  ScoreBreakdown,
} from "../types.ts";
import { RULES } from "../types.ts";
import { findBossRule } from "../data/index.ts";
import { describeBlind } from "../logic/index.ts";

/** 画面の横幅（罫線の長さ）。 */
export const WIDTH = 62;

/** 手札の名前欄の幅。 */
const NAME_WIDTH = 24;
/** 手札のタグ欄の幅。 */
const TAG_WIDTH = 14;

// ---------------------------------------------------------------------------
// 文字幅・数値
// ---------------------------------------------------------------------------

/**
 * 1文字の表示幅。日本語（全角）は2、それ以外は1として数える。
 * 罫線や表の桁を揃えるために使う。
 */
function charWidth(code: number): number {
  if (code < 0x1100) return 1;
  if (
    code <= 0x115f || // ハングル字母
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK・かな・記号
    (code >= 0xac00 && code <= 0xd7a3) || // ハングル音節
    (code >= 0xf900 && code <= 0xfaff) || // CJK 互換
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK 互換形
    (code >= 0xff00 && code <= 0xff60) || // 全角英数
    (code >= 0xffe0 && code <= 0xffe6) || // 全角記号
    (code >= 0x1f300 && code <= 0x1f64f) || // 絵文字
    (code >= 0x1f900 && code <= 0x1f9ff)
  ) {
    return 2;
  }
  return 1;
}

/** 文字列の表示幅。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0);
  return width;
}

/** 表示幅が width になるよう右側を空白で埋める。 */
function padEndWidth(text: string, width: number): string {
  const diff = width - displayWidth(text);
  return diff > 0 ? text + " ".repeat(diff) : text;
}

/** 表示幅が width になるよう左側を空白で埋める。 */
function padStartWidth(text: string, width: number): string {
  const diff = width - displayWidth(text);
  return diff > 0 ? " ".repeat(diff) + text : text;
}

/** 3桁区切りの数値にする（例: 33000 → "33,000"）。 */
export function formatNumber(value: number): string {
  const rounded = Math.round(value);
  const negative = rounded < 0;
  const digits = String(Math.abs(rounded));
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return negative ? `-${out}` : out;
}

/** 進捗バー（例: "████████░░░░░░░░░░░░"）。 */
export function progressBar(current: number, target: number, width = 20): string {
  const ratio = target <= 0 ? 1 : Math.min(1, Math.max(0, current / target));
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** 進捗率（0〜100 の整数）。 */
export function progressPercent(current: number, target: number): number {
  if (target <= 0) return 100;
  return Math.min(100, Math.floor((current / target) * 100));
}

/** 罫線。 */
function rule(char = "─"): string {
  return char.repeat(WIDTH);
}

/** 左寄せと右寄せを1行に並べる。 */
function twoColumn(left: string, right: string): string {
  const gap = WIDTH - displayWidth(left) - displayWidth(right) - 1;
  return `${left}${" ".repeat(Math.max(1, gap))}${right}`;
}

/** 長い文字列を単語単位で折り返す。 */
export function wrapWords(text: string, width: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (displayWidth(candidate) > width && current !== "") {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(current);
  return lines.length > 0 ? lines : [""];
}

// ---------------------------------------------------------------------------
// ヘッダ・手札・ジョーカー
// ---------------------------------------------------------------------------

/** 画面上部の状況表示（目標・スコア・残り回数を最上部に集める）。 */
export function formatHeader(state: RunState): string[] {
  const lines: string[] = [];
  lines.push(rule("═"));
  lines.push(
    twoColumn(` ${describeBlind(state)}`, `目標 ${formatNumber(state.targetChips)} `),
  );
  lines.push(
    twoColumn(
      ` スコア ${formatNumber(state.blindScore)} / ${formatNumber(state.targetChips)}`,
      `${progressBar(state.blindScore, state.targetChips)} ${String(
        progressPercent(state.blindScore, state.targetChips),
      ).padStart(3)}% `,
    ),
  );
  lines.push(
    twoColumn(
      ` プレイ ${state.playsLeft} / ${RULES.playsPerBlind}   ディスカード ${state.discardsLeft} / ${RULES.discardsPerBlind}`,
      "",
    ).trimEnd(),
  );
  lines.push(rule("═"));

  // Boss 妨害は見落とすと「なぜ失敗したか」が分からなくなるので必ず出す
  if (state.bossRule !== "none") {
    const boss = findBossRule(state.bossRule);
    const name = boss ? boss.name : state.bossRule;
    const description = boss ? boss.description : "";
    lines.push(` ⚠ Boss 妨害: ${name}`);
    for (const line of wrapWords(description, WIDTH - 4)) lines.push(`   ${line}`);
    lines.push(rule());
  }
  return lines;
}

/** 断片のタグ表示（例: "[WHERE/LIKE]"）。 */
export function formatTags(fragment: FragmentCard): string {
  return `[${fragment.kinds.join("/")}]`;
}

/** 手札を番号付きで表示する。 */
export function formatHand(hand: FragmentCard[]): string[] {
  const lines: string[] = [];
  lines.push(" 手札");
  if (hand.length === 0) {
    lines.push("   （手札がありません）");
    return lines;
  }
  hand.forEach((fragment, index) => {
    const number = String(index + 1).padStart(2);
    const name = padEndWidth(fragment.name, NAME_WIDTH);
    const tags = padEndWidth(formatTags(fragment), TAG_WIDTH);
    const chips = padStartWidth(`+${fragment.chips}`, 4);
    lines.push(`  ${number}. ${name} ${tags} ${chips}`);
  });
  return lines;
}

/** ジョーカーの一覧（枠の使用状況つき）。 */
export function formatJokerList(jokers: JokerDef[]): string[] {
  const lines: string[] = [];
  lines.push(` ジョーカー (${jokers.length}/${RULES.jokerSlots})`);
  if (jokers.length === 0) {
    lines.push("   まだ持っていません（ブラインドを突破すると1つもらえます）");
    return lines;
  }
  jokers.forEach((joker, index) => {
    lines.push(`   ${index + 1}. ${joker.name} — ${joker.description}`);
  });
  return lines;
}

/** 1ターン分の画面。 */
export function formatScreen(state: RunState): string[] {
  const lines: string[] = [];
  lines.push(...formatHeader(state));
  lines.push(...formatJokerList(state.jokers));
  lines.push(rule());
  lines.push(...formatHand(state.hand));
  lines.push(rule());
  lines.push(" p 1 3 5 = プレイ / d 2 = ディスカード / h = ヘルプ / q = 終了");
  return lines;
}

// ---------------------------------------------------------------------------
// プレイ結果
// ---------------------------------------------------------------------------

/** スコア内訳を表示する。 */
export function formatScoreBreakdown(score: ScoreBreakdown): string[] {
  const lines: string[] = [];
  lines.push(` ▶ ${score.rankLabel} ×${score.rankMult}`);
  lines.push(`   チップ ${formatNumber(score.chips)} × マルチ ${score.mult} = ${formatNumber(score.total)}`);
  lines.push("   内訳:");
  for (const note of score.notes) lines.push(`     ・${note}`);
  return lines;
}

/**
 * プレイ失敗の理由を表示する。
 *
 * 入力ミス（操作の直し方）とクエリ失敗（クエリの何が悪いか）を出し分ける。
 * 同じ文言で出すと、プレイヤーが何を直せばいいか分からなくなる。
 */
export function formatPlayError(error: PlayError): string[] {
  const lines: string[] = [];

  if (error.code === "query-failed") {
    lines.push(" ✖ クエリを実行できませんでした");
    lines.push(`   ${error.message}`);
    const cause = error.cause;
    switch (cause.code) {
      case "blocked-by-boss":
        lines.push("   → このブラインドで禁止されている句が入っています。");
        lines.push("     その句を使わない組み方に変えてください。");
        break;
      case "timeout":
        lines.push("   → 重すぎるクエリです。JOIN や WINDOW の枚数を減らしてみてください。");
        break;
      case "not-select":
        lines.push("   → SELECT 以外は実行できません。");
        break;
      case "sql-error":
        lines.push("   → 断片の組み合わせが SQL として成立していません。");
        lines.push("     句の相性（GROUP BY と HAVING、LIMIT の位置など）を見直してください。");
        break;
    }
    return lines;
  }

  // 入力ミス: 何を直せばいいかを必ず書く
  lines.push(" ✖ その操作はできません");
  lines.push(`   ${error.message}`);
  switch (error.code) {
    case "invalid-count":
      lines.push(`   → 1〜${RULES.maxPlayFragments}枚になるように番号を選び直してください。`);
      break;
    case "unknown-fragment":
      lines.push("   → 手札の左に付いている番号を指定してください。");
      break;
    case "duplicate-fragment":
      lines.push("   → 同じ番号を2回書いていませんか。");
      break;
    case "no-plays-left":
      lines.push("   → このブラインドのプレイ回数はもう残っていません。");
      break;
    case "no-discards-left":
      lines.push("   → このブラインドのディスカード回数はもう残っていません。");
      break;
  }
  return lines;
}

/** 1手プレイした結果の表示。 */
export function formatPlayResult(outcome: PlayOutcome, state: RunState): string[] {
  const lines: string[] = [rule()];

  if (!outcome.ok || !outcome.score || !outcome.result) {
    if (outcome.error) lines.push(...formatPlayError(outcome.error));
    else lines.push(" ✖ プレイできませんでした");
    lines.push(rule());
    return lines;
  }

  lines.push(...formatScoreBreakdown(outcome.score));

  const result = outcome.result;
  lines.push(
    `   返却 ${result.rowCount}行 / 実行 ${Math.round(result.elapsedMs)}ms / 使用句 ${
      result.usedKinds.length > 0 ? result.usedKinds.join("・") : "なし"
    }`,
  );

  // 実行した SQL は「何をしたか」の手応えになるので必ず出す
  lines.push("   SQL:");
  for (const line of wrapWords(result.sql, WIDTH - 6)) lines.push(`     ${line}`);

  lines.push(rule());
  lines.push(
    ` スコア ${formatNumber(state.blindScore)} / ${formatNumber(state.targetChips)}  ${progressBar(
      state.blindScore,
      state.targetChips,
    )} ${String(progressPercent(state.blindScore, state.targetChips)).padStart(3)}%`,
  );
  lines.push(rule());
  return lines;
}

/** ディスカード結果の表示。 */
export function formatDiscardResult(outcome: DiscardOutcome, state: RunState): string[] {
  const lines: string[] = [rule()];
  if (outcome.error) {
    lines.push(...formatPlayError(outcome.error));
  } else {
    lines.push(` ↻ ${outcome.discarded}枚を捨てて引き直しました（残り ${state.discardsLeft}回）`);
  }
  lines.push(rule());
  return lines;
}

// ---------------------------------------------------------------------------
// ジョーカー報酬
// ---------------------------------------------------------------------------

/** ジョーカー報酬の3択表示。 */
export function formatJokerChoices(choices: JokerDef[], ownedCount: number): string[] {
  const lines: string[] = [rule("═")];
  lines.push(` ★ ジョーカー獲得！ 1つ選んでください（枠 ${ownedCount}/${RULES.jokerSlots}）`);
  lines.push(rule());
  choices.forEach((joker, index) => {
    lines.push(`   ${index + 1}. ${joker.name}`);
    for (const line of wrapWords(joker.description, WIDTH - 8)) lines.push(`      ${line}`);
  });
  lines.push(rule("═"));
  return lines;
}

// ---------------------------------------------------------------------------
// ラン終了
// ---------------------------------------------------------------------------

/**
 * ランの結果サマリ。
 *
 * @param state ラン状態
 * @param aborted 途中で終了した（入力の終わり・q）場合 true。
 *   このとき status は "playing" のままなので、敗北と混同しないよう別の見出しにする。
 */
export function formatRunSummary(state: RunState, aborted = false): string[] {
  const lines: string[] = [];
  const won = state.status === "won";
  const totalScore = state.history.reduce((sum, record) => sum + record.score.total, 0);

  lines.push(rule("═"));
  if (won) {
    lines.push(" ★ 勝利！ アンティ8の Boss を突破しました");
  } else if (aborted && state.status === "playing") {
    lines.push(" ■ ここまでの記録（途中終了）");
  } else {
    lines.push(" ✖ 敗北… 目標チップに届きませんでした");
  }
  lines.push(rule("═"));
  lines.push(` 到達アンティ: ${state.ante} / ${RULES.maxAnte}（${describeBlind(state)}）`);
  lines.push(` 合計スコア:   ${formatNumber(totalScore)}`);
  lines.push(` 手数:         ${state.history.length}`);
  lines.push(` ジョーカー:   ${state.jokers.length}/${RULES.jokerSlots}`);
  for (const joker of state.jokers) lines.push(`   ・${joker.name} — ${joker.description}`);
  lines.push(rule());

  // 履歴は直近12手まで（長すぎるログは読まれない）
  const recent = state.history.slice(-12);
  if (recent.length > 0) {
    lines.push(` 履歴（直近${recent.length}手 / 全${state.history.length}手）`);
    for (const record of recent) {
      const blind = record.blind === "small" ? "Small" : record.blind === "big" ? "Big" : "Boss";
      const mark = record.error ? "✖" : "・";
      lines.push(
        `  ${mark} アンティ${record.ante} ${blind.padEnd(5)} ${record.score.rankLabel} ${formatNumber(
          record.score.total,
        )}`,
      );
    }
    lines.push(rule());
  }
  return lines;
}

// ---------------------------------------------------------------------------
// ヘルプ
// ---------------------------------------------------------------------------

/** ヘルプ文。専門用語を避け、SQL 用語は題材なのでそのまま使う。 */
export function formatHelp(): string[] {
  return [
    rule("═"),
    " ■ 遊び方",
    "   手札から断片を最大5枚えらんでプレイすると、SQL が組み立てられて実行されます。",
    "   返ってきた行と、使った句の種類で「役」が決まり、チップ × マルチでスコアが伸びます。",
    "   目標チップに届けばブラインド突破。プレイ4回で届かなければ負けです。",
    "",
    " ■ コマンド",
    "   p 1 3 5   手札の1・3・5番でプレイ（数字だけでもOK）",
    "   d 2 4     2・4番を捨てて引き直す（1ブラインド2回まで）",
    "   n         ブラインドを突破したら次へ",
    "   j         持っているジョーカーの効果を見る",
    "   h         このヘルプ",
    "   q         終了",
    "",
    " ■ 役（強い順）",
    "   ロイヤル相当   ×10    JOIN + WINDOW + GROUP BY",
    "   フルハウス相当 ×6     WINDOW を含む",
    "   ストレート相当 ×4     JOIN を含む",
    "   フラッシュ相当 ×3     BETWEEN か IN を含む",
    "   ツーペア相当   ×2.5   LIKE を含む",
    "   ペア相当       ×2     WHERE を含む",
    "   ハイカード相当 ×1     1行以上返った",
    "   0行ならスコア0",
    "",
    " ■ コツ",
    "   ・「役を上げる」か「行を増やす」かの二択。残りプレイ回数から逆算する",
    "   ・Boss は句を禁止してくる。使えない句があるときは組み方を変える",
    "   ・ブラインドを突破するとジョーカーを1つもらえる（枠5）",
    rule("═"),
  ];
}
