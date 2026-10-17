/* 中文注释：OpenCode 插件模块契约（module contract）单一事实来源。
 *
 * 两个大版本的加载器形状不同，且**互不兼容**：
 *   1.x：遍历模块的具名导出，把每个 `async (ctx) => ({ hooks })` 函数当作插件。
 *   2.0：只校验 `default` 导出——`{ id, effect }` 或 `{ id, setup }`；
 *        其余一律 `PluginModule.LoadError: Plugin must export a default definition
 *        with an id and an effect or setup function.`（现场：`Missing key at ["default"]`
 *        与 `Expected object at ["default"]`），失败只降级成 WARN，插件静默停摆。
 *
 * 兼容形状 = 同时提供两者：保留 1.x 的具名导出，并把 default 写成 `{ id, setup }`
 * （`setup` 是 2.0 内部的旧形状适配入口）。2.0 原生 `effect` API（Effect runtime +
 * capability ctx）不在本模块范围，属独立迁移决策。
 *
 * 分类器是**源码结构检查**（不是 JS parser），用于安装期与 doctor 的告警判定；
 * 它只能断言"导出形状是否符合加载器 schema"，不能证明 hook 真被触发。
 */
import fs from 'node:fs';
import path from 'node:path';

import { captureCommand, commandExists } from '../../foundation/platform/process.mjs';

/** 2.0 起要求 default 导出的最低主版本。 */
export const OPENCODE_V2_PLUGIN_MAJOR = 2;

/** 分类结论：与 2.0 加载器的四种失败一一对应。 */
export const OPENCODE_PLUGIN_VERDICTS = Object.freeze([
  'ok',
  'missing-default',
  'default-not-object',
  'default-missing-id',
  'default-missing-handler',
]);

const DEFAULT_EXPORT_PATTERN = /export\s+default\s+/u;
const NAMED_PLUGIN_EXPORT_PATTERN = /export\s+(?:const|async\s+function|function)\s+([A-Za-z_$][\w$]*)\s*(?::\s*(?:Plugin|any)\b)?[^=]*=?\s*(?:async\s*)?(?:\(|function)/u;
const OBJECT_LITERAL_PREFIX = /\{\s*/u;
/* 中文注释：AIOS 自有插件的识别规则（单一事实来源）——只有这些文件允许被修复器重写。 */
export const AIOS_OWNED_PLUGIN_PATTERN = /code-review-graph|AIOS-generated/iu;
export function isAiosOwnedPluginSource(source) {
  return AIOS_OWNED_PLUGIN_PATTERN.test(String(source || ''));
}
const ID_KEY_PATTERN = /\b(?:id|name)\s*:/u;
const HANDLER_KEY_PATTERN = /\b(effect|setup|handler)\s*:/u;

/* 中文注释：把 `export default Identifier` 解引用到同文件里的对象字面量声明，
 * 这样 `export default CodeReviewGraphPlugin`（今天的失败样本）会被判成
 * default-not-object 而不是被误读成"缺 default"。 */
function resolveDefaultTail(source) {
  const match = DEFAULT_EXPORT_PATTERN.exec(source);
  if (!match) return { present: false, tail: '' };
  let tail = source.slice(match.index + match[0].length);
  const identifier = /^[A-Za-z_$][\w$]*/u.exec(tail.trim());
  if (identifier) {
    const declaration = new RegExp(
      `(?:const|let|var|function\\s+)${identifier[0]}\\b[^=]*=\\s*`,
      'u',
    );
    const declared = declaration.exec(source);
    if (declared) {
      tail = source.slice(declared.index + declared[0].length);
    } else {
      // 指向导入或其他模块的默认值：本模块无法判定形状，交调用方按 unknown 处理。
      return { present: true, tail: '', external: true };
    }
  }
  return { present: true, tail: tail.replace(/^[\s(]*as\b[\s\S]*/u, ''), external: false };
}

/**
 * 判定一份插件源码能否被 2.0 加载器接受。
 * @returns {{ok:boolean, verdict:string, detail:string, hasNamedPluginExport:boolean, resolvesExternally:boolean}}
 */
export function classifyOpenCodePluginSource(source) {
  const text = String(source || '');
  const hasNamedPluginExport = NAMED_PLUGIN_EXPORT_PATTERN.test(text);
  const resolved = resolveDefaultTail(text);

  if (!resolved.present) {
    return {
      ok: false,
      verdict: 'missing-default',
      detail: 'no `export default` found; OpenCode 2.x reads only the default export',
      hasNamedPluginExport,
      resolvesExternally: false,
    };
  }
  if (resolved.external) {
    return {
      ok: false,
      verdict: 'default-not-object',
      detail: '`export default` resolves to another module/identifier; shape cannot be verified',
      hasNamedPluginExport,
      resolvesExternally: true,
    };
  }
  if (!OBJECT_LITERAL_PREFIX.test(resolved.tail)) {
    return {
      ok: false,
      verdict: 'default-not-object',
      detail: '`export default` is not an object literal; OpenCode 2.x expects { id, effect | setup }',
      hasNamedPluginExport,
      resolvesExternally: false,
    };
  }
  if (!ID_KEY_PATTERN.test(resolved.tail)) {
    return {
      ok: false,
      verdict: 'default-missing-id',
      detail: 'default export object has no `id` key',
      hasNamedPluginExport,
      resolvesExternally: false,
    };
  }
  if (!HANDLER_KEY_PATTERN.test(resolved.tail)) {
    return {
      ok: false,
      verdict: 'default-missing-handler',
      detail: 'default export object needs an `effect` (2.x native) or `setup` (legacy-bridge) function',
      hasNamedPluginExport,
      resolvesExternally: false,
    };
  }
  return {
    ok: true,
    verdict: 'ok',
    detail: 'default export satisfies { id, effect | setup }',
    hasNamedPluginExport,
    resolvesExternally: false,
  };
}

/** 生成 1.x/2.x 通吃的尾部导出（2.x 走 setup 兼容层，1.x 忽略 default）。 */
export function buildDualExportTail({ id, legacyExport }) {
  const pluginId = String(id || '').trim();
  const exportName = String(legacyExport || '').trim();
  if (!pluginId || !exportName) throw new Error('buildDualExportTail requires { id, legacyExport }');
  return [
    '// OpenCode 2.x reads only the default export ({ id, setup }); 1.x collects named exports.',
    '// Export both so one file loads on either major version.',
    `export default { id: '${pluginId}', setup: ${exportName} };`,
    '',
  ].join('\n');
}

/** 探测到的主版本 → 该版本需要哪种导出形状（unknown 时一律双导出，B6 兜底）。 */
export function resolveOpenCodePluginCompat(major) {
  if (!Number.isFinite(major)) return { known: false, requiresDefaultExport: true, label: 'unknown' };
  if (major >= OPENCODE_V2_PLUGIN_MAJOR) return { known: true, requiresDefaultExport: true, label: 'v2' };
  return { known: true, requiresDefaultExport: false, label: 'v1' };
}

/**
 * 审计一个 opencode home 下可加载的插件源文件，给出 2.x 兼容性判定与处置建议。
 * 只读：AIOS 自有文件可自愈（由 codemap target 写回），第三方文件只报告 ——
 * 改别人的插件需要知道他们的 hook 语义，猜错只会把静默失败变成静默错行。
 */
export function auditOpenCodePlugins({ opencodeHome, fsImpl = fs, env = process.env, major = null } = {}) {
  const compat = resolveOpenCodePluginCompat(major);
  const pluginsDir = path.join(String(opencodeHome || ''), 'plugins');
  const findings = [];
  let entries = [];
  try {
    entries = fsImpl.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return { compat, pluginsDir, findings: [], broken: [], remediation: [], scanStatus: 'missing-dir' };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|js|mjs|cjs)$/u.test(entry.name)) continue;
    const file = path.join(pluginsDir, entry.name);
    let source = '';
    try {
      source = fsImpl.readFileSync(file, 'utf8');
    } catch (error) {
      findings.push({ file, name: entry.name, verdict: 'unreadable', ok: false, owned: false, detail: error?.message || String(error) });
      continue;
    }
    const verdict = classifyOpenCodePluginSource(source);
    findings.push({
      file,
      name: entry.name,
      verdict: verdict.verdict,
      ok: verdict.ok,
      detail: verdict.detail,
      owned: isAiosOwnedPluginSource(source),
    });
  }
  const broken = findings.filter((item) => !item.ok);
  return {
    compat,
    pluginsDir,
    findings,
    broken,
    scanStatus: 'ok',
    remediation: broken.map((item) => ({
      file: item.file,
      owned: item.owned,
      action: item.owned
        ? 'rerun `aios internal codemap install` (or `aios init`) — AIOS rewrites this file to the dual-export shape'
        : 'third-party plugin: report upstream to dual-export shape, or pin opencode to 1.x; AIOS will not rewrite it',
    })),
  };
}

/** 从 `opencode --version` 输出里取主版本号；解析失败返回 null（不抛）。 */
export function parseOpenCodeVersion(raw) {
  const text = String(raw || '').trim();
  const match = /(?:^|\s|v)V?(\d+)\.\d+/u.exec(text);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * 探测安装态 opencode 主版本。
 * @param {{capture?:Function, commandExists?:Function, bin?:string, env?:object}} runtime
 * @returns {number|null}
 */
export function detectOpenCodeMajor({ capture = captureCommand, exists = commandExists, bin = 'opencode', env = process.env } = {}) {
  const probe = String(env.OPENCODE_BIN || '').trim() || bin;
  try {
    if (typeof exists === 'function' && !exists(probe)) return null;
    const result = capture(probe, ['--version'], { env });
    const stdout = typeof result === 'string' ? result : (result?.stdout || '');
    return parseOpenCodeVersion(stdout);
  } catch {
    return null;
  }
}

/**
 * 列出 opencode 配置 `plugin[]` 里指向不存在文件的本地条目（只读判定，不创建文件）。
 * 远程包名（@scope/pkg）不做本地判定，一律保留。归本模块所有：它判的是 opencode 配置形状，
 * 不是浏览器 MCP 迁移。
 */
export function findDanglingOpenCodePluginEntries(configPath, { fsImpl = fs, existsSync = fs.existsSync } = {}) {
  const out = { file: configPath, dropped: [], kept: [] };
  let parsed;
  try {
    if (!existsSync(configPath)) return out;
    parsed = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
  } catch {
    return out;
  }
  const list = Array.isArray(parsed?.plugin) ? parsed.plugin : [];
  const check = typeof existsSync === 'function' ? existsSync : fs.existsSync;
  for (const entry of list) {
    const text = String(entry || '').trim();
    if (!/^\.{1,2}[\\/]/u.test(text) && !path.isAbsolute(text)) {
      out.kept.push(entry);
      continue;
    }
    const resolved = path.isAbsolute(text) ? text : path.resolve(path.dirname(configPath), text);
    if (check(resolved)) out.kept.push(entry);
    else out.dropped.push({ entry, resolved });
  }
  return out;
}

