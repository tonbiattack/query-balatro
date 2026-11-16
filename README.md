# Query Balatro（query-balatro）

Balatro系、クエリのパターンで役を作るスコアアタック。

> ステータス: **MVP実装中**（コアループ・CLIまで実装）

## コンセプト

ポーカー役の代わりにクエリのパターンで役を作る。断片カードを並べてクエリを組み、チップ×マルチでスコアを伸ばす。

## 遊び方

1. 手札8枚から断片カードを最大5枚並べてクエリ役を作る
2. スコア（チップ×マルチ）が計算される
3. 目標チップに届かなければ残りプレイ回数で再挑戦、ディスカードで手札を入れ替える
4. ブラインドを3つ（Small／Big／Boss）抜けるとアンティが上がる

## 仕様書

詳細は [docs/SPEC.md](docs/SPEC.md) を参照。

## クイックスタート

```powershell
npm install
npm start          # CLIでプレイ
npm test           # 全テスト
npm run typecheck  # 型チェック
npm run balance    # バランス検証（非対話）
```

### 操作方法

| コマンド | 動作 |
|---|---|
| `p 1 3 5` | 手札の1・3・5番目を並べてプレイ（最大5枚） |
| `d 2 4` | 2・4番目を捨てて引き直す |
| `h` | ヘルプ |
| `q` | 終了 |

## MVP範囲

- 1プレイ完結型の最小コアループのみ
- DBは SQLite（読み取り専用接続）
- オンライン対戦・ランキングは対象外

## 技術スタック

- 言語: TypeScript（Node.js のネイティブ型ストリッピングで直接実行。ビルド不要）
- 実行環境: Node.js 22.6 以上
- DB: SQLite（`node:sqlite`）
- UI: CLI（`node:readline/promises`）
- テスト: `node --test`
- 外部依存: なし

## モジュール構成

```
src/
  types.ts        共有型契約（全モジュールが依存する唯一の型定義）
  data/           断片・役・ジョーカー・Boss・アンティ・DBスキーマ
  db/             読み取り専用クエリ実行基盤（QueryEngine）
  logic/          役判定・スコア計算・ラン進行（RunController）
  cli/            対話UI
tests/            node:test
scripts/          バランス検証
```

依存方向は `types ← data ← db ← logic ← cli`。逆方向の import を禁止する。

## Issue方針

- #1 [Epic/仕様確定] MVP仕様を確定する
- #2 基盤（DB実行基盤）
- #3 ロジック（コアループ実装）
- #4 データ（生成）
- #5 UI/検証（最小UIとプレイ検証）

各Issueは「目的・やること・受け入れ条件・対象外」で管理する。
