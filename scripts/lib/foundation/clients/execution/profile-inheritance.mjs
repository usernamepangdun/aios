/* 中文注释：provider 配置继承——让 harness/team 启动的子 agent 跟随当前会话的 profile。
 *
 * 背景：Claude Code 的 --settings 属于 flagSettings，优先级高于 userSettings
 * （~/.claude/settings.json）；只依赖进程环境变量会被 userSettings 的 env 覆盖。
 * 因此 AIOS 重新拼装子进程命令时，必须显式转发 --settings <绝对路径>。
 *
 * 解析优先级（由调用方决定何时调用）：
 * 1. 显式传入的 providerSettings（run/resume 已持久化的值）；
 * 2. 最近的 claude 祖先进程 argv 中最后一个 --settings；
 * 3. AIOS_CLAUDE_SETTINGS 环境变量（由启动器显式设置的 marker）。
 *
 * 找到 claude 祖先但未带 --settings 时，视为「当前会话无 profile」，
 * 不再回退 marker，避免内层 cla 误继承外层 claudedp1 的配置。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CLAUDE_SETTINGS_ENV = 'AIOS_CLAUDE_SETTINGS';

const CLAUDE_COMMAND_RE = /^(?:.*\/)?claude(?:\.exe)?$/u;

/* 中文注释：解析 --settings 参数，支持 "--settings path" 与 "--settings=path"；
 * Claude Code 对重复参数取最后一个，这里保持一致。 */
export function extractSettingsPath(argv = []) {
  let found = '';
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? '');
    if (token === '--settings') {
      const next = String(argv[index + 1] ?? '');
      if (next && !next.startsWith('-')) {
        found = next;
        index += 1;
      }
    } else if (token.startsWith('--settings=')) {
      found = token.slice('--settings='.length);
    }
  }
  return found;
}

/* 中文注释：只接受真实存在的文件路径；inline JSON（含 { 或换行）直接拒绝，
 * 避免把可能携带 token 的内容写进 argv 与 journal。 */
export function normalizeSettingsPath(value, { cwd = process.cwd() } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.includes('{') || text.includes('\n')) return '';
  const resolved = path.isAbsolute(text) ? text : path.resolve(cwd, text);
  try {
    return fs.statSync(resolved).isFile() ? resolved : '';
  } catch {
    return '';
  }
}

function readProcessTable() {
  if (process.platform === 'win32') return '';
  try {
    return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function parseProcessTable(table = '') {
  const byPid = new Map();
  for (const line of String(table || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u);
    if (!match) continue;
    const pid = Number(match[1]);
    byPid.set(pid, { pid, ppid: Number(match[2]), command: match[3] });
  }
  return byPid;
}

/* 中文注释：ps 以空白连接 argv；AIOS 只接受无空格的 profile 绝对路径，
 * 因此这里按空白切分足够可靠。 */
function argvFromCommand(command = '') {
  return String(command || '').split(/\s+/u).filter(Boolean);
}

function isClaudeCommand(command = '') {
  const [head] = argvFromCommand(command);
  if (!head) return false;
  return CLAUDE_COMMAND_RE.test(head) || CLAUDE_COMMAND_RE.test(path.basename(head));
}

/* 中文注释：从当前进程向上遍历，找到最近的一个 claude 祖先进程即停止；
 * 即使它不带 --settings 也返回 found=true，表示「当前会话已确定无 profile」。 */
export function findClaudeAncestor({ pid = process.pid, processTable = null, platform = process.platform } = {}) {
  if (platform === 'win32') return { found: false, settingsPath: '', ancestorPid: null };
  const byPid = parseProcessTable(processTable ?? readProcessTable());
  if (byPid.size === 0) return { found: false, settingsPath: '', ancestorPid: null };

  let currentPid = Number(pid);
  const visited = new Set();
  while (currentPid && byPid.has(currentPid) && !visited.has(currentPid)) {
    visited.add(currentPid);
    const entry = byPid.get(currentPid);
    if (isClaudeCommand(entry.command)) {
      const settingsPath = normalizeSettingsPath(extractSettingsPath(argvFromCommand(entry.command)));
      return { found: true, settingsPath, ancestorPid: entry.pid };
    }
    currentPid = entry.ppid;
  }
  return { found: false, settingsPath: '', ancestorPid: null };
}

export function resolveInheritedClaudeSettings({
  env = process.env,
  pid = process.pid,
  processTable = null,
  platform = process.platform,
} = {}) {
  const ancestor = findClaudeAncestor({ pid, processTable, platform });
  if (ancestor.found) {
    return {
      settingsPath: ancestor.settingsPath,
      source: ancestor.settingsPath ? 'ancestor-argv' : 'ancestor-no-settings',
      ancestorPid: ancestor.ancestorPid,
    };
  }
  const marker = normalizeSettingsPath(env?.[CLAUDE_SETTINGS_ENV]);
  return {
    settingsPath: marker,
    source: marker ? 'env-marker' : 'none',
    ancestorPid: null,
  };
}

export function buildClaudeSettingsArgs(options = {}) {
  const { settingsPath } = resolveInheritedClaudeSettings(options);
  return settingsPath ? ['--settings', settingsPath] : [];
}
