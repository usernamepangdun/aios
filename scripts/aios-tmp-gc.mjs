#!/usr/bin/env node
/**
 * scripts/aios-tmp-gc.mjs — 回收散落在工程父目录里的 mktemp 沙箱残留。
 *
 * 背景：会话内临时验证命令常用 `mktemp -d <前缀>-XXXXXX` 造假 HOME / npm pack 探针。
 * 不带 `-p` 时 mktemp 落在 shell 的 cwd；cwd 恰为工程父目录（如 ~/codes）时，探针
 * 就直接长进用户的项目列表，且没有任何 gitignore 能挡住。本工具只认「客观事实」
 * （名字形状 + 年龄 + git 状态 + 是否含凭据），不猜意图。
 *
 * 用法：
 *   node scripts/aios-tmp-gc.mjs [--root <dir>]... [--older-than <minutes>]
 *     [--mode dry-run|to-trash|purge] [--trash-dir <dir>] [--allow-secrets]
 *     [--allow-volatile-root] [--yes] [--json]
 *
 * 退出码：0 = 成功（含无可回收项）；1 = 参数或执行错误。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* 中文注释：mktemp 的 X 替换结果是 4-6 位 [A-Za-z0-9]；光看形状会误伤 `rex-work`、
 * `hermes-setup`、`wordpress-shens` 这类真实工程名（它们恰好也是 4-6 位小写词）。
 * 第二道条件要求后缀含大写或数字——mktemp 随机串几乎必中，英文词组必不中；
 * 万一碰上全小写随机串，代价只是「不回收」，属 fail-safe。 */
export const SANDBOX_SHAPE_RE = /-[A-Za-z0-9]{4,6}$/;
export const SANDBOX_RANDOM_RE = /-[A-Za-z0-9]*[A-Z0-9][A-Za-z0-9]*$/;

export function isSandboxName(name) {
  return SANDBOX_SHAPE_RE.test(name) && SANDBOX_RANDOM_RE.test(name);
}

/* 兼容旧引用：形状正则（不含随机性判别），仅供展示/外部复用。 */
export const SANDBOX_NAME_RE = SANDBOX_SHAPE_RE;
export const DEFAULT_OLDER_THAN_MINUTES = 60;

export function parseArgs(argv) {
  const options = {
    roots: [],
    olderThanMinutes: DEFAULT_OLDER_THAN_MINUTES,
    mode: 'dry-run',
    trashDir: null,
    allowSecrets: false,
    allowVolatileRoot: false,
    yes: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') { options.roots.push(argv[++i]); continue; }
    if (arg === '--older-than') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0) return { error: `invalid --older-than: ${argv[i]}` };
      options.olderThanMinutes = value;
      continue;
    }
    if (arg === '--mode') {
      const value = argv[++i];
      if (!['dry-run', 'to-trash', 'purge'].includes(value)) return { error: `invalid --mode: ${value}` };
      options.mode = value;
      continue;
    }
    if (arg === '--trash-dir') { options.trashDir = argv[++i]; continue; }
    if (arg === '--allow-secrets') { options.allowSecrets = true; continue; }
    if (arg === '--allow-volatile-root') { options.allowVolatileRoot = true; continue; }
    if (arg === '--yes') { options.yes = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--help' || arg === '-h') return { help: true };
    return { error: `unknown argument: ${arg}` };
  }
  /* 中文注释：purge 是真实 unlink，必须 --mode purge 与 --yes 两次显式声明，缺一即降级为预览。 */
  if (options.mode === 'purge' && !options.yes) {
    return { error: '--mode purge requires --yes (irreversible unlink)' };
  }
  return { options };
}

export function defaultRoots({ home = os.homedir(), tmpdir = os.tmpdir() } = {}) {
  const roots = [];
  const codes = path.join(home, 'codes');
  if (fs.existsSync(codes)) roots.push(codes);
  roots.push(tmpdir);
  return roots;
}

/* 中文注释：易失根（系统临时目录）里的随机名目录可能属于别的 app，默认拒绝，需显式放行。 */
export function isVolatileRoot(root, { tmpdir = os.tmpdir() } = {}) {
  return sameRealPath(root, tmpdir);
}

function sameRealPath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * 纯函数：把已采集的事实归类为 collect / keep，并给出可审计理由。
 * 顺序即优先级，第一个 keep 理由短路整个判定。
 */
export function classify(facts, policy = {}) {
  const {
    nowMs = Date.now(),
    olderThanMinutes = DEFAULT_OLDER_THAN_MINUTES,
    allowSecrets = false,
  } = policy;
  const reasons = [];
  if (!facts.isDirectory || facts.isSymlink) return keep(facts, ['not-a-plain-directory']);
  if (!isSandboxName(facts.name)) return keep(facts, ['name-not-sandbox-shaped']);
  const ageMinutes = (nowMs - facts.mtimeMs) / 60000;
  if (ageMinutes < olderThanMinutes) return keep(facts, [`too-young:${Math.round(ageMinutes)}m`]);
  if (facts.gitState === 'dirty') return keep(facts, ['uncommitted-work']);
  if (facts.gitState === 'unpushed') return keep(facts, ['unpushed-commits']);
  if (facts.gitState === 'stashed') return keep(facts, ['stash-present']);
  if (facts.gitState === 'unknown') return keep(facts, ['git-state-unreadable']);
  if (facts.hasSecrets && !allowSecrets) return keep(facts, ['secrets-present']);
  reasons.push(`sandbox-shaped age=${Math.round(ageMinutes)}m`);
  return { action: 'collect', name: facts.name, path: facts.path, reasons };
}

function keep(facts, reasons) {
  return { action: 'keep', name: facts.name, path: facts.path, reasons };
}

/**
 * 事实采集（唯一触碰文件系统的判定入口）。gitState 只在目录自身是仓库时求值：
 * dirty=有未提交改动，unpushed=有未推送提交，stashed=有 stash，clean=仓库干净，
 * none=不是仓库，unknown=是仓库但读不出来（fail-closed，绝不 collect）。
 */
export function probeFacts(dirPath, { gitRunner = runGit } = {}) {
  const st = fs.lstatSync(dirPath);
  const facts = {
    name: path.basename(dirPath),
    path: dirPath,
    isDirectory: st.isDirectory(),
    isSymlink: st.isSymbolicLink(),
    mtimeMs: st.mtimeMs,
    hasSecrets: false,
    gitState: 'none',
  };
  if (!facts.isDirectory || facts.isSymlink) return facts;
  facts.hasSecrets = findSecretFiles(dirPath);
  facts.gitState = gitRunner(dirPath);
  return facts;
}

function findSecretFiles(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .some((entry) => entry.isFile() && /^\.env\..*\.local$|^\.env$/i.test(entry.name));
  } catch {
    return false;
  }
}

function runGit(dirPath) {
  if (!fs.existsSync(path.join(dirPath, '.git'))) return 'none';
  try {
    if (execFileSync('git', ['-C', dirPath, 'stash', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) {
      return 'stashed';
    }
    if (execFileSync('git', ['-C', dirPath, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) {
      return 'dirty';
    }
    const ahead = execFileSync('git', ['-C', dirPath, 'rev-list', '--count', '@{u}..HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (Number(ahead) > 0) return 'unpushed';
    return 'clean';
  } catch {
    /* 中文注释：无 upstream 时 rev-list 会失败——这不代表脏，但状态读不出，按 unknown 保守保留。 */
    return 'unknown';
  }
}

export function scanRoots(roots, { olderThanMinutes, nowMs = Date.now() } = {}, { probe = probeFacts } = {}) {
  const collected = [];
  const kept = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      kept.push({ action: 'error', name: path.basename(root), path: root, reasons: [String(error.code || error.message)] });
      continue;
    }
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      const facts = probe(full);
      const verdict = classify(facts, { nowMs, olderThanMinutes });
      (verdict.action === 'collect' ? collected : kept).push({ ...verdict, root });
    }
  }
  return { collected, kept };
}

export function trashDirFor({ home = os.homedir(), now = new Date() } = {}) {
  const stamp = now.toISOString().slice(0, 10);
  return path.join(home, '.Trash', `aios-tmp-gc-${stamp}`);
}

export function execute(items, { mode, trashDir, move = fs.renameSync, remove = (p) => fs.rmSync(p, { recursive: true, force: false }) }) {
  const results = [];
  for (const item of items) {
    try {
      if (mode === 'to-trash') {
        fs.mkdirSync(trashDir, { recursive: true });
        move(item.path, path.join(trashDir, item.name));
      } else if (mode === 'purge') {
        remove(item.path);
      }
      results.push({ path: item.path, result: mode === 'dry-run' ? 'reported' : 'removed' });
    } catch (error) {
      results.push({ path: item.path, result: 'failed', error: String(error.message || error) });
    }
  }
  return results;
}

export function formatReport(report, { json = false } = {}) {
  if (json) return JSON.stringify(report, null, 2);
  const lines = [];
  lines.push(`collect=${report.collected.length}  keep=${report.kept.length}  mode=${report.mode}`);
  for (const item of report.collected) lines.push(`  - ${item.path}  [${item.reasons.join(',')}]`);
  const skipped = report.kept.filter((k) => k.reasons && !k.reasons.includes('name-not-sandbox-shaped'));
  for (const item of skipped) lines.push(`  ! ${item.name}  kept: ${item.reasons.join(',')}`);
  if (report.results) {
    for (const r of report.results) lines.push(`  ${r.result === 'failed' ? 'x' : '='} ${r.path} ${r.result}${r.error ? ' ' + r.error : ''}`);
  }
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write('usage: node scripts/aios-tmp-gc.mjs [--root <dir>]... [--older-than <min>] [--mode dry-run|to-trash|purge] [--trash-dir <dir>] [--allow-secrets] [--allow-volatile-root] [--yes] [--json]\n');
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`aios-tmp-gc: ${parsed.error}\n`);
    return 1;
  }
  const options = parsed.options;
  const roots = options.roots.length ? options.roots : defaultRoots();
  /* 中文注释：易失根（系统临时目录）默认整根剔除——里面随机名目录可能属于别的 app。 */
  const usableRoots = roots.filter((root) => {
    if (!isVolatileRoot(root)) return true;
    if (options.allowVolatileRoot) return true;
    process.stderr.write(`aios-tmp-gc: skipped volatile root ${root} (pass --allow-volatile-root to include)\n`);
    return false;
  });
  if (usableRoots.length === 0) {
    process.stderr.write('aios-tmp-gc: no usable roots\n');
    return 1;
  }
  const { collected, kept } = scanRoots(usableRoots, { olderThanMinutes: options.olderThanMinutes });
  const report = {
    mode: options.mode,
    roots: usableRoots,
    olderThanMinutes: options.olderThanMinutes,
    collected: collected.map(({ root, ...item }) => item),
    kept: kept.map(({ root, ...item }) => item),
  };
  if (options.mode !== 'dry-run') {
    report.results = execute(report.collected, { mode: options.mode, trashDir: options.trashDir || trashDirFor() });
    report.removed = report.results.filter((r) => r.result === 'removed').length;
  }
  process.stdout.write(`${formatReport(report, { json: options.json })}\n`);
  const failed = (report.results || []).some((r) => r.result === 'failed');
  return failed ? 1 : 0;
}

/* 中文注释：被直接执行时进入 CLI；被测试 import 时只导出纯函数。 */
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (invokedDirectly) process.exitCode = main();
