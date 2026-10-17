# OpenCode 2.0 插件契约向后兼容 — 测试范围契约（rex-test-design）

现场证据（2026-10-17，opencode v2.0.32，本机 `~/.local/share/opencode/log/opencode.log`）：

```
level=WARN message="failed to load plugin" target=.../plugins/crg-plugin.ts
  cause="PluginModule.LoadError: Plugin must export a default definition with an id and an effect or setup function.
         (cause: SchemaError(Expected object at ["default"]))"
level=WARN ... target=.../plugins/rtk.ts            → SchemaError(Missing key at ["default"])
level=WARN ... target=@warp-dot-dev/opencode-warp   → SchemaError(Missing key at ["default"])
level=WARN ... target=<repo>/.opencode/plugins/aios-memory.ts → Die(ENOENT: no such file)
level=ERROR run=d592dc9f message="cli process failed"
  cause="Die(ServiceUnavailableError: Location plugins did not finish activating)" args=["models"]
```

v2 加载器（从二进制 `PluginModule.load` 反读）：`{ default: {id, effect|setup} }` 是唯一入口，
`effect` 走原生 API，`setup` 走兼容适配层（`"effect" in v ? v : vZ(v)`）。1.x 的具名导出
`export const X: Plugin = async (ctx) => ({ hooks })` 在 v2 完全不被读取。

基线：`node --test scripts/tests/clients/client-platform/codemap.test.mjs` → **15 pass / 0 fail**（改动前观察）。

---

## 范围契约

- **用户目标**：
  1. AIOS 生成的 opencode 插件在 **1.x 与 2.x 都能加载**（同一份文件，不分叉）。
  2. 已升到 2.0 的用户跑一次 `aios init` / `aios internal codemap install` 就**自愈**，不需要手工编辑 `~/.config/opencode/plugins/crg-plugin.ts`。
  3. 后续用户遇到同类不匹配时，`codemap doctor` 给出**结构化诊断 + 可执行修法**，而不是插件静默失效（RTK/CRG 停摆）或启动卡住。

- **明确非目标**：
  - 不迁移到 v2 原生 `effect`（Effect runtime + capability ctx，属独立设计决策，另开工作项）。
  - 不改 1.x 现有行为，不删除 1.x 具名导出。
  - 不在仓库里替用户修 `opencode.db` 5.4GB / 冷启动激活超时 / 远程 npm 插件解析（本机运维项，见"范围外行为"）。
  - 不承诺覆盖第三方插件（rtk.ts、opencode-warp）——只负责**检测并报告**，不改用户自有文件。

- **范围内行为**（可观察）：
  | # | 行为 | 公共入口 |
  | --- | --- | --- |
  | B1 | AIOS 管理插件源码满足 v2 契约且保留 1.x 入口 | `ensureOpencodePlugin(home)` 落盘内容 |
  | B2 | 对旧版（1.x-only）AIOS 插件文件重跑安装即 `updated` + 备份 | `ensureOpencodePlugin(home)` 返回值 |
  | B3 | 源码可被分类为 `ok` / `missing-default` / `default-not-object` / `default-missing-id` / `default-missing-handler` | `classifyOpenCodePluginSource(source)` |
  | B4 | doctor 对 home 内非 AIOS 管理的 1.x-only 插件给出点名告警 + 修法，且**只读** | `runCodemapDoctor(...)` 输出行 |
  | B5 | doctor 对配置里指向不存在文件的 `plugin[]` 条目报 ENOENT 风险 | 同上 |
  | B6 | 探测不到 opencode 版本时默认产出双导出（两边可跑） | `detectOpenCodeMajor()` 返回 `null` 分支 |

- **范围外行为**（明确不断言）：
  - 插件 hook 在 v2 会话中是否真被触发（需一次真实模型调用，列手工验收，不进单测）。
  - `ServiceUnavailableError: Location plugins did not finish activating` 的时序修复（opencode 侧竞态）。
  - `opencode.json` 中 MCP command 指向已清理临时目录的自愈——**同一现场的另一缺陷**，独立工作项（见待决 D2）。

- **允许修改的测试缝 / 文件**：
  - `scripts/lib/tooling/components/codemap/targets/opencode-plugin.mjs`（模板尾部导出形状）
  - `scripts/lib/clients/opencode/plugin-contract.mjs`（新增，拥有"插件模块契约"知识）
  - `scripts/lib/tooling/components/codemap/doctor/*`（B4/B5 探针挂载点，若归属另有文件则按实际目录）
  - `scripts/tests/clients/client-platform/codemap.test.mjs`（B1/B2 断言就地更新）
  - 新增 `scripts/tests/clients/opencode/plugin-contract.test.mjs`（B3/B6）
  - `scripts/lib/tooling/components/browser/mcp/mcp-migration.mjs`（B7 volatile-root 守卫）
  - `scripts/lib/tooling/components/browser/mcp/mcp-server-builders.mjs` + `runtime/runtime-paths.mjs`（B8 稳定 root）
  - `scripts/lib/foundation/interception/pipeline/*.mjs` / `scripts/lib/tooling/cli/dispatch/interception.mjs`（B9-B11 修复器与既有 `mcp-migrate` 面）
  - `scripts/tests/clients/browser-core/bsk-writer.test.mjs`（B12 显式 clientHomes）
  - 新增 `scripts/tests/clients/browser-core/mcp-path-repair.test.mjs`（B7-B11）
  - `.gitignore` + `git rm --cached opencode.json`（D1，已执行）

## 验收映射（一条行为 = 一个可观察断言）

| # | 验收行为 | 断言（不数内部调用次数） |
| --- | --- | --- |
| A1 | 新装 opencode 2.x 后 AIOS 插件仍能加载 | `classifyOpenCodePluginSource(ensureOpencodePlugin(home).path 内容)` → `{ok:true}`，且 `default.id==='code-review-graph'`、`typeof default.setup==='function'` |
| A2 | 同文件在 1.x 仍有效 | 源码含 `export const CodeReviewGraphPlugin: Plugin = async`，1.x 收集具名导出的入口未被移除 |
| A3 | 老用户重跑安装即修复 | 预置 1.x 模板旧内容 → `status:'updated'`，备份文件存在且内容等于旧版，新内容 `classify.ok===true` |
| A4 | 幂等 | 连续两次 `ensureOpencodePlugin` → 第二次 `status:'unchanged'` |
| A5 | 契约分类覆盖现场四种失败 | 对 `Missing key at ["default"]`（rtk.ts）、`Expected object`（当前 crg 模板）、对象缺 id、对象无 effect/setup 各一例，verdict 精确匹配 |
| A6 | doctor 报第三方插件不兼容但不改它 | home 放 `notCrg.js`（1.x-only）→ 输出含文件路径与 `setup` 修法提示；断言文件字节不变 |
| A7 | doctor 报悬挂 plugin 引用 | 配置 `plugin:['./.opencode/plugins/aios-memory.ts']` 且文件缺失 → 输出含 `missing plugin file`；文件存在 → `found` |
| A8 | 版本未知时安全兜底 | `detectOpenCodeMajor()` 无法执行/无法解析 → 返回 `null` 且不抛，`ensureOpencodePlugin` 仍产出双导出 |
| A9 | 用户自有非 CRG 文件不被覆盖（既有保护不回退） | `raw` 不含 code-review-graph → `status:'skipped'` |

## 最小纵向切片

**B3 + B1/A1/A5/A3/A4 先行**（同一批、独立可失败）：
契约分类器 + 模板双导出。理由：`classifyOpenCodePluginSource` 的 `ok` 就是 v2 加载器的
真实 schema 谓词；今天的模板喂进去必然得 `default-not-object`（与 log 里
`SchemaError(Expected object at ["default"])` 一致），因此这是**当前就能复现的诚实 RED**，
不需要真实 opencode 安装或模型调用即可观察。B4/B5（doctor）与 B6（版本探测）作为同批加固，
因为它们的失败模式（静默无提示 / 探测抛错）正是"后续用户再次踩坑"的路径。

## 禁止假通过条款

- 不得删掉 A2 的 1.x 断言来让 A1 通过（双导出是本工作项的契约本身，不是可选实现）。
- 不得用只断言字符串包含 `export default` 的正则代替 A1 的结构化 verdict——`export default CodeReviewGraphPlugin` 今天就存在且正是失败样本。
- 不得让 doctor 探针通过修改/删除用户插件来"变绿"。
- 不得把 A6/A7 的期望放宽成"有任何输出即可"。
- 不得跳过 hook 真触发验证就声称兼容完成：它降级为**手工验收 + 明确标注未覆盖**，见下。

## 完成判据（Definition of Done）

1. `node --test scripts/tests/clients/opencode/plugin-contract.test.mjs scripts/tests/clients/client-platform/codemap.test.mjs` 全绿（基线 15 → 15+N，0 fail）。
2. `npm run test:affected` 绿；声称完成前 `npm run test:regression`。
3. 手工验收（PR 里贴真实输出，不进 CI）：
   - `~/.config/opencode/plugins/crg-plugin.ts` 由新模板重生成后，`opencode models` 成功且
     `grep "failed to load plugin" ~/.local/share/opencode/log/opencode.log` 对该文件**无新条目**；
   - 一次 `opencode run` 真实会话确认 `tool.execute.before/after` hook 经 `setup` 兼容层仍触发（探针日志或 CRG `update` 副作用为证）。**此项未完成前只能声称"加载兼容"，不能声称"行为兼容"。**
4. diff 限定在"允许修改的测试缝"列出的路径。

## D1 决定（已执行，2026-10-17）

用户裁定：仓库根 `opencode.json` **不入库**。已按非破坏形状落地：

- `git rm --cached opencode.json`——文件仍在磁盘上，本机 dogfood 配置不丢；
- `.gitignore` 增 `opencode.json`，并改写原「root opencode.json stays tracked」注释。该注释的理由已不成立：没有任何测试读取入库的根文件，形状断言在 `scripts/tests/execution/team/ecc-uplift.test.mjs` 里对 `buildOpenCodeConfig` 于临时 rootDir 上完成；文件由 native 投影（`clients/native/distribution/emitters/opencode.mjs`）在 `aios init` 时按机器生成。

副作用：原「悬挂 plugin 引用」缺陷（`./.opencode/plugins/aios-memory.ts` 从未入库）不再分发给付费用户——降级为本机配置项，交给 D2 修复器清理。

## D2 根因（已复现，不是猜测）

`migrateBrowserMcpConfig` 在 `clientHomes` 未显式传入时回退 `getClientHomes(process.env, os.homedir())` = **真实用户 home**，而写进配置的绝对路径取自调用方的 `rootDir`。于是任何以临时 rootDir 发起的迁移，都会把临时路径写进真实 home 配置。测试「switch 到 bsk：落盘 + 产出 BSK 引导」正是用 `makeTemp('aios-bsk-switch-')` 当 rootDir 且不传 `clientHomes`。

隔离实验（把 home 重定向到沙箱后跑同一个测试文件）：

```bash
OPENCODE_HOME=/tmp/leakcheck node --test scripts/tests/clients/browser-core/bsk-writer.test.mjs
# 14 pass / 0 fail，但沙箱 home 被写脏：/tmp/leakcheck/opencode.json 出现
#   aios-bsk-switch-CUvSDR/scripts/auth-tools-server.py
#   aios-bsk-switch-CUvSDR/scripts/aios-mcp-proxy.mjs
#   aios-bsk-switch-CUvSDR/scripts/shell-mcp-server.mjs
```

即**跑测试套件就会污染真实客户端 MCP 配置**。这解释了「不同系统都会出现」：CI、其他开发者、任何跑 `test:regression` 的机器都中招；macOS/Linux 临时目录名不同（`/var/folders/...` vs `/tmp/...`），故障形状一样。本机 `~/.config/opencode/opencode.json` 里的 `aios-bsk-switch-pqlw9d` 就是这么进去的。

### D2 范围内行为

| # | 行为 | 公共入口 |
| --- | --- | --- |
| B7 | 用 volatile（`os.tmpdir()` 之下）的 AIOS root 发起迁移时，home 作用域**不写入**，返回结构化 `skipped:volatile-root` | `migrateBrowserMcpConfig({ rootDir, clientHomes })` |
| B8 | 落进配置的 AIOS 脚本路径来自稳定运行时 root（`AIOS_ROOT_DIR`/`AIOS_ROOT`/`AIOS_INSTALL_DIR` → 已安装 `~/.rexcil/aios`），而不是调用方 cwd | `resolveAiosRuntimeRoot()`（`environment/aios-init/hooks.mjs`，复用既有抽象） |
| B9 | 修复器把指向**已消失或 volatile**目录的 AIOS 托管条目重写为当前稳定 root，并原样保留用户自有条目 | `repairStaleAiosMcpPaths(...)` |
| B10 | 修复器默认 dry-run：产出变更清单不落盘；`--json` 逐文件报 before/after + 备份路径；**新增 `--client <name>` / `--only-stale` 范围控制**（现有 `mcp-migrate` 无条件写 16 个客户端配置，blast radius 太大） | `aios interception mcp-migrate [--dry-run] [--json]`（既有 CLI 面，扩展） |
| B11 | 修复器顺带清理 `plugin[]` 里指向不存在文件的条目，只报不猜 | 同上 |
| B12 | 泄漏测试自身不再触达真实 home（显式 `clientHomes`，B7 守卫作为第二道防线） | 测试文件 + B7 |

验收断言（一行为一断言）：

- A10：`rootDir` 在 `os.tmpdir()` 下且未传 `clientHomes` → home 配置文件**字节不变**，结果含 `reason:'volatile-root'`。
- A11：`AIOS_ROOT_DIR=/stable/aios` 下迁移 → 写出的 command 以 `/stable/aios/scripts/` 开头，且不含 `/tmp/`、`/var/folders/`。
- A12：预置污染配置（临时路径已不存在）+ 用户自有条目 → 修复后 AIOS 条目指向当前 root、自有条目 `deepEqual` 原值、`.bak-*` 存在、二次运行幂等（`changed:0`）。
- A13：`--dry-run` 不写文件（前后内容一致）且 JSON 报告列出将改项。
- A14：`plugin:['./missing.ts']` → 报告 `dropped`；不凭空创建文件。
- A15：以 `OPENCODE_HOME=<沙箱>` 跑既有测试文件，断言真实 home 配置字节不变（用断言锁死，不靠注释约定）。

### D2 非目标（再次明确）

- 不迁移到 v2 原生 `effect` 插件 API（Effect runtime + capability ctx，另开工作项）。
- 不处理 `opencode.db` 膨胀与冷启动 `Location plugins did not finish activating` 超时（opencode 侧竞态；仓库侧只做规避，插件预装与 db prune 属本机运维）。
- 不覆盖/删除用户自有插件文件（rtk.ts、opencode-warp）——只诊断。

---

## 实现状态与证据（2026-10-17）

| # | 落点 | 可观察证据 |
| --- | --- | --- |
| B1/B2/B3 | `codemap/targets/opencode-plugin.mjs` 模板尾部双导出 + 安装前分类自愈；`clients/opencode/plugin-contract.mjs` 分类器 | `scripts/tests/clients/opencode/plugin-contract.test.mjs` 12 pass；真机：`ensureOpencodePlugin('/Users/rex/.config/opencode')` → `updated`，旧文件判 `default-not-object`，备份 `crg-plugin.ts.bak-20261017-024611` |
| B4/B5 | `codemap/lifecycle/doctor.mjs` 新增 `checkDoctorOpencodePlugin`（插件契约 + 悬空 `plugin[]`）；`interception/pipeline/doctor.mjs` 新增 `collectPathHygiene` | doctor 测试断言输出含 `not loadable by 2.x (missing-default)`、`third-party, AIOS will not rewrite it`、`plugin entry points at a missing file`，且第三方文件字节不变；真机 `collectPathHygiene` 报 `crg-plugin.ts ok / rtk.ts missing-default(owned=false)` |
| B6 | `detectOpenCodeMajor()` 解析失败返回 `null`；`resolveOpenCodePluginCompat(null)` → 保守双导出 | `parse/detect` 测试：捕获抛错、命令不存在、`nonsense` 三种输入均返回 `null` 不抛 |
| B7 | `mcp-migration.mjs` 易失根守卫：源 rootDir 在易失根之下时，持久落点全部拒绝并返回 `skipped:[{reason:'volatile-root'}]` | 单测 + 真机实验：以 `mkdtemp` 根对真实 HOME 之下的持久沙箱发起迁移 → 9 个持久落点全 `refused`，持久 `opencode.json` 逐字节不变，临时落点照常写 7 个 |
| B8 | `foundation/platform/aios-runtime-root.mjs`：稳定根优先取非易失 `rootDir`，否则回落 `AIOS_ROOT_DIR/AIOS_ROOT/ROOTPATH/AIOS_INSTALL_DIR`，都没有 → `null` 让调用方 fail-closed | 单测：易失入参 + `AIOS_ROOT_DIR=/stable` → `{root:/stable, source:'AIOS_ROOT_DIR'}`；修复器写出的 AIOS 条目全部落在稳定根 |
| B9/B10/B11 | `mcp-path-repair.mjs` + `aios interception mcp-repair [--client <name>] [--fix] [--json]`（默认预览，`--fix` 才写盘；改前逐文件 `.bak-*`，只碰含 stale 的文件，用户自有条目原样，悬空 plugin 只报不建） | 单测：修复后 `aios-auth-tools/aios-shell/mcp-browser-use` 指向稳定根、`user-owned` deepEqual 原值、plugin 数组未动、备份等于修复前原文、二次运行 `stale=0/changed=0/字节不变` |
| B12 | `switchBrowserMcpMode` 增加 `clientHomes` 接缝；`bsk-writer.test.mjs` 传沙箱 homes | `bsk-writer.test.mjs` 14 pass；真机跑该测试文件后 `~/.config/opencode/opencode.json` 哈希不变 |

`git rm --cached opencode.json` + `.gitignore`（D1）已执行。

### 已完成的真机修复

- `~/.config/opencode/opencode.json` 等 9 个客户端配置的易失临时路径已由 `mcp-migrate`（稳定根 `/Users/rex/.rexcil/aios`）重生成，备份在 `/tmp/aios-mcp-repair-backup-20261017-103446/`。
- 残留一项不自动处理：`~/.codex/config.toml` 里用户自加的 `[projects."/var/folders/…/aios-token-discipline-native-root-U8ulA9"]` 信任段在 AIOS 托管块之外，属用户数据，只报告不删。

### 尚未闭环（诚实标注）

1. **hook 真触发未验证**：`opencode run` 三次尝试全部在模型侧失败（`Invalid rexai-openai/openai-responses stream event`、`OpenAI Chat stream ended without finish_reason`、`service_unavailable`），没有产生任何 tool 调用，因此 `tool.execute.before/after` 是否经 `setup` 兼容层触发仍无证据。**当前只能声称"加载兼容"，不能声称"行为兼容"。** 项目级探针 `/tmp/oct7/.opencode/plugins/hook_probe.ts`（双导出形状）已被 v2.0.32 无 WARN 加载，等可用模型端点即可闭环。
2. **付费用户拿到修复需要发版**：`~/.aios/bin/aios` 跑的是 `~/.rexcil/aios` 安装副本，`mcp-repair` 只在源码工作树里；需 commit + release + `aios update` 才对其他人生效。
3. **`aios interception mcp-repair` 需发版才对他机生效**：`~/.aios/bin/aios` 跑的是 `~/.rexcil/aios` 安装副本，本批代码只在源码工作树。本机修复已用工作树模块直接执行。
4. **冷启动竞态**（`Location plugins did not finish activating`）按 D2 非目标处理，未改。
