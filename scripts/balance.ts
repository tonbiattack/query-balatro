/**
 * バランス検証スクリプト（`npm run balance`）。
 *
 * 決定的な seed で N ランを自動プレイし、到達アンティ・スコアを集計する。
 * 対話 UI は通さず、RunController を直接叩く（UI の不具合とバランスを混ぜない）。
 *
 * ## AI の方針
 *
 * 手札8枚から最大5枚の全組み合わせ（218通り）を実際にクエリ実行して、
 * スコアが最大になる組み合わせを選ぶ貪欲法。先読みはしない。
 * ジョーカーは「今の手札と噛み合うか」で選ぶ（ランダムより人間の判断に近い）。
 *
 * 実行時間: 1手あたり約10ms × 約27手 × N ラン。N=40 で約12秒。
 */

import { createEngineFromSchema } from "../src/db/engine.ts";
import { createRun } from "../src/logic/index.ts";
import { scoreQuery } from "../src/logic/score.ts";
import { BASE_TABLE, JOKERS, findAnte } from "../src/data/index.ts";
import type {
  FragmentCard,
  JokerDef,
  QueryEngine,
  RunController,
  RunState,
} from "../src/types.ts";
import { RULES } from "../src/types.ts";

// ---------------------------------------------------------------------------
// 組み合わせ生成
// ---------------------------------------------------------------------------

/** ビット数（立っているビットの数）。 */
function popcount(value: number): number {
  let count = 0;
  let bits = value;
  while (bits !== 0) {
    bits &= bits - 1;
    count += 1;
  }
  return count;
}

/**
 * 手札から 1〜maxSize 枚の全組み合わせを作る。
 * 8枚から5枚なら 218 通り（2^8 - 1 - 6枚以上の分）。
 */
export function combinations(items: FragmentCard[], maxSize: number): FragmentCard[][] {
  const out: FragmentCard[][] = [];
  const total = 1 << items.length;
  for (let mask = 1; mask < total; mask += 1) {
    if (popcount(mask) > maxSize) continue;
    const combo: FragmentCard[] = [];
    for (let i = 0; i < items.length; i += 1) {
      if ((mask & (1 << i)) !== 0) combo.push(items[i]);
    }
    out.push(combo);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1手の選択
// ---------------------------------------------------------------------------

/** 1手の評価結果。 */
interface PlayCandidate {
  fragments: FragmentCard[];
  total: number;
  rankId: string;
  rowCount: number;
}

/** 手札から最もスコアが伸びる組み合わせを選ぶ。 */
export function bestPlay(
  engine: QueryEngine,
  state: RunState,
): PlayCandidate | undefined {
  let best: PlayCandidate | undefined;
  for (const combo of combinations(state.hand, RULES.maxPlayFragments)) {
    const result = engine.run(
      { baseTable: BASE_TABLE, fragments: combo },
      { bossRule: state.bossRule },
    );
    // 実行できない組み合わせは候補にしない（Boss 妨害・SQL エラー）
    if (result.error) continue;
    const score = scoreQuery({
      result,
      fragments: combo,
      jokers: state.jokers,
      bossRule: state.bossRule,
    });
    if (!best || score.total > best.total) {
      best = {
        fragments: combo,
        total: score.total,
        rankId: score.rankId,
        rowCount: result.rowCount,
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// ジョーカーの選択
// ---------------------------------------------------------------------------

/**
 * ジョーカーの選択方針。
 *
 * `honest` は「重複の鏡」を取らない。このジョーカーは WINDOW 断片1枚で
 * 58行中57行が完全重複になるため、マルチが +114 されて1枚で約20倍になる。
 * バランスを見るときは、この退化戦略を除いた曲線も必ず確認する。
 */
export type JokerPolicy = "honest" | "all";

/**
 * ジョーカーの優先順位（実測で勝率が最も高かった順）。
 *
 * 60ランで比較した結果:
 *   row>dup>noorder>null>window>like … 33%
 *   row>noorder>null>window>dup>like … 27%
 *   row>window>noorder>null>dup>like … 23%
 * 「行の蒐集家」で行チップを底上げし、次にマルチ加算系を積むのが安定する。
 */
const JOKER_PRIORITY = [
  "dup-mult",
  "row-chips",
  "no-order-mult",
  "null-mult",
  "window-mult",
  "like-chips",
];

/**
 * ジョーカー候補から1つ選ぶ。
 *
 * 優先順位に沿って選ぶ。人間が説明を読んで「伸びる方」を選ぶ判断に近づける。
 * どれも優先順位に無ければ先頭を選ぶ（選択で止まらない）。
 */
export function chooseBestJoker(
  choices: JokerDef[],
  state: RunState,
  policy: JokerPolicy = "honest",
): JokerDef | undefined {
  // 退化戦略を除く方針では「重複の鏡」を候補から外す
  const pool = policy === "honest" ? choices.filter((joker) => joker.id !== "dup-mult") : choices;
  if (pool.length === 0) return undefined;

  // 手札に WINDOW が無ければ「窓の魔術師」の優先度を下げる
  const hasWindow = state.hand.some((fragment) => fragment.kinds.includes("WINDOW"));
  const order = hasWindow
    ? JOKER_PRIORITY
    : [...JOKER_PRIORITY.filter((id) => id !== "window-mult"), "window-mult"];

  for (const id of order) {
    const found = pool.find((joker) => joker.id === id);
    if (found) return found;
  }
  return pool[0];
}

// ---------------------------------------------------------------------------
// 1ラン
// ---------------------------------------------------------------------------

/**
 * 1回のディスカードで捨てる枚数。
 *
 * 実測（60ラン）: 2枚=33% / 3枚=62% / 4枚=67% / 5枚=83%。
 * 手札8枚のうちチップの低い5枚を切ると、役に寄与する断片を引き直せる。
 */
const DISCARD_COUNT = 5;

/** 1ランの結果。 */
export interface RunResult {
  seed: number;
  /** 到達アンティ */
  ante: number;
  /** 到達ブラインド */
  blind: string;
  status: "won" | "lost";
  /** 合計スコア */
  totalScore: number;
  /** 手数 */
  plays: number;
  /** ディスカード回数 */
  discards: number;
  /** 獲得ジョーカー数 */
  jokers: number;
  /** アンティごとの突破状況（1始まり） */
  clearedAntes: number[];
}

/**
 * 1ランを自動プレイする。
 *
 * 方針:
 *   - 突破済みなら次へ進み、報酬のジョーカーを選ぶ
 *   - 目標に届かない見込みが高く、ディスカードが残っていれば捨てて引き直す
 *   - それ以外は最善の組み合わせでプレイ
 */
export function playOneRun(
  engine: QueryEngine,
  seed: number,
  policy: JokerPolicy = "honest",
): RunResult {
  const run: RunController = createRun({ seed }, engine);
  let plays = 0;
  let discards = 0;
  const clearedAntes: number[] = [];
  let guard = 0;

  while (run.state.status === "playing" && guard < 500) {
    guard += 1;
    const state = run.state;

    // --- 突破済み → 次へ + ジョーカー報酬 ---
    if (state.blindScore >= state.targetChips) {
      clearedAntes.push(state.ante);
      run.nextBlind();
      if (run.state.pendingJokerChoices.length > 0) {
        const chosen = chooseBestJoker(run.state.pendingJokerChoices, run.state, policy);
        if (chosen) run.chooseJoker(chosen.id);
      }
      continue;
    }

    // --- 報酬の選択待ちが残っていたら先に処理する ---
    if (state.pendingJokerChoices.length > 0) {
      const chosen = chooseBestJoker(state.pendingJokerChoices, state, policy);
      if (chosen) run.chooseJoker(chosen.id);
      continue;
    }

    const best = bestPlay(engine, state);
    if (!best) break;

    // --- ディスカード判断 ---
    // 残りプレイ回数で割った「1手あたり必要スコア」に届かないなら引き直す。
    // ただし最後の1手は必ずプレイする（捨てて負けるのは無意味）。
    //
    // 捨てる枚数は5枚（実測で最良）。2枚では手札の質が上がりきらず勝率33%、
    // 5枚では83%まで上がる。手札8枚のうちチップの低い5枚を切って、
    // 役に寄与する断片を引き直すのが正しい。
    const needed = state.targetChips - state.blindScore;
    const perPlay = needed / Math.max(1, state.playsLeft);
    const canDiscard = state.discardsLeft > 0 && state.playsLeft > 1;
    if (canDiscard && best.total < perPlay) {
      const worst = [...state.hand]
        .sort((a, b) => a.chips - b.chips)
        .slice(0, DISCARD_COUNT)
        .map((fragment) => fragment.id);
      const outcome = run.discard(worst);
      if (!outcome.error) {
        discards += 1;
        continue;
      }
    }

    const outcome = run.play(best.fragments.map((fragment) => fragment.id));
    plays += 1;
    if (!outcome.ok) {
      // 想定外の失敗（Boss 妨害の見落とし等）。1枚だけ試して詰みを避ける。
      const fallback = run.state.hand[0];
      if (!fallback) break;
      const retry = run.play([fallback.id]);
      if (!retry.ok) break;
    }
  }

  const totalScore = run.state.history.reduce((sum, record) => sum + record.score.total, 0);
  return {
    seed,
    ante: run.state.ante,
    blind: run.state.blind,
    status: run.state.status === "won" ? "won" : "lost",
    totalScore,
    plays,
    discards,
    jokers: run.state.jokers.length,
    clearedAntes,
  };
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

/** 集計結果。 */
export interface BalanceReport {
  runs: RunResult[];
  /** 到達アンティの分布（アンティ → ラン数） */
  anteDistribution: Map<number, number>;
  /** 平均到達アンティ */
  averageAnte: number;
  /** 勝利数 */
  wins: number;
  /** アンティごとの突破率（アンティ → 0〜1） */
  clearRates: Map<number, number>;
  /** 平均手数 */
  averagePlays: number;
  /** 平均ディスカード回数 */
  averageDiscards: number;
  /** 平均獲得ジョーカー数 */
  averageJokers: number;
  /** 平均合計スコア */
  averageScore: number;
}

/** ラン結果を集計する。 */
export function summarize(runs: RunResult[]): BalanceReport {
  const anteDistribution = new Map<number, number>();
  for (const run of runs) {
    anteDistribution.set(run.ante, (anteDistribution.get(run.ante) ?? 0) + 1);
  }

  const averageAnte =
    runs.length === 0 ? 0 : runs.reduce((sum, run) => sum + run.ante, 0) / runs.length;
  const wins = runs.filter((run) => run.status === "won").length;

  // アンティごとの突破率: そのアンティに到達したランのうち、突破した割合
  const clearRates = new Map<number, number>();
  for (let ante = 1; ante <= RULES.maxAnte; ante += 1) {
    const reached = runs.filter((run) => run.ante >= ante).length;
    if (reached === 0) continue;
    const cleared = runs.filter((run) => run.clearedAntes.includes(ante)).length;
    clearRates.set(ante, cleared / reached);
  }

  const average = (pick: (run: RunResult) => number): number =>
    runs.length === 0 ? 0 : runs.reduce((sum, run) => sum + pick(run), 0) / runs.length;

  return {
    runs,
    anteDistribution,
    averageAnte,
    wins,
    clearRates,
    averagePlays: average((run) => run.plays),
    averageDiscards: average((run) => run.discards),
    averageJokers: average((run) => run.jokers),
    averageScore: average((run) => run.totalScore),
  };
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------

/** 3桁区切り。 */
function num(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** パーセント表示。 */
function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** レポートを文字列にする。 */
export function formatReport(
  report: BalanceReport,
  runCount: number,
  label = "重複の鏡なし（想定プレイ）",
): string {
  const lines: string[] = [];
  lines.push("=".repeat(64));
  lines.push(` Query Balatro バランス検証（${runCount}ラン / 決定的 seed）`);
  lines.push(` AI: 手札の全組み合わせを総当たり / ジョーカー: ${label}`);
  lines.push("=".repeat(64));
  lines.push("");

  lines.push("■ 到達アンティの分布");
  for (let ante = 1; ante <= RULES.maxAnte; ante += 1) {
    const count = report.anteDistribution.get(ante) ?? 0;
    if (count === 0) continue;
    const bar = "█".repeat(Math.round((count / runCount) * 40));
    lines.push(`  アンティ${ante}: ${String(count).padStart(3)}ラン ${bar}`);
  }
  lines.push("");

  lines.push("■ 全体");
  lines.push(`  勝利:         ${report.wins} / ${runCount}（${pct(report.wins / runCount)}）`);
  lines.push(`  平均到達アンティ: ${report.averageAnte.toFixed(2)} / ${RULES.maxAnte}`);
  lines.push(`  平均手数:     ${report.averagePlays.toFixed(1)}`);
  lines.push(`  平均ディスカード: ${report.averageDiscards.toFixed(1)}`);
  lines.push(`  平均ジョーカー: ${report.averageJokers.toFixed(1)} / ${RULES.jokerSlots}`);
  lines.push(`  平均合計スコア: ${num(report.averageScore)}`);
  lines.push("");

  lines.push("■ アンティごとの突破率");
  for (const [ante, rate] of [...report.clearRates.entries()].sort((a, b) => a[0] - b[0])) {
    const config = findAnte(ante);
    const targets = config
      ? `目標 ${num(config.small)} / ${num(config.big)} / ${num(config.boss)}`
      : "";
    lines.push(`  アンティ${ante}: ${pct(rate).padStart(4)}  ${targets}`);
  }
  lines.push("");

  lines.push("■ 1ランあたりの所要時間の推定");
  // 1手あたり「考える時間 + 入力 + 結果を読む時間」を 20 秒と仮定する。
  // 内訳: 組み合わせを考える 8秒 / 入力 2秒 / 結果と SQL を読む 10秒。
  const secondsPerPlay = 20;
  const secondsPerDiscard = 8;
  const secondsPerBlind = 6; // ブラインド間の報酬選択と画面確認
  const blindsPerRun = report.averageAnte * 3;
  const estimatedSeconds =
    report.averagePlays * secondsPerPlay +
    report.averageDiscards * secondsPerDiscard +
    blindsPerRun * secondsPerBlind;
  lines.push(`  平均手数 ${report.averagePlays.toFixed(1)} × ${secondsPerPlay}秒 = ${Math.round(
    report.averagePlays * secondsPerPlay,
  )}秒`);
  lines.push(
    `  ディスカード ${report.averageDiscards.toFixed(1)} × ${secondsPerDiscard}秒 = ${Math.round(
      report.averageDiscards * secondsPerDiscard,
    )}秒`,
  );
  lines.push(`  ブラインド間 ${blindsPerRun.toFixed(0)}回 × ${secondsPerBlind}秒 = ${Math.round(
    blindsPerRun * secondsPerBlind,
  )}秒`);
  lines.push(`  → 1ラン約 ${(estimatedSeconds / 60).toFixed(1)}分`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

/** 実行するラン数（`--runs N` で変更できる）。 */
function parseRunCount(argv: string[]): number {
  const index = argv.indexOf("--runs");
  if (index < 0) return 40;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 40;
}

function main(): void {
  const runCount = parseRunCount(process.argv.slice(2));
  const engine = createEngineFromSchema();
  const startedAt = performance.now();

  try {
    // --- 標準プレイ（全ジョーカーを候補にする） ---
    const standardRuns: RunResult[] = [];
    for (let i = 0; i < runCount; i += 1) {
      // seed は 1 始まりの連番（決定的に再現できる）
      standardRuns.push(playOneRun(engine, i + 1, "all"));
    }
    const standardReport = summarize(standardRuns);
    process.stdout.write(`${formatReport(standardReport, runCount, "全ジョーカー（標準）")}\n`);

    // --- 参考: 「重複の鏡」を取らない場合 ---
    // このジョーカーは WINDOW 断片1枚でマルチ +114 になる退化戦略で、
    // これ抜きだとアンティ6で頭打ちになる。バランスの脆さを見るための参考値。
    const honestRuns: RunResult[] = [];
    for (let i = 0; i < runCount; i += 1) {
      honestRuns.push(playOneRun(engine, i + 1, "honest"));
    }
    const honestReport = summarize(honestRuns);
    process.stdout.write(`${formatReport(honestReport, runCount, "重複の鏡を取らない（参考）")}\n`);

    process.stdout.write(
      `（実行時間 ${((performance.now() - startedAt) / 1000).toFixed(1)}秒 / ジョーカー ${JOKERS.length}種）\n`,
    );
  } finally {
    engine.close();
  }
}

main();
