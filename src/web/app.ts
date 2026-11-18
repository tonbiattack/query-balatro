/**
 * Web UI の DOM 層。
 *
 * ゲームのロジック（`game.ts` / `preview.ts`）と表示だけを分離してある。
 * このファイルは「状態を受け取って DOM を書き換える」ことだけを行う。
 *
 * 設計方針（桜井原則より）:
 *   - 最初の3分で面白さを伝える: 起動直後に手札と目標が見え、すぐ打てる
 *   - 遅さは罪: 選択のたびに即座にプレビューを更新する（クエリは 0.1ms なので実行してよい）
 *   - 押して何も起きないボタンを作らない: 押せない理由を必ず表示する
 *   - 大事なものを大きく: 目標・スコア・残り回数を上部に固定
 *   - リトライは迅速に: 終了後すぐ「もう一度」を出す
 */

import { createBrowserEngine } from "../db/browser-engine.ts";
import { createWebGame } from "./game.ts";
import type { WebGame } from "./game.ts";
import { activeJokers, remainingSlots, usedClauseLabels } from "./preview.ts";
import { RULES } from "../types.ts";
import type { FragmentCard, JokerDef, RunState } from "../types.ts";
import { findBossRule } from "../data/index.ts";

// ---------------------------------------------------------------------------
// DOM ヘルパ
// ---------------------------------------------------------------------------

/** ID から要素を取る。無ければ例外（HTML と JS の不整合を早期に検出する）。 */
function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`要素 #${id} が見つかりません`);
  return found as T;
}

/** 数値を 3桁区切りにする。 */
function num(value: number): string {
  return value.toLocaleString("ja-JP");
}

/** テキストを設定する（null 安全）。 */
function setText(node: HTMLElement, text: string): void {
  node.textContent = text;
}

/** 表示・非表示を切り替える。 */
function setHidden(node: HTMLElement, hidden: boolean): void {
  node.hidden = hidden;
}

// ---------------------------------------------------------------------------
// SQL の色分け
// ---------------------------------------------------------------------------

/** 色分けする SQL キーワード。 */
const SQL_KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "ON",
  "GROUP",
  "BY",
  "HAVING",
  "ORDER",
  "LIMIT",
  "AND",
  "OR",
  "AS",
  "IN",
  "LIKE",
  "BETWEEN",
  "IS",
  "NULL",
  "NOT",
  "OVER",
  "PARTITION",
  "DESC",
  "ASC",
]);

/** 色分けする SQL 関数。 */
const SQL_FUNCTIONS = new Set([
  "COUNT",
  "ROW_NUMBER",
  "RANK",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
]);

/**
 * SQL を色分けした HTML にする。
 *
 * プレイヤーが入力した文字列ではなく、断片定義から組み立てた SQL なので
 * HTML エスケープだけ行えば安全（ユーザー入力の埋め込みはない）。
 */
function highlightSql(sql: string): string {
  const escaped = sql
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped.replace(
    /('[^']*')|(\b\d+\b)|([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, str: string | undefined, number: string | undefined, word: string | undefined) => {
      if (str) return `<span class="sql-str">${str}</span>`;
      if (number) return `<span class="sql-num">${number}</span>`;
      if (word) {
        const upper = word.toUpperCase();
        if (SQL_KEYWORDS.has(upper)) return `<span class="sql-kw">${word}</span>`;
        if (SQL_FUNCTIONS.has(upper)) return `<span class="sql-fn">${word}</span>`;
      }
      return match;
    },
  );
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

/** アプリ全体を描画する。 */
function render(game: WebGame): void {
  renderStatus(game);
  renderConsole(game);
  renderJokers(game);
  renderHand(game);
  renderActions(game);
  renderFeedback(game);
  renderOverlay(game);
}

/** 上部のステータス。 */
function renderStatus(game: WebGame): void {
  const state = game.run.state;

  setText(el("ante-label"), `アンティ${state.ante}`);
  const kind = el("blind-label");
  setText(kind, state.blind === "small" ? "Small" : state.blind === "big" ? "Big" : "Boss");
  kind.dataset.kind = state.blind;

  setText(el("target-value"), num(state.targetChips));
  setText(el("score-value"), num(state.blindScore));
  setText(el("score-target"), num(state.targetChips));

  // 進捗バー
  const percent = state.targetChips > 0 ? Math.min(100, (state.blindScore / state.targetChips) * 100) : 0;
  const fill = el("meter-fill");
  fill.style.width = `${percent}%`;
  fill.dataset.cleared = String(state.blindScore >= state.targetChips);
  const meter = el("meter");
  meter.setAttribute("aria-valuenow", String(Math.round(percent)));

  // 残り回数
  const plays = el("plays-left");
  setText(plays, `プレイ ${state.playsLeft}`);
  plays.dataset.low = String(state.playsLeft <= 1);
  const discards = el("discards-left");
  setText(discards, `ディスカード ${state.discardsLeft}`);
  discards.dataset.low = String(state.discardsLeft === 0);

  // Boss 妨害
  const bossNode = el("boss-rule");
  if (state.bossRule === "none") {
    setHidden(bossNode, true);
  } else {
    const rule = findBossRule(state.bossRule);
    setHidden(bossNode, false);
    setText(bossNode, `Boss: ${rule?.description ?? state.bossRule}`);
  }
}

/** クエリコンソール（主役）。 */
function renderConsole(game: WebGame): void {
  const preview = game.preview();
  const selection = game.selection();
  const sqlNode = el("console-sql");
  const metaNode = el("console-meta");
  const verdictNode = el("console-verdict");

  // --- SQL ---
  if (selection.length === 0) {
    sqlNode.innerHTML = '<span class="console__idle">-- 手札から断片をえらんでください</span>';
    setText(metaNode, "断片をえらぶと実行されます");
  } else {
    sqlNode.innerHTML = highlightSql(preview.sql);
    const clauses = usedClauseLabels(selection);
    setText(metaNode, `${selection.length}枚 / ${clauses.join("・")}`);
  }

  // --- 判定 ---
  if (selection.length === 0) {
    verdictNode.innerHTML =
      '<p class="verdict__idle">断片を1枚以上えらぶと、成立する役とスコアが出ます。</p>';
    return;
  }

  if (!preview.ok) {
    verdictNode.innerHTML = `
      <div class="verdict verdict--bad">
        <span class="verdict__rank">この組み合わせでは実行できません</span>
        <p class="verdict__reason">${escapeHtml(preview.reason ?? "")}</p>
      </div>`;
    return;
  }

  const score = preview.score;
  const active = activeJokers(score, game.run.state.jokers);
  const activeNote =
    active.length > 0
      ? `<span class="verdict__rows">効いているジョーカー: ${active.map((j) => escapeHtml(j.name)).join("・")}</span>`
      : "";

  verdictNode.innerHTML = `
    <div class="verdict">
      <span class="verdict__rank">${escapeHtml(preview.rankLabel)}</span>
      <span class="verdict__mult">×${score?.rankMult ?? 0}</span>
      <span class="verdict__total">${num(preview.total)}</span>
      <span class="verdict__rows">返却 ${preview.rowCount}行 / チップ ${num(score?.chips ?? 0)} × マルチ ${score?.mult ?? 0}</span>
      ${activeNote}
    </div>`;
}

/** ジョーカー一覧。 */
function renderJokers(game: WebGame): void {
  const state = game.run.state;
  const list = el("joker-list");
  setText(el("joker-count"), `${state.jokers.length}/${RULES.jokerSlots}`);

  const preview = game.preview();
  const active = activeJokers(preview.score, state.jokers);
  const activeIds = new Set(active.map((j) => j.id));

  list.innerHTML = "";
  if (state.jokers.length === 0) {
    const empty = document.createElement("li");
    empty.className = "jokers__empty";
    empty.textContent = "まだ持っていません。ブラインドを突破すると1つもらえます。";
    list.append(empty);
    return;
  }

  for (const joker of state.jokers) {
    const item = document.createElement("li");
    item.className = "joker";
    item.dataset.active = String(activeIds.has(joker.id));
    item.innerHTML = `
      <div class="joker__name">${escapeHtml(joker.name)}</div>
      <div class="joker__desc">${escapeHtml(joker.description)}</div>`;
    list.append(item);
  }
}

/** 手札。 */
function renderHand(game: WebGame): void {
  const state = game.run.state;
  const list = el("hand-list");
  const selection = game.selection();
  const selectedIds = selection.map((f) => f.id);
  const atLimit = selection.length >= RULES.maxPlayFragments;
  const canSelect = game.phase() === "selecting";

  setText(
    el("hand-hint"),
    atLimit
      ? `上限の${RULES.maxPlayFragments}枚です`
      : `あと${remainingSlots(selection.length)}枚 えらべます`,
  );

  list.innerHTML = "";
  for (const fragment of state.hand) {
    const order = selectedIds.indexOf(fragment.id);
    const isSelected = order >= 0;

    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "card";
    button.setAttribute("aria-pressed", String(isSelected));
    // 選択できない理由を title で補足する（押して何も起きないを作らない）
    button.disabled = !canSelect || (!isSelected && atLimit);
    if (!canSelect) {
      button.title = "いまは断片をえらべません";
    } else if (!isSelected && atLimit) {
      button.title = `断片は最大${RULES.maxPlayFragments}枚までです`;
    }

    button.innerHTML = `
      ${isSelected ? `<span class="card__order">${order + 1}</span>` : ""}
      <span class="card__name">${escapeHtml(fragment.name)}</span>
      <span class="card__tags">${fragment.kinds
        .map((kind) => `<span class="card__tag">${escapeHtml(kind)}</span>`)
        .join("")}</span>
      <span class="card__chips">+${fragment.chips}</span>`;

    button.addEventListener("click", () => {
      game.toggle(fragment.id);
      render(game);
    });

    item.append(button);
    list.append(item);
  }
}

/** 操作ボタン。 */
function renderActions(game: WebGame): void {
  const phase = game.phase();
  const selection = game.selection();
  const preview = game.preview();

  const playBtn = el<HTMLButtonElement>("btn-play");
  const discardBtn = el<HTMLButtonElement>("btn-discard");
  const clearBtn = el<HTMLButtonElement>("btn-clear");

  const canPlay = phase === "selecting" && selection.length > 0 && preview.ok;
  playBtn.disabled = !canPlay;
  setText(el("btn-play-sub"), selection.length > 0 ? `${selection.length}枚` : "");

  // 押せない理由をボタンの title に出す
  if (!canPlay) {
    playBtn.title =
      phase !== "selecting"
        ? "いまはプレイできません"
        : selection.length === 0
          ? "断片を1枚以上えらんでください"
          : (preview.reason ?? "プレイできません");
  } else {
    playBtn.title = "";
  }

  discardBtn.disabled = phase !== "selecting" || selection.length === 0;
  discardBtn.title =
    phase !== "selecting"
      ? "いまはディスカードできません"
      : selection.length === 0
        ? "捨てる断片をえらんでください"
        : "";

  clearBtn.disabled = selection.length === 0;
}

/** 直前の結果。 */
function renderFeedback(game: WebGame): void {
  const feedback = game.lastFeedback();
  const node = el("feedback");
  if (!feedback) {
    setHidden(node, true);
    return;
  }
  setHidden(node, false);
  node.dataset.ok = String(feedback.ok);
  setText(el("feedback-headline"), feedback.headline);
  setText(el("feedback-detail"), feedback.detail ?? "");

  const lines = el("feedback-lines");
  lines.innerHTML = "";
  for (const line of feedback.lines) {
    const item = document.createElement("li");
    item.textContent = line;
    lines.append(item);
  }
}

/** オーバーレイ（ジョーカー報酬・ラン結果）。 */
function renderOverlay(game: WebGame): void {
  const overlay = el("overlay");
  const phase = game.phase();

  if (phase === "choosing-joker") {
    const choices = game.run.state.pendingJokerChoices;
    setHidden(overlay, false);
    setText(el("overlay-title"), "ジョーカーを1つえらぶ");
    setText(
      el("overlay-body"),
      `ブラインド突破の報酬です。枠は ${game.run.state.jokers.length}/${RULES.jokerSlots}。`,
    );

    const actions = el("overlay-actions");
    actions.innerHTML = "";
    for (const joker of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice";
      button.innerHTML = `
        <span class="choice__name">${escapeHtml(joker.name)}</span>
        <span class="choice__desc">${escapeHtml(joker.description)}</span>`;
      button.addEventListener("click", () => {
        game.chooseJoker(joker.id);
        render(game);
      });
      actions.append(button);
    }
    return;
  }

  if (phase === "blind-cleared") {
    setHidden(overlay, false);
    setText(el("overlay-title"), "ブラインド突破");
    setText(
      el("overlay-body"),
      `スコア ${num(game.run.state.blindScore)} / 目標 ${num(game.run.state.targetChips)}`,
    );
    const actions = el("overlay-actions");
    actions.innerHTML = "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn--primary";
    button.textContent = "次のブラインドへ";
    button.addEventListener("click", () => {
      game.nextBlind();
      render(game);
    });
    actions.append(button);
    return;
  }

  if (phase === "ended") {
    setHidden(overlay, false);
    const state = game.run.state;
    const won = state.status === "won";
    setText(el("overlay-title"), won ? "クリア" : "敗北");
    setText(
      el("overlay-body"),
      won
        ? "アンティ8のBossを突破しました。"
        : "目標チップに届きませんでした。もう一度どうぞ。",
    );

    const actions = el("overlay-actions");
    actions.innerHTML = "";

    const summary = document.createElement("div");
    summary.className = "summary";
    summary.innerHTML = `
      <div class="summary__row">
        <span class="summary__label">到達アンティ</span>
        <span class="summary__value">${state.ante} / ${RULES.maxAnte}</span>
      </div>
      <div class="summary__row">
        <span class="summary__label">手数</span>
        <span class="summary__value">${state.history.length}</span>
      </div>
      <div class="summary__row">
        <span class="summary__label">結果</span>
        <span class="summary__value" data-tone="${won ? "win" : "lose"}">${won ? "クリア" : "敗北"}</span>
      </div>`;
    actions.append(summary);

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn btn--primary";
    retry.textContent = "もう一度あそぶ";
    retry.addEventListener("click", () => {
      game.restart();
      render(game);
    });
    actions.append(retry);
    return;
  }

  setHidden(overlay, true);
}

/** HTML エスケープ。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

/** 起動処理。 */
async function boot(): Promise<void> {
  const bootNode = el("boot");
  const appNode = el("app");

  try {
    // wasm は同じディレクトリに置く（ビルドスクリプトがコピーする）
    const engine = await createBrowserEngine(new URL("./sql-wasm.wasm", import.meta.url).href);
    const game = createWebGame(engine);

    // 操作ボタンの配線
    el("btn-play").addEventListener("click", () => {
      game.play();
      render(game);
    });
    el("btn-discard").addEventListener("click", () => {
      game.discard();
      render(game);
    });
    el("btn-clear").addEventListener("click", () => {
      game.clearSelection();
      render(game);
    });

    // キーボード操作（PC で素早く打てるように）
    document.addEventListener("keydown", (event) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (!el<HTMLButtonElement>("btn-play").disabled) {
          game.play();
          render(game);
        }
      } else if (event.key === "Escape") {
        game.clearSelection();
        render(game);
      } else if (event.key === "Backspace") {
        // 最後に選んだ断片を1枚戻す
        const selection = game.selection();
        const last = selection[selection.length - 1];
        if (last) {
          game.toggle(last.id);
          render(game);
        }
      }
    });

    // 初回描画
    render(game);

    setHidden(bootNode, true);
    setHidden(appNode, false);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    bootNode.innerHTML = `
      <p class="boot__mark">起動できませんでした</p>
      <p class="boot__note">${escapeHtml(message)}</p>
      <p class="boot__note">ページを再読み込みしてください。</p>`;
    // Console に詳細を出す（開発時の手がかり）
    console.error("起動に失敗しました", cause);
  }
}

void boot();
