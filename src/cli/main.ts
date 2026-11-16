/**
 * Query Balatro — CLI エントリポイント。
 *
 * `npm start` で起動する。`node:readline/promises` の対話ループ。
 * ゲーム進行そのものは `loop.ts` に切り出してあり、ここは入出力の配線だけを行う。
 *
 * ## EOF（入力の終わり）の扱い
 *
 * `readline/promises` の `question()` は、パイプ入力（`echo ... | npm start`）で
 * **1行読んだ直後に `close` が飛び、2回目以降の `question()` が永久に解決されない**。
 * 実測で確認した挙動で、そのまま await するとプロセスが固まる。
 *
 * そこで `question()` ではなく **async iterator**（`for await (const line of rl)`）を使う。
 * こちらはパイプ入力でも全行を順に返し、尽きたら `done` になる。
 * プロンプトは `rl.setPrompt()` + `rl.prompt()` で自前で出す。
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { createEngineFromSchema } from "../db/engine.ts";
import { createRun } from "../logic/index.ts";
import { runGameLoop } from "./loop.ts";
import type { Ask, Print } from "./loop.ts";

/** 画面を出す（1行ずつ書く）。 */
const print: Print = (lines) => {
  stdout.write(`${lines.join("\n")}\n`);
};

/** コマンドライン引数から seed を読む（`--seed 42`）。再現したいとき用。 */
function parseSeed(argv: string[]): number | undefined {
  const index = argv.indexOf("--seed");
  if (index < 0) return undefined;
  const raw = argv[index + 1];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * readline をラップして、EOF でも止まらない `ask` を作る。
 *
 * async iterator を1つだけ回し、`ask()` が呼ばれるたびに次の行を取り出す。
 * 入力が尽きたら undefined を返し続ける（呼び出し側はループを抜ける）。
 */
function createAsk(): { ask: Ask; close: () => void } {
  const rl = createInterface({ input: stdin, output: stdout });
  const iterator = rl[Symbol.asyncIterator]();

  /** 入力が尽きたか。尽きた後は即 undefined を返す。 */
  let exhausted = false;

  const ask: Ask = async (prompt) => {
    if (exhausted) return undefined;
    // プロンプトは自前で出す（question() を使わないため）
    stdout.write(prompt);
    const { value, done } = await iterator.next();
    if (done) {
      exhausted = true;
      return undefined;
    }
    return value;
  };

  return { ask, close: () => rl.close() };
}

/** 対話ループ本体。 */
async function main(): Promise<void> {
  const seed = parseSeed(process.argv.slice(2));
  const engine = createEngineFromSchema();
  const run = createRun(seed === undefined ? {} : { seed }, engine);
  const { ask, close } = createAsk();

  try {
    await runGameLoop(run, ask, print);
  } finally {
    close();
    engine.close();
  }
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  stdout.write(`\n エラーで終了しました: ${message}\n`);
  process.exitCode = 1;
});
