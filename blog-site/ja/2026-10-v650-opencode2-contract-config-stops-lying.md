---
title: "v6.5.0: OpenCode 2.x プラグイン契約と、AIOS の居場所を嘘つかなくなった設定"
description: "v6.5.0 が直すのは、コマンドラインに何もエラーを出さない故障のクラス：クライアントは動いているのに統合はすでに死んでいる。OpenCode 2.x は default エクスポートしか読まず { id, effect | setup } を要求するが、AIOS は 1.x 形式の named export を生成していた——プラグインは WARN 1 本だけで読み込まれず、CRG のグラフ更新と RTK のコマンド書換えは静黙停止。同じリリースでもう一つの汚染経路を閉じた：一時ディレクトリを根に走る処理が、そのパスを長期クライアント設定へ書き込み、テストスイート自身がその実行者だった。AIOS プラグインは 1.x/2.x デュアルエクスポートになり、インストール時に自己修復。aios interception mcp-repair は漂流したエントリを安定ランタイムルートへ戻す。両方の doctor はファイル名と所有者を実名で報告する。"
date: 2026-10-17
tags: ["AIOS", "v6.5.0", "opencode", "プラグイン", "mcp", "設定", "doctor", "リリース"]
---

# v6.5.0: OpenCode 2.x プラグイン契約と、AIOS の居場所を嘘つかなくなった設定

> **要約：** 二つの故障、同じ形。**システムは動き続けるが、統合はすでに死んでいる。** OpenCode 2.x のローダはモジュールの `default` エクスポートだけを読み `{ id, effect | setup }` を検証する。named export は参照されない。AIOS が生成していたのは 1.x 形式の named export だったため、`crg-plugin.ts` は WARN 1 本だけで読み込まれず、フックは一本も発火しない。もう一方は、一時ディレクトリを根とする操作が長期クライアント MCP 設定へその絶対パスを書き込み、OS がディレクトリを回収した後も設定は残り、クライアントは「インストール済みのまま永久に接続不能」。書き込み元になっていたのは **テストスイート** だった。AIOS プラグインは 1.x/2.x **デュアルエクスポート** になり、インストール時に旧ファイルを自己修復。`aios interception mcp-repair` は漂流エントリを安定ランタイムルートへ戻し、書き込み境界には volatile-root ガードが入り、両方の doctor はファイル名と所有者を実名で挙げる。

## プラグイン契約：2.x は一つのエクスポート、1.x はもう一方

現場の証拠は明確だった。

```
PluginModule.LoadError: Effect.SchemaError: Expected object at ["default"]
PluginModule.LoadError: Effect.SchemaError: Missing key at ["default"]
```

OpenCode 2.x は `default` のみを `{ id, effect | client | setup }` として検証し、named export を一切読まない。1.x は逆で、named export を走査し各 `(ctx) => Hooks` を採用する。つまり 1.x プラグインは 2.x でエラーにもならずに無効化し、誰も読まないログに WARN が残るだけ。止まっていたのは CRG のグラフ更新と RTK のコマンド書換え——そこが問題の本質。

修正は **デュアルエクスポート**。導入済みユーザーは同一バージョンではないためだ。

```ts
export const CodeReviewGraphPlugin = async (ctx) => { /* 1.x named export を維持 */ };
export const aiOSMemoryPlugin = async () => ({});
export default {
  id: 'code-review-graph',
  setup: CodeReviewGraphPlugin,   // 2.x はここを読む。setup は旧形状アダプタ
};
```

1 ファイルで両方のローダに通る。`ensureOpencodePlugin` は書き込み前に既存ファイルの形状を判定し、契約を満たさなければ `.bak-*` を残して書き直す。既存ユーザーは `aios init` / `codemap install` の再実行で自己修復し、障害に自分で気づく必要がない。

二つの境界を守った。`plugin-contract.mjs` が「このプラグインは読み込めるか」の単一判定源になり、verdict は 2.x の実際の失敗形（`missing-default` / `default-not-object` / `default-missing-id` / `default-missing-handler`）に一対一で対応する。 generic な「失敗」ではない。そしてサードパーティのファイルは **報告だけして書き換えない**：`rtk.ts` は `missing-default / owned=false` と判定され、1 バイトも触られず、報告に上流の直し方が出る。v2 ネイティブの `effect` API（Effect ランタイム、capability ctx、disposal scope）への移行は別决策で、このリリースには **含まない**。

このリリースが正直に言えるのは **ロード互換** まで：デュアルエクスポートのプローブは v2.0.32 で WARN なしに読み込まれる。言えないのは、実際の 2.x セッションで `tool.execute.before/after` が発火するか——今週期のプローブは全てモデル層で失敗し tool_call が 1 回も生成されなかったため、挙動互換は明示的に未クローズのまま残す。

## 汚染経路：`/tmp` から走った 1 回が、ホーム設定を永久に壊す

同じ病気の、別の臓器。`migrateBrowserMcpConfig` は `clientHomes` が注入されないとき **実ホーム** へフォールバックする一方、設定へ書く絶対パスは呼び出し元の `rootDir` から来る。一時ディレクトリから走らせると `/private/tmp/xxx/mcp-server/dist/index.js` が `~/.config/opencode/opencode.json` に入る。ディレクトリは回収されるが設定は残る——その MCP server は 2 度と起動しない。

居心地が悪いのは実行主：**テストスイート**だった。`mkdtemp` で作業コピーをmaterializeして実移行関数を呼ぶテスト 1 つで十分。macOS では `/var/folders/…`、Linux では `/tmp/…`、同じ失敗形で CI でも起きていた。

ガードは各呼び出し元ではなく **書き込み境界** に座る。

- 元ルートが volatile 配下のとき、永続先は全て拒否し、構造化された `skipped: [{ reason: 'volatile-root' }]` を返す；
- sandbox→sandbox は通す。通さないとテストが自分の sandbox を検証できない；
- 同じガードを **2 人目の書き手** `syncCodexHomeConfig` にも掛けた——`~/.codex/config.toml` の管理ブロック（trust エントリと `aios-memory`）はこっちが書く。移行器だけ守ると、そのファイル内の 5 本の stale パスが修復し残った。そうやって発覚した。

`switchBrowserMcpMode` に `clientHomes` の seam を追加し、漏洩していたテストは明示的に sandbox を渡す。ガードは二段構えで、テスト実行とホーム設定の間に立つ唯一の盾ではない状態にした。

## `mcp-repair`、そして先に直さなければならなかったテスト

`aios interception mcp-repair [--client <name>] [--fix] [--json]` は、回収済みパスへ漂流した AIOS 管理 MCP エントリを安定ランタイムルートへ戻す。既定はプレビュー、`--fix` で書き込み、ファイルごとに `.bak-*`、実際に stale を含むファイルだけを触り、ユーザー所有エントリはそのまま、`plugin[]` の存在しないファイル参照は **報告のみで生成しない**。

そのテストを書いて、CLI 側の欠陥が露呈した。既定値は `dryRun = !options.fix`。しかし「sandbox 化した `/tmp` のスキャンルート」が **既定のスキャンルート** を兼ねていると、「偽の stale 設定を置いてから `--fix` なしで CLI を実行する」テストは **実ホームへの実書き込み** を得る——harness は未注入時に `process.env` からクライアントホームを解決するから。最初の版のテストはまさにこれをやっていた。修正は `clientHomes` を sandbox の env からスキャン層まで通し、「未注入＝実ホームに触れない」を真にし、CLI テストを証拠にした。

小さな決定が 2 つ。安定ルートの解決順は固定——非 volatile な呼び出し元 `rootDir` → `AIOS_ROOT_DIR` / `AIOS_ROOT` / `ROOTPATH` / `AIOS_INSTALL_DIR` → `null`——そして `null` のときは **修復を拒否** する。`cwd` へフォールバックしない。ここで推測するのは新しい穴に設定を書くことだからだ。もう一つ、同一ファイルは 2 本の書込経路を持つ（`[mcp_servers.*]` は移行器、codex 管理ブロックは emitter）ため、片方だけでは修復漏れが出る。両方走らせる。

## 両方の doctor がファイル名を挙げる

`aios internal codemap doctor` はホーム内プラグインを 2.x 契約で一つずつ判定し、存在しないファイルを指す `plugin[]` エントリを報告する。

```
OK   opencode plugin contract ok: crg-plugin.ts
WARN opencode plugin not loadable by 2.x (missing-default): ~/.config/opencode/plugins/rtk.ts - third-party, AIOS will not rewrite it
```

`aios interception doctor` にはパス衛生のセクションが増えた：stale MCP パス、検出した OpenCode の major、プラグイン verdict と対処案。両方とも **読み取り専用**——診断がプラグインを書き換えることはない。AIOS 所有エントリは自己修復できる動作（`aios init` / `codemap install` 再実行）を指し、サードパーティは上流の直し方、または 1.x ピン提示を出す。

## 後片付け、そして配線が必須のテスト

リポジトリルートの `opencode.json` は git 管理から外した（`git rm --cached` + ignore）。`aios init` 時に機械ごとに生成される投影物で、コミットすれば 1 台の絶対パスを全員に配ることになる——まさに本リリースが別所で直す形そのもの。

新しいテストファイルは `scripts/test-suites.json` への登録が必須。未配線は黙って到達不能になるため、W2/W3/W5 のガードが最初のフル regression で 3 本を赤くして即座に証明した。

## 升级ノート

- 更新後に `aios init`（または `aios internal codemap install`）を再実行——2.x が読めなかった OpenCode プラグインファイルが `.bak-*` を残して自己修復する。
- まず `aios interception mcp-repair` でプレビュー、確認後に `--fix`。変更ファイルの隣にバックアップ、自分で追加したエントリは無傷。
- 一時チェックアウトから `aios doctor --fix` を走らせてもホームを汚さない。すでに設定へ失効パスが入り込んでいる場合、上記が処方。
- サードパーティ製プラグインは書き換えない。`rtk.ts` などが WARN を出すなら、doctor が所有者と直し方を出す。
- 本リリースに含まない：v2 ネイティブ `effect` API への移行。OpenCode 自体のコールドスタート競合（`Location plugins did not finish activating`）と `opencode.db` の肥大は上流／ホスト側の運用課題で、ここでは触っていない。
