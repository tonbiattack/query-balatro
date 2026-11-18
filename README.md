# Query Balatro（query-balatro）

Balatro系、クエリのパターンで役を作るスコアアタック。

> ステータス: **MVP完成**（CLI + Web UI）

## ブラウザで遊ぶ

**https://tonbiattack.github.io/query-balatro/**

インストール・ログイン不要。PC・スマホのブラウザで開くだけで遊べます。

## コンセプト

ポーカー役の代わりにクエリのパターンで役を作る。断片カードを並べてクエリを組み、チップ×マルチでスコアを伸ばす。

## 遊び方

1. 手札8枚から断片カードを最大5枚並べてクエリ役を作る
2. スコア（チップ×マルチ）が計算される
3. 目標チップに届かなければ残りプレイ回数で再挑戦、ディスカードで手札を入れ替える
4. ブラインドを3つ（Small／Big／Boss）抜けるとアンティが上がる
5. アンティ8のBossを突破すればクリア

### 役（強い順）

| 役 | 条件 | マルチ |
|---|---|---|
| ロイヤル相当 | JOIN + WINDOW + GROUP BY | ×10 |
| フルハウス相当 | WINDOW を含む | ×6 |
| ストレート相当 | JOIN を含む | ×4 |
| フラッシュ相当 | BETWEEN か IN を含む | ×3 |
| ツーペア相当 | LIKE を含む | ×2.5 |
| ペア相当 | WHERE を含む | ×2 |
| ハイカード相当 | 1行以上返った | ×1 |

## 仕様書

詳細は [docs/SPEC.md](docs/SPEC.md)、バランスの根拠は [docs/BALANCE.md](docs/BALANCE.md) を参照。

## 2つの遊び方

同じゲームロジックを CLI と Web の両方から使えます。**計算結果は自動テストで一致を保証**しています。

| | Web UI | CLI |
|---|---|---|
| 起動 | ブラウザでURLを開く | `npm start` |
| 操作 | カードをクリック／タップ | コマンド入力 |
| 向いている場面 | 初めて遊ぶ、スマホで遊ぶ | キーボードで速く打ちたい |

### Web UI の操作

| 操作 | 動作 |
|---|---|
| カードをクリック／タップ | 選択・解除（選択順に番号が付く） |
| プレイ | 選んだ断片でクエリを実行 |
| ディスカード | 選んだ断片を捨てて引き直す |
| えらび直す | 選択をすべて解除 |
| `Enter` | プレイ |
| `Esc` | 選択を解除 |
| `Backspace` | 最後に選んだ1枚を戻す |

選んだ瞬間に、組み上がる SQL・成立する役・予想スコア・効いているジョーカーが更新されます。

### CLI の操作

```powershell
npm install
npm start
```

| コマンド | 動作 |
|---|---|
| `p 1 3 5` | 手札の1・3・5番目を並べてプレイ（最大5枚） |
| `d 2 4` | 2・4番目を捨てて引き直す |
| `h` | ヘルプ |
| `q` | 終了 |

## 開発

```powershell
npm install
npm test              # 全テスト（266件）
npm run typecheck     # 型チェック（Node + Web の両方）
npm run balance       # バランス検証（非対話・40ラン）
npm run build:web     # Web UI を dist/ にビルド
npm run serve:web     # ビルドして http://localhost:4173/ で確認
```

### 構成

```
src/
  types.ts        共有型契約（全モジュールが依存する唯一の型定義）
  data/           断片・役・ジョーカー・Boss・アンティ・DBスキーマ
  db/
    build.ts        SQL 組み立て（Node/Web 共通）
    validate.ts     実行前検証・Boss妨害・結果集計（Node/Web 共通）
    engine.ts       Node 版エンジン（node:sqlite）
    browser-engine.ts  Web 版エンジン（sql.js / WebAssembly）
  logic/          役判定・スコア計算・ラン進行（RunController）
    index.ts        ブラウザでも安全な公開窓口
    node.ts         Node 専用の公開窓口（既定エンジンの遅延解決）
  cli/            CLI の入出力
  web/            Web UI（DOM 層・状態管理・プレビュー）
tests/            node:test
scripts/
  balance.ts      バランス検証
  build-web.ts    Web ビルド
```

依存方向は `types ← data ← db ← logic ← cli/web`。逆方向の import を禁止する。

### 技術スタック

| 項目 | CLI | Web |
|---|---|---|
| 言語 | TypeScript | TypeScript |
| 実行 | Node.js 22.6+（型ストリッピングで直接実行） | ブラウザ |
| DB | `node:sqlite` | `sql.js`（WebAssembly 版 SQLite） |
| UI | `node:readline/promises` | DOM + CSS |
| ビルド | 不要 | esbuild |

**ゲームロジックは共通**で、違うのは「SQLite をどう動かすか」と「どう表示するか」だけです。

### なぜ sql.js なのか

`node:sqlite` はブラウザで動きません。`sql.js` は SQLite を WebAssembly にコンパイルしたもので、
ブラウザでも Node でも同じ SQLite エンジンとして動きます。

両エンジンの結果が一致することは `tests/browser-engine.test.ts` で検証しています
（全断片の単体・2枚の全組み合わせ・Boss妨害・取得上限・スコア内訳・ラン進行）。

### デプロイ

`main` に push すると GitHub Actions が自動でビルドして GitHub Pages へ公開します
（`.github/workflows/deploy-web.yml`）。

テストと型チェックが通らない場合はデプロイされません。

## MVP範囲

- 1プレイ完結型のコアループ
- DBは SQLite（読み取り専用）
- オンライン対戦・ランキングは対象外

## Issue方針

- #1 [Epic/仕様確定] MVP仕様を確定する
- #2 基盤（DB実行基盤）
- #3 ロジック（コアループ実装）
- #4 データ（生成）
- #5 UI/検証（最小UIとプレイ検証）
- #7 UX改善（高速Web UI）
- #8 Web対応（GitHub Pages公開）

各Issueは「目的・やること・受け入れ条件・対象外」で管理する。
