/**
 * 対話ループ本体。
 *
 * readline から切り離して、`ask` / `print` を差し替えられる形にする。
 * これにより tests/cli.test.ts から「スクリプト化した入力」で
 * アンティ8までの通しプレイを検証できる（対話ループ自体はテストしない、という
 * 制約は readline 依存部分のことで、ゲーム進行の検証はここで行う）。
 *
 * 桜井スキルの UI 原則:
 *   - 最初の3分で面白さを伝える: 起動直後に手札と目標が見え、すぐ打てる
 *   - 遅さは罪: プロンプトは最小限。数字だけでもプレイできる。Enter だけで次へ進める
 *   - 押して何も起きないボタンを作らない: 不正入力は必ず理由を返す
 *   - 大事なものを大きく: 目標チップ・現在スコア・残り回数を最上部に固定
 *   - リトライは迅速に: 失敗しても同じ画面に戻り、すぐ次の手を打てる
 */

import type { JokerDef, RunController } from "../types.ts";
import { parseCommand } from "./input.ts";
import {
  formatDiscardResult,
  formatHelp,
  formatJokerChoices,
  formatJokerList,
  formatPlayResult,
  formatRunSummary,
  formatScreen,
} from "./render.ts";

/** 1行入力を受け取る関数。EOF なら undefined を返す。 */
export type Ask = (prompt: string) => Promise<string | undefined>;

/** 出力先。 */
export type Print = (lines: string[]) => void;

/** ループの終了理由。 */
export type LoopExit = "quit" | "ended" | "eof";

/**
 * ジョーカー報酬の選択を処理する。
 * 候補がある間はプレイさせない（報酬を受け取らずに進めない）。
 */
async function resolveJokerChoice(
  run: RunController,
  ask: Ask,
  print: Print,
): Promise<LoopExit | undefined> {
  while (run.state.pendingJokerChoices.length > 0) {
    const choices: JokerDef[] = run.state.pendingJokerChoices;
    print(formatJokerChoices(choices, run.state.jokers.length));

    const answer = await ask(` 番号で選ぶ (1-${choices.length}): `);
    // EOF は「もう入力が来ない」なので、先頭を選んで先へ進む（止まらない）
    if (answer === undefined) {
      run.chooseJoker(choices[0].id);
      print([` 「${choices[0].name}」を獲得しました。`]);
      return "eof";
    }

    const trimmed = answer.trim();
    if (trimmed === "") {
      // Enter だけなら先頭を選ぶ（選択で止まらない）
      run.chooseJoker(choices[0].id);
      print([` 「${choices[0].name}」を獲得しました。`]);
      continue;
    }
    if (!/^\d+$/.test(trimmed)) {
      print([` 「${trimmed}」は番号として読めません。1〜${choices.length} の番号を入れてください。`]);
      continue;
    }
    const number = Number(trimmed);
    if (number < 1 || number > choices.length) {
      print([` 1〜${choices.length} の番号を入れてください（${number} は範囲外です）。`]);
      continue;
    }
    const chosen = choices[number - 1];
    if (run.chooseJoker(chosen.id)) {
      print([` 「${chosen.name}」を獲得しました。`]);
    } else {
      // 枠が埋まっている等。理由を出して抜ける（無限ループにしない）
      print([" ジョーカーを獲得できませんでした（枠が埋まっています）。"]);
      return undefined;
    }
  }
  return undefined;
}

/**
 * ゲームループを回す。
 *
 * @returns 終了理由（quit / ended / eof）
 */
export async function runGameLoop(
  run: RunController,
  ask: Ask,
  print: Print,
): Promise<LoopExit> {
  print([
    "",
    " ╔══════════════════════════════════════════════════════════╗",
    " ║  Query Balatro — 断片を並べてクエリを組み、スコアを伸ばす  ║",
    " ╚══════════════════════════════════════════════════════════╝",
    " 手札の番号を並べて Enter でプレイ（例: 1 3 5）。h でヘルプ、q で終了。",
    "",
  ]);

  // 起動直後にまず画面を出す（説明から始めない）
  print(formatScreen(run.state));

  while (true) {
    // --- ラン終了 ---
    if (run.state.status !== "playing") {
      print(formatRunSummary(run.state));
      return "ended";
    }

    // --- ジョーカー報酬の選択待ち（プレイより先に処理する） ---
    if (run.state.pendingJokerChoices.length > 0) {
      const exit = await resolveJokerChoice(run, ask, print);
      if (exit === "eof") {
        print(formatRunSummary(run.state, true));
        return "eof";
      }
      print(formatScreen(run.state));
      continue;
    }

    // --- ブラインド突破済み → 次へ ---
    if (run.state.blindScore >= run.state.targetChips) {
      print([
        "",
        ` ★ ブラインド突破！ スコア ${run.state.blindScore} / 目標 ${run.state.targetChips}`,
        " Enter で次へ進みます（n でも可）。",
      ]);
      // Enter でも n でも進む。何を押しても無反応にしない。
      const answer = await ask(" > ");
      if (answer === undefined) {
        print(formatRunSummary(run.state, true));
        return "eof";
      }
      run.nextBlind();
      print(formatScreen(run.state));
      continue;
    }

    // --- 通常のコマンド入力 ---
    const raw = await ask(" > ");
    if (raw === undefined) {
      // EOF（パイプ入力の終わり等）。黙って落ちず、結果を出して終わる。
      print(["", " 入力が終わりました。ここまでの結果を出します。"]);
      print(formatRunSummary(run.state, true));
      return "eof";
    }

    const command = parseCommand(raw, run.state.hand.length);

    switch (command.kind) {
      case "empty":
        // 空行は「今の状況をもう一度見たい」と解釈する（無反応にしない）
        print(formatScreen(run.state));
        break;

      case "help":
        print(formatHelp());
        break;

      case "joker":
        print(formatJokerList(run.state.jokers));
        break;

      case "quit":
        print(["", " 終了します。", ...formatRunSummary(run.state, true)]);
        return "quit";

      case "next":
        // 突破していないのに n を押した場合は理由を出す
        print([
          ` まだ目標に届いていません（${run.state.blindScore} / ${run.state.targetChips}）。`,
          " プレイしてスコアを伸ばしてください。",
        ]);
        break;

      case "invalid":
        print([` ${command.message}`]);
        break;

      case "play": {
        const fragmentIds = command.indices
          .map((index) => run.state.hand[index]?.id)
          .filter((id): id is string => id !== undefined);
        const outcome = run.play(fragmentIds);
        print(formatPlayResult(outcome, run.state));
        break;
      }

      case "discard": {
        const fragmentIds = command.indices
          .map((index) => run.state.hand[index]?.id)
          .filter((id): id is string => id !== undefined);
        const outcome = run.discard(fragmentIds);
        print(formatDiscardResult(outcome, run.state));
        break;
      }
    }
  }
}
