import fs from 'node:fs';
import path from 'node:path';

import { commandExists } from '../../../../foundation/platform/process.mjs';

import { AGENTS_MD_MARKERS, CRG_DATA_DIR, CRG_MCP_ALIAS } from '../constants.mjs';
import { captureCrgCommand } from '../graph/crg.mjs';
import { resolveClientHomes } from '../targets/environment.mjs';
import { inspectGraphFreshness } from '../graph/freshness.mjs';
import { collectCodemapInstructionFiles, inspectCodemapInstructionMarkers } from '../targets/instructions.mjs';
import { installCodemap } from './install.mjs';
import { collectCodemapMcpTargets, inspectCodemapMcpTarget } from '../targets/mcp-targets.mjs';
import { auditOpenCodePlugins, detectOpenCodeMajor, findDanglingOpenCodePluginEntries } from '../../../../clients/opencode/plugin-contract.mjs';
import { normalizeClientList } from '../targets/selection.mjs';
import { readState, stateFilePath } from '../state-store.mjs';

/**
 * claude 的 MCP 是否被**项目级本地设置**禁用。
 *
 * Claude Code 有两层开关：user 级 `~/.claude.json` 的 mcpServers 决定“注册了没有”，
 * 项目级 `.claude/settings.local.json` 的 disabledMcpjsonServers 决定“启不启用”。
 * `doctor --fix` 只走 installCodemap（写 user 级），**不碰** disabledMcpjsonServers
 * —— 于是出现「doctor 报 OK，实际仍被禁用」这种最难查的状态。这里显式报告它。
 */
function inspectClaudeDisabledServers(projectRootPath, { fsImpl = fs } = {}) {
  const settingsPath = path.join(projectRootPath, '.claude', 'settings.local.json');
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(settingsPath, 'utf8'));
    const disabled = Array.isArray(parsed?.disabledMcpjsonServers) ? parsed.disabledMcpjsonServers : [];
    return { settingsPath, disabled, disablesCrg: disabled.includes(CRG_MCP_ALIAS) };
  } catch {
    return { settingsPath, disabled: [], disablesCrg: false };
  }
}

function createDoctorCounters(io) {
  let effectiveWarnings = 0;
  let errors = 0;
  return {
    ok: (msg) => io.log(`OK   ${msg}`),
    warn: (msg) => {
      effectiveWarnings += 1;
      io.log(`WARN ${msg}`);
    },
    err: (msg) => {
      errors += 1;
      io.log(`ERR  ${msg}`);
    },
    snapshot: () => ({ effectiveWarnings, errors }),
  };
}

function checkDoctorRuntime({ projectRootPath, skipCrgChecks, statusText, crgVersion, io, counters, graphFreshness }) {
  io.log('[1/7] Checking uv in PATH');
  if (skipCrgChecks) counters.ok('uv check skipped (test override)');
  else if (commandExists('uv')) counters.ok('uv found');
  else counters.err('uv not found in PATH');

  io.log('[2/7] Checking code-review-graph via uvx');
  if (skipCrgChecks) counters.ok(`code-review-graph check skipped${crgVersion ? `: ${crgVersion}` : ''}`);
  else if (commandExists('uvx')) {
    const versionResult = captureCrgCommand(['--version'], { cwd: projectRootPath });
    if (versionResult) counters.ok(`code-review-graph available: ${versionResult.stdout.trim()}`);
    else counters.err('code-review-graph --version failed');
  } else counters.err('uvx not found in PATH');

  io.log('[3/7] Checking graph data directory');
  const crgDataDir = path.join(projectRootPath, CRG_DATA_DIR);
  if (fs.existsSync(crgDataDir)) counters.ok(`graph data directory exists: ${crgDataDir}`);
  else counters.warn(`graph data directory missing: ${crgDataDir}`);

  io.log('[4/7] Checking graph has nodes');
  if (statusText) counters.ok(`graph status: ${String(statusText).trim().split('\n')[0]}`);
  else if (skipCrgChecks) counters.ok('graph status check skipped (test override)');
  else {
    const statusResult = captureCrgCommand(['status'], { cwd: projectRootPath });
    if (statusResult && statusResult.stdout.trim()) counters.ok(`graph status: ${statusResult.stdout.trim().split('\n')[0]}`);
    else counters.warn('graph status unavailable or empty');
  }

  // 图陈旧：install 原先只在图缺失时构建，于是图会静默落后于 HEAD，
  // 而 CRG 回答“改这个会影响谁”时读的正是这份旧图。陈旧要能被看见并重建。
  if (graphFreshness.stale) {
    counters.warn(`graph is stale: built ${graphFreshness.graphAgeDays} day(s) ago, ${graphFreshness.behindHeadDays} day(s) behind HEAD; run 'codemap install' to rebuild`);
  } else if (graphFreshness.reason === 'fresh') {
    counters.ok('graph is newer than HEAD (not stale)');
  }
}

function checkDoctorConfigs({ projectRootPath, homes, client, counters }) {
  for (const target of collectCodemapMcpTargets(projectRootPath, homes, client)) {
    const inspection = inspectCodemapMcpTarget(target);
    if (inspection.valid) counters.ok(`${CRG_MCP_ALIAS} found in ${target.path} (${target.clientKey})`);
    else if (!inspection.exists) counters.warn(`${CRG_MCP_ALIAS} missing in ${target.path} (${target.clientKey})`);
    else if (inspection.hasCrg) counters.warn(`${CRG_MCP_ALIAS} invalid in ${target.path} (${target.clientKey})`);
    else if (String(inspection.reason || '').startsWith('parse failed:')) counters.warn(`${CRG_MCP_ALIAS} missing in ${target.path} (${target.clientKey}) - ${inspection.reason}`);
    else counters.warn(`${CRG_MCP_ALIAS} missing in ${target.path} (${target.clientKey})`);
  }
}

/* 中文注释：opencode 插件契约检查。v2 加载器只读 default 导出，不兼容插件不会退出报错，
 * 只是 WARN 之后静默停摆——所以必须由 doctor 把它说出来。
 * AIOS 自有文件可自愈（重跑 install）；第三方文件只报告，不改别人的代码。 */
function checkDoctorOpencodePlugin({ homes, client, counters }) {
  if (client && client !== 'all' && client !== 'opencode') return;
  const opencodeHome = homes?.opencode;
  if (!opencodeHome) return;
  const audit = auditOpenCodePlugins({ opencodeHome, major: detectOpenCodeMajor({ bin: 'opencode' }) });
  if (audit.scanStatus !== 'ok') return;
  for (const item of audit.findings) {
    if (item.ok) counters.ok(`opencode plugin contract ok: ${item.name}`);
    else {
      counters.warn(
        `opencode plugin not loadable by 2.x (${item.verdict}): ${item.file}`
        + (item.owned ? ' - rerun "aios internal codemap install" to heal' : ' - third-party, AIOS will not rewrite it'),
      );
    }
  }
  for (const item of findDanglingOpenCodePluginEntries(path.join(opencodeHome, 'opencode.json')).dropped) {
    counters.warn(`opencode plugin entry points at a missing file: ${item.entry} (${item.resolved})`);
  }
}

function checkDoctorStateAndDocs({ projectRootPath, client, counters }) {
  const state = readState(projectRootPath);
  if (state && state.version === 1) counters.ok(`state file valid: ${stateFilePath(projectRootPath)}`);
  else counters.warn('state file missing or invalid');

  for (const target of collectCodemapInstructionFiles(client)) {
    const instructionPath = path.join(projectRootPath, target.fileName);
    if (!fs.existsSync(instructionPath)) {
      counters.warn(`${target.fileName} not found`);
      continue;
    }
    const raw = fs.readFileSync(instructionPath, 'utf8');
    const markers = inspectCodemapInstructionMarkers(raw);
    if (markers.valid) {
      counters.ok(`${target.fileName} CRG section present`);
    } else {
      counters.warn(`${target.fileName} CRG section malformed or missing`);
    }
  }
}

/**
 * 报告 claude 的“已注册但被项目级本地设置禁用”状态。
 *
 * 这是 CRG 在 Claude 下“命令报 OK 却依然不工作”的根因：user 级注册由 `--fix` 修复，
 * 但 project 级 disabledMcpjsonServers 不在任何代码的写入面内，`--fix` 修不到。
 * 因此必须显式报告，否则该状态永远不可见。
 */
function checkClaudeLocalDisable({ projectRootPath, client, counters }) {
  let enabled = null;
  try {
    enabled = new Set(normalizeClientList(client));
  } catch {
    enabled = null;
  }
  if (enabled && !enabled.has('claude')) return;

  const info = inspectClaudeDisabledServers(projectRootPath);
  if (info.disablesCrg) {
    counters.warn(`${CRG_MCP_ALIAS} is disabled for claude by ${info.settingsPath} (disabledMcpjsonServers); 'doctor --fix' does NOT change this file — remove the entry manually`);
  }
}

export async function doctorCodemap({
  rootDir,
  projectRoot,
  fix = false,
  dryRun = false,
  io = console,
  clientHomes = null,
  client = 'all',
  skipCrgChecks = false,
  skipOpencodePluginInstall = false,
  statusText = '',
  crgVersion = '',
  graphFreshness = null,
} = {}) {
  const homes = resolveClientHomes(clientHomes);
  const projectRootPath = path.resolve(projectRoot || process.cwd());
  const counters = createDoctorCounters(io);
  const freshness = graphFreshness || inspectGraphFreshness(projectRootPath);

  io.log('Codemap Doctor');
  io.log(`Project: ${projectRootPath}`);
  io.log('');
  checkDoctorRuntime({ projectRootPath, skipCrgChecks, statusText, crgVersion, io, counters, graphFreshness: freshness });
  io.log('[5/7] Checking MCP config in clients');
  checkDoctorConfigs({ projectRootPath, homes, client, counters });
  checkDoctorOpencodePlugin({ homes, client, counters });
  checkClaudeLocalDisable({ projectRootPath, client, counters });
  io.log('[6/7] Checking state file');
  io.log('[7/7] Checking client instruction files');
  checkDoctorStateAndDocs({ projectRootPath, client, counters });

  const preFix = counters.snapshot();
  if (fix && (preFix.errors > 0 || preFix.effectiveWarnings > 0)) {
    io.log('');
    io.log('[fix] Re-running installCodemap to heal issues...');
    try {
      await installCodemap({ rootDir, projectRoot: projectRootPath, dryRun, io, clientHomes: homes, client, skipCrgChecks, skipOpencodePluginInstall, crgVersion });
      io.log('[fix] Install complete. Re-run doctor to verify.');
    } catch (error) {
      counters.err(`fix failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  io.log('');
  io.log('Note: counts reflect pre-fix state. Re-run doctor to get fresh results.');
  const finalCounts = counters.snapshot();
  if (finalCounts.errors > 0) io.log(`Result: FAILED (${finalCounts.errors} errors, ${finalCounts.effectiveWarnings} warnings)`);
  else io.log(`Result: OK (${finalCounts.effectiveWarnings} warnings)`);
  return finalCounts;
}
