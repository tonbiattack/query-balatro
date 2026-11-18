/**
 * logic モジュールの Node 専用窓口。
 *
 * `engine-provider.ts` は `node:module` の `createRequire` を使うため、
 * ブラウザ向けバンドルに含めてはいけない。CLI とテストだけがここを参照する。
 *
 * ブラウザは `./index.ts` と `src/db/browser-engine.ts` を使う。
 */

export { resolveDefaultEngine, resetDefaultEngine } from "./engine-provider.ts";
