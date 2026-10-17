import fs from 'node:fs';
import path from 'node:path';

import { backupFilePath, resolveUserPath } from '../paths.mjs';
import { buildDualExportTail, classifyOpenCodePluginSource, isAiosOwnedPluginSource } from '../../../../clients/opencode/plugin-contract.mjs';

/* 中文注释：CRG 插件的 OpenCode plugin id 与 1.x 具名导出名——导出形状由
 * clients/opencode/plugin-contract.mjs 统一生成，这里不手写 `export default`，
 * 否则契约知识会退回到分撒的字符串模板里（opencode 2.0 升级就是这么把插件弄坏的）。 */
const CRG_PLUGIN_ID = 'code-review-graph';
const CRG_LEGACY_EXPORT = 'CodeReviewGraphPlugin';

const OPENCODE_CRG_PLUGIN_BODY = `import type { Plugin } from "@opencode-ai/plugin"

const UPDATE_DELAY_MS = 3_000
const COMMAND_TIMEOUT_MS = 30_000

async function runCrg(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["uvx", "code-review-graph", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // The process may have already exited.
    }
  }, COMMAND_TIMEOUT_MS)

  try {
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ])
    return exitCode === 0 ? stdout.trim() : ""
  } catch {
    return ""
  } finally {
    clearTimeout(timer)
  }
}

export const ${CRG_LEGACY_EXPORT}: Plugin = async ({ directory }) => {
  let updateTimer: ReturnType<typeof setTimeout> | undefined
  let updateRunning = false
  let updatePending = false
  let disposed = false

  const runUpdate = async () => {
    if (disposed) return
    if (updateRunning) {
      updatePending = true
      return
    }

    updateRunning = true
    try {
      await runCrg(directory, ["update", "--skip-flows"])
    } finally {
      updateRunning = false
      if (updatePending && !disposed) {
        updatePending = false
        scheduleUpdate()
      }
    }
  }

  const scheduleUpdate = () => {
    if (disposed) return
    if (updateTimer) clearTimeout(updateTimer)
    updateTimer = setTimeout(() => {
      updateTimer = undefined
      void runUpdate()
    }, UPDATE_DELAY_MS)
  }

  return {
    "tool.execute.after": async (input) => {
      if (["edit", "write", "apply_patch"].includes(input.tool)) {
        scheduleUpdate()
      }
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const command = output.args?.command
      if (typeof command !== "string" || !/(^|[;&|]\\s*)git\\s+commit\\b/i.test(command)) return

      const result = await runCrg(directory, ["detect-changes", "--brief"])
      if (result) console.log("[code-review-graph] Pre-commit analysis:\\n" + result)
    },
    dispose: async () => {
      disposed = true
      if (updateTimer) clearTimeout(updateTimer)
    },
  }
}
`;

/* 中文注释：1.x 只遍历具名导出，2.x 只读 default。两者共存在同一文件里，
 * 所以一份模板同时兼容两个主版本，不需按探测结果分叉模板。 */
const OPENCODE_CRG_PLUGIN = `${OPENCODE_CRG_PLUGIN_BODY}${buildDualExportTail({
  id: CRG_PLUGIN_ID,
  legacyExport: CRG_LEGACY_EXPORT,
})}`;

export function ensureOpencodePlugin(opencodeHome, { dryRun = false, io = console } = {}) {
  const home = resolveUserPath(opencodeHome);
  if (!home) return { status: 'skipped' };
  const pluginPath = path.join(home, 'plugins', 'crg-plugin.ts');
  const exists = fs.existsSync(pluginPath);
  const raw = exists ? fs.readFileSync(pluginPath, 'utf8') : '';
  // 中文注释：先分类已存在的文件，安装输出就能说清有没有把 2.x 不兼容的旧插件修好，
  // 而不是只回报一个 updated。
  const before = exists ? classifyOpenCodePluginSource(raw) : null;
  if (raw === OPENCODE_CRG_PLUGIN) return { status: 'unchanged', path: pluginPath, contract: before?.verdict ?? 'ok' };
  if (exists && !isAiosOwnedPluginSource(raw)) {
    io.log(`[warn] opencode plugin exists and is not CRG-managed, skipping: ${pluginPath}`);
    return { status: 'skipped', path: pluginPath, contract: before?.verdict ?? 'unknown' };
  }
  if (before && !before.ok) {
    io.log(`[warn] opencode plugin not loadable by OpenCode 2.x (${before.verdict}): ${pluginPath}`);
    io.log('[hint] rewriting to the dual-export shape: named export for 1.x + default { id, setup } for 2.x');
  }
  if (dryRun) return { status: 'planned', path: pluginPath, contract: before?.verdict ?? 'new' };
  if (exists) {
    fs.writeFileSync(backupFilePath(pluginPath), raw, 'utf8');
  }
  fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
  fs.writeFileSync(pluginPath, OPENCODE_CRG_PLUGIN, 'utf8');
  return { status: exists ? 'updated' : 'created', path: pluginPath, contract: 'ok', previousContract: before?.verdict ?? null };
}

export function removeOpencodePlugin(opencodeHome, { dryRun = false, io = console } = {}) {
  const home = resolveUserPath(opencodeHome);
  if (!home) return { status: 'skipped' };
  const pluginPath = path.join(home, 'plugins', 'crg-plugin.ts');
  if (!fs.existsSync(pluginPath)) return { status: 'missing', path: pluginPath };
  const raw = fs.readFileSync(pluginPath, 'utf8');
  if (!isAiosOwnedPluginSource(raw)) {
    io.log(`[warn] opencode plugin is not CRG-managed, skipping: ${pluginPath}`);
    return { status: 'skipped', path: pluginPath };
  }
  if (dryRun) return { status: 'planned', path: pluginPath };
  fs.writeFileSync(backupFilePath(pluginPath), raw, 'utf8');
  fs.unlinkSync(pluginPath);
  return { status: 'removed', path: pluginPath };
}
