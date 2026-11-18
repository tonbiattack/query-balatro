/**
 * Web ビルドスクリプト。
 *
 * `src/web/` を `dist/` にバンドルする。GitHub Pages は静的ホスティングなので、
 * 必要なファイルをすべて `dist/` に揃える。
 *
 * 出力:
 *   dist/index.html      … 画面
 *   dist/styles.css      … スタイル
 *   dist/app.js          … バンドル済み JS（sql.js を含む）
 *   dist/sql-wasm.wasm   … SQLite の WebAssembly
 *
 * 使い方:
 *   node scripts/build-web.ts           … 本番ビルド
 *   node scripts/build-web.ts --serve   … ビルドしてローカルサーバーを起動
 */

import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** リポジトリのルート。 */
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** 出力先。 */
const DIST = join(ROOT, "dist");
/** ソース。 */
const WEB_SRC = join(ROOT, "src", "web");

/** MIME タイプ（ローカルサーバー用）。 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** ビルドする。 */
async function buildWeb(): Promise<void> {
  // 前回の出力を消す（古いファイルが残ると Pages で混乱する）
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // --- JS をバンドル ---
  await build({
    entryPoints: [join(WEB_SRC, "app.ts")],
    bundle: true,
    format: "esm",
    target: ["es2022", "chrome100", "firefox100", "safari15"],
    outfile: join(DIST, "app.js"),
    minify: true,
    sourcemap: false,
    // sql.js は wasm を別ファイルとして読み込むので、Node 組み込みは使わない
    platform: "browser",
    logLevel: "warning",
  });

  // --- HTML / CSS をコピー ---
  await cp(join(WEB_SRC, "index.html"), join(DIST, "index.html"));
  await cp(join(WEB_SRC, "styles.css"), join(DIST, "styles.css"));

  // --- wasm をコピー ---
  // sql.js の wasm は node_modules にある。Pages では同じディレクトリから読む。
  const wasmSource = join(ROOT, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  await cp(wasmSource, join(DIST, "sql-wasm.wasm"));

  // --- .nojekyll ---
  // GitHub Pages の Jekyll 処理を無効にする（_ で始まるファイルが消されるのを防ぐ）
  await writeFile(join(DIST, ".nojekyll"), "", "utf8");

  // --- 出力サイズを報告 ---
  const files = ["index.html", "styles.css", "app.js", "sql-wasm.wasm"];
  const lines: string[] = [];
  for (const file of files) {
    const content = await readFile(join(DIST, file));
    const kb = (content.byteLength / 1024).toFixed(1);
    lines.push(`  ${file.padEnd(18)} ${kb.padStart(8)} KB`);
  }
  console.log("ビルドしました → dist/");
  console.log(lines.join("\n"));
}

/** ローカルで確認するための簡易サーバー。 */
function serve(port = 4173): void {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    // クエリ文字列を落とし、ディレクトリトラバーサルを防ぐ
    const pathname = decodeURIComponent(url.split("?")[0] ?? "/");
    const relative = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(DIST, relative);

    // dist の外に出ないことを保証する
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    try {
      const content = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
      res.end(content);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    }
  });

  server.listen(port, () => {
    console.log(`\nローカル確認: http://localhost:${port}/`);
    console.log("Ctrl+C で停止します。");
  });
}

// --- エントリポイント ---
const args = process.argv.slice(2);
await buildWeb();
if (args.includes("--serve")) {
  serve();
}
