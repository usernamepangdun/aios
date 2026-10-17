---
title: "v6.5.0：OpenCode 2.x 插件契约，以及那份不再谎报 AIOS 位置的配置"
description: "v6.5.0 修的是一类在你的命令行上看不到报错的故障：客户端还在，集成已经死了。OpenCode 2.x 只读 default 导出且要求 { id, effect | setup }，而 AIOS 生成的是 1.x 具名导出——插件加载失败只剩一条 WARN，CRG 图谱更新和 RTK 命令重写静默停摆。同一版本关掉另一条污染路径：以临时目录为根的调用会把临时路径写进长期客户端配置，而测试套件本身就是这样的调用方。AIOS 插件改为 1.x/2.x 双导出并在安装期自愈；aios interception mcp-repair 把漂移条目重指到稳定运行时根；易失根守卫在写入边界拒写；两个 doctor 开始点名文件和归属。"
date: 2026-10-17
tags: ["AIOS", "v6.5.0", "opencode", "插件", "mcp", "配置", "doctor", "发布"]
---

# v6.5.0：OpenCode 2.x 插件契约，以及那份不再谎报 AIOS 位置的配置

> **一句话：** 两个故障共享同一个形状——**系统照常运行，但集成已经死了**。OpenCode 2.x 加载器只读模块的 `default` 导出并校验 `{ id, effect | setup }`，AIOS 生成的是 1.x 具名导出，于是 `crg-plugin.ts` 加载失败只留一条 WARN：插件静默停摆。另一条是同一种病：任何以临时目录为根的调用，都会把临时路径写进长期存在的客户端 MCP 配置，目录被系统回收后客户端「装着但永远连不上」。触发它的正是测试套件。现在插件产出 1.x/2.x **双导出**、旧文件安装期自愈；`aios interception mcp-repair` 把漂移条目重指稳定根；写入边界加了易失根守卫；两个 doctor 会点名是哪个文件、归谁管。

## 插件契约：2.x 读一个导出，1.x 读另一个

现场证据很直接：

```
PluginModule.LoadError: Effect.SchemaError: Expected object at ["default"]
PluginModule.LoadError: Effect.SchemaError: Missing key at ["default"]
```

OpenCode 2.x 只取模块的 `default` 导出并按 `{ id, effect | client | setup }` 校验，**具名导出根本不读**；1.x 恰好相反，遍历具名导出，每个都是 `(ctx) => Hooks`。所以 1.x 插件在 2.x 下既不报错也不生效，只在没人看的日志里留一条 WARN。停摆的是 CRG 图谱更新与 RTK 命令重写——这才是重点。

修复选择**双导出**，因为存量用户不是同一个版本：

```ts
export const CodeReviewGraphPlugin = async (ctx) => { /* 保留 1.x 具名导出 */ };
export const aiOSMemoryPlugin = async () => ({});
export default {
  id: 'code-review-graph',
  setup: CodeReviewGraphPlugin,   // 2.x 读这里，setup 是它的旧形状适配入口
};
```

一份文件两边都能加载。`ensureOpencodePlugin` 写盘前先判定旧文件形状，不合格就留 `.bak-*` 再重写——老用户重跑 `aios init` / `codemap install` 即自愈，不用自己发现问题。

两条边界守住了。`plugin-contract.mjs` 成为「插件能不能加载」的唯一判定源，verdict 与 2.x 真实失败形状一一对应（`missing-default / default-not-object / default-missing-id / default-missing-handler`），而不是一句「失败」。第三方文件**只报告不改写**：`rtk.ts` 被判 `missing-default / owned=false`，逐字节不动，报告里给出上游修法。迁移到 2.x 原生 `effect` API（Effect runtime、capability ctx、disposal scope）是独立决策，本批**不做**。

本批能诚实声称的是**加载兼容**：双导出探针在 v2.0.32 下无 WARN 被加载。不能声称的是 hook 在真实 2.x 会话里被触发——本轮所有 `opencode run` 探针都在模型层失败，一次 tool 调用都没产生，行为兼容仍明确标注未闭环。

## 污染路径：一次来自 `/tmp` 的运行，家目录里永久损坏

同一种病，另一个器官。`migrateBrowserMcpConfig` 在调用方不注入 `clientHomes` 时回退**真实家目录**，而写进配置的绝对路径取自调用方的 `rootDir`。从临时目录跑一次，`/private/tmp/xxx/mcp-server/dist/index.js` 就进了 `~/.config/opencode/opencode.json`。临时目录会被回收，配置不会——那个 MCP server 再也起不来。

让人不舒服的是触发者：**是测试套件**。一个用 `mkdtemp` 物化工作副本、再调用真实迁移函数的测试就够了。macOS 上是 `/var/folders/…`，Linux 上是 `/tmp/…`，故障形状相同，CI 同样中招。

守卫落在写入边界，而不是每个调用方里：

- 源根位于易失目录之下时，持久落点一律拒绝，并返回结构化 `skipped: [{ reason: 'volatile-root' }]`；
- 沙箱→沙箱照旧放行，否则测试无法验证自己的沙箱；
- 同一道守卫挂到**第二个**写入者 `syncCodexHomeConfig`——它写 `~/.codex/config.toml` 的托管段（trust 表 + `aios-memory`）。只守迁移器时，该文件里 5 条 stale 路径修不掉，我们就是这样发现的。

`switchBrowserMcpMode` 新增 `clientHomes` 接缝，泄漏源头的那个测试改为显式传沙箱：守卫是双保险，不是唯一挡在测试运行与你家目录之间的东西。

## `mcp-repair`，以及我必须先修的测试

`aios interception mcp-repair [--client <name>] [--fix] [--json]` 把漂到已回收路径的 AIOS 托管条目重指到稳定运行时根。默认预览，`--fix` 才写盘，逐文件留 `.bak-*`，只碰确实含 stale 的文件，用户自有条目原样保留，`plugin[]` 里指向不存在文件的条目**只报不建**（不替用户造文件）。

写它的测试时暴露了 CLI 的缺陷。默认值现在是 `dryRun = !options.fix`。但如果「沙箱化的 `/tmp` 扫描根」同时又是**默认**扫描根，那么一个「种一份假 stale 配置、然后不带 `--fix` 跑 CLI」的测试，会得到一次**对家目录的真实写入**——因为 harness 在没有注入时会从 `process.env` 解析客户端家目录。我的第一版断言正是这样。修法是把 `clientHomes` 从沙箱环境变量一路穿到扫描层，让「不注入」真正等于「不碰真实家目录」，并以 CLI 测试作为证据。

两个小决策：稳定根按固定顺序解析——非易失的调用方 `rootDir` → `AIOS_ROOT_DIR` / `AIOS_ROOT` / `ROOTPATH` / `AIOS_INSTALL_DIR` → `null`；解析为 `null` 时**拒绝修复**而不是退回 `cwd`，在这里猜就是把配置写进新的坑。另外同一个文件有两条写路径（`[mcp_servers.*]` 归迁移器、codex 托管块归 emitter），只走一条会漏修，所以两条都跑。

## 两个 doctor 开始点名文件

`aios internal codemap doctor` 逐个判定家目录内插件是否满足 2.x 契约，并报告 `plugin[]` 中指向不存在文件的条目：

```
OK   opencode plugin contract ok: crg-plugin.ts
WARN opencode plugin not loadable by 2.x (missing-default): ~/.config/opencode/plugins/rtk.ts - third-party, AIOS will not rewrite it
```

`aios interception doctor` 新增路径卫生段：stale MCP 路径、探测到的 OpenCode 主版本、插件 verdict 与逐项处置建议。两者**只读**——诊断绝不改写插件文件。AIOS 自有项指向可自愈动作（重跑 `aios init` / `codemap install`），第三方项给出上游修法或建议钉 1.x。

## 收尾，以及必须接线的测试

仓库根 `opencode.json` 出库（`git rm --cached` + 忽略规则）。它是 `aios init` 期间由原生 emitter 按机器生成的投影产物，入库等于把一台机器的绝对路径分发给所有人——正是本批在别处修的那个形状。

新测试文件必须登记进 `scripts/test-suites.json`，否则静默不可达；接线守卫（W2/W3/W5）在第一次全量回归为此红了三条时立刻证明了这点。

## 升级说明

- 更新后重跑 `aios init`（或 `aios internal codemap install`）——2.x 加载不了的 OpenCode 插件文件会自愈并留 `.bak-*`。
- 先 `aios interception mcp-repair` 预览，确认后加 `--fix` 应用；每个被改文件旁边都有备份，你自己加的条目不受影响。
- 从临时检出的工作树跑 `aios doctor --fix` 不再污染家目录；若你的配置已经带上了失效路径，上面那条命令就是解法。
- 第三方插件永不被改写。若 `rtk.ts` 之类报 WARN，doctor 会给出归属和修法。
- 本批不含：2.x 原生 `effect` API 迁移；opencode 自身的冷启动竞态（`Location plugins did not finish activating`）与 `opencode.db` 膨胀属上游/本机运维，未改动。
