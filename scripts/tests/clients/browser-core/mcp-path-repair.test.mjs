/* 中文注释：长期配置的路径卫生测试——锁定两件事：
 * B7 易失根守卫（临时 rootDir 不得写用户级配置）与 B9-B11 的 stale 路径修复器。
 * 沙箱用注入的 tmpdir 区分"易失"与"持久"，不依赖真实系统临时目录语义。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  findVolatileAiosPaths,
  isVolatileAiosRoot,
  resolveStableAiosRoot,
} from '../../../lib/foundation/platform/aios-runtime-root.mjs';
import {
  findDanglingOpenCodePluginEntries,
  findStaleAiosMcpConfigs,
  isAiosManagedPath,
  repairStaleAiosMcpPaths,
} from '../../../lib/tooling/components/browser/mcp/mcp-path-repair.mjs';
import { migrateBrowserMcpConfig } from '../../../lib/tooling/components/browser/mcp/mcp-migration.mjs';

function makeFixture(prefix) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const tmpdir = path.join(base, 'sim-volatile');
  const stableRoot = path.join(base, 'stable-aios');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(stableRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(stableRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(stableRoot, 'scripts', 'aios.mjs'), '// marker\n', 'utf8');
  fs.writeFileSync(
    path.join(stableRoot, 'config', 'settings.json'),
    JSON.stringify({ browser: { mcp: 'playwright' } }),
    'utf8',
  );
  fs.mkdirSync(tmpdir, { recursive: true });
  const staleRun = path.join(tmpdir, 'aios-bsk-switch-DEADBEEF');
  fs.mkdirSync(path.join(staleRun, 'scripts'), { recursive: true });
  return {
    base,
    tmpdir,
    stableRoot,
    home,
    staleScripts: path.join(staleRun, 'scripts'),
    env: { HOME: home, TMPDIR: tmpdir },
    clientHomes: {
      codex: path.join(home, '.codex'),
      claude: path.join(home, '.claude'),
      claudeRoot: path.join(home, '.claude.json'),
      gemini: path.join(home, '.gemini'),
      opencode: path.join(home, '.config', 'opencode'),
      hermes: path.join(home, '.hermes'),
      grok: path.join(home, '.grok'),
      workbuddy: path.join(home, '.workbuddy'),
      zcode: path.join(home, '.zcode'),
      qoder: path.join(home, '.qoder'),
    },
  };
}

function silentIo() {
  const lines = [];
  return { lines, log: (msg) => lines.push(String(msg)), error: (msg) => lines.push(String(msg)) };
}

test('isVolatileAiosRoot: 注入的易失根之下算易失，持久根之下不算', (t) => {
  const fx = makeFixture('aios-root-vol-');
  t.after(() => fs.rmSync(fx.base, { recursive: true, force: true }));
  assert.equal(isVolatileAiosRoot(fx.staleScripts, { env: fx.env, tmpdir: fx.tmpdir }), true);
  assert.equal(isVolatileAiosRoot(fx.stableRoot, { env: fx.env, tmpdir: fx.tmpdir }), false);
});

test('resolveStableAiosRoot: 易失 rootDir 被拒，回落到声明的稳定根', (t) => {
  const fx = makeFixture('aios-root-resolve-');
  t.after(() => fs.rmSync(fx.base, { recursive: true, force: true }));

  const refused = resolveStableAiosRoot({ rootDir: fx.staleScripts, env: fx.env, tmpdir: fx.tmpdir });
  assert.equal(refused.root, null, '易失根不能当稳定根用');
  assert.equal(refused.volatile, true);

  const viaArg = resolveStableAiosRoot({ rootDir: fx.stableRoot, env: fx.env, tmpdir: fx.tmpdir });
  assert.equal(viaArg.root, fx.stableRoot);
  assert.equal(viaArg.source, 'arg');

  const viaEnv = resolveStableAiosRoot({
    rootDir: fx.staleScripts,
    env: { ...fx.env, AIOS_ROOT_DIR: fx.stableRoot },
    tmpdir: fx.tmpdir,
  });
  assert.equal(viaEnv.root, fx.stableRoot, '易失入参下仍用已声明安装根');
  assert.equal(viaEnv.source, 'AIOS_ROOT_DIR');
});

test('findVolatileAiosPaths: 只命中易失或已消失的 AIOS 路径', (t) => {
  const fx = makeFixture('aios-root-scan-');
  t.after(() => fs.rmSync(fx.base, { recursive: true, force: true }));
  const text = [
    `python3 ${path.join(fx.staleScripts, 'auth-tools-server.py')}`,
    `node ${path.join(fx.stableRoot, 'scripts', 'aios.mjs')}`,
    '/Users/someone/own-tools/server.py',
  ].join('\n');
  const hits = findVolatileAiosPaths(text, { env: fx.env, tmpdir: fx.tmpdir });
  assert.equal(hits.length, 1, `实际命中 ${JSON.stringify(hits)}`);
  assert.match(hits[0], /auth-tools-server\.py$/u);
});

test('isAiosManagedPath: 认 AIOS 自有条目，不认用户自有路径', () => {
  assert.equal(isAiosManagedPath('/tmp/x/aios-bsk-1/scripts/auth-tools-server.py'), true);
  assert.equal(isAiosManagedPath('/tmp/x/aios-bsk-1/scripts/run-local-browser-mcp.mjs'), true);
  assert.equal(isAiosManagedPath('/Users/rex/own-tools/server.py'), false);
});

test('B7 守卫: 易失 rootDir 下，用户级配置一个字节都不动，工程/沙箱落点照常', async (t) => {
  const fx = makeFixture('aios-mcp-guard-');
  t.after(() => fs.rmSync(fx.base, { recursive: true, force: true }));
  fs.mkdirSync(fx.clientHomes.opencode, { recursive: true });
  const configPath = path.join(fx.clientHomes.opencode, 'opencode.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcp: { keep: { command: 'true', enabled: true } } }), 'utf8');
  const before = fs.readFileSync(configPath, 'utf8');

  const io = silentIo();
  const result = await migrateBrowserMcpConfig({
    rootDir: fx.staleScripts,
    clientHomes: fx.clientHomes,
    io,
    dryRun: false,
    tmpdir: fx.tmpdir,
  });
  assert.equal(fs.readFileSync(configPath, 'utf8'), before, '易失根写入长期配置必须被拒绝');
  assert.ok(result.skipped.some((entry) => entry.reason === 'volatile-root'));
  assert.ok(io.lines.some((line) => line.includes('refused (volatile AIOS root)')), '拒绝必须说出口');
});

test('修复器: dry-run 只报告，不改文件；只把 AIOS 托管条目重指到稳定根，用户条目原样保留', async (t) => {
  const fx = makeFixture('aios-mcp-repair-');
  t.after(() => fs.rmSync(fx.base, { recursive: true, force: true }));
  fs.mkdirSync(fx.clientHomes.opencode, { recursive: true });
  const configPath = path.join(fx.clientHomes.opencode, 'opencode.json');
  const stale = (name) => path.join(fx.staleScripts, name);
  fs.writeFileSync(configPath, JSON.stringify({
    mcp: {
      'aios-auth-tools': { command: 'python3', args: [stale('auth-tools-server.py')], enabled: true },
      'aios-shell': { command: 'node', args: [stale('shell-mcp-server.mjs')], enabled: true },
      'mcp-browser-use': {
        command: 'node',
        args: [stale('run-local-browser-mcp.mjs'), '--transport', 'streamable-http'],
        enabled: true,
      },
      'user-owned': { command: 'node', args: ['/Users/someone/tools/server.js'], enabled: true },
    },
    plugin: ['./plugins/aios-memory.ts', '@warp-dot-dev/opencode-warp'],
  }, null, 2) + '\n', 'utf8');
  const before = fs.readFileSync(configPath, 'utf8');

  const scan = findStaleAiosMcpConfigs({
    projectRoot: fx.stableRoot,
    clientHomes: fx.clientHomes,
    env: fx.env,
    tmpdir: fx.tmpdir,
  });
  assert.ok(scan.stale.some((entry) => path.resolve(entry.path) === path.resolve(configPath)), '必须检出该落点');

  const dryIo = silentIo();
  const dry = await repairStaleAiosMcpPaths({
    rootDir: fx.staleScripts,
    env: { ...fx.env, AIOS_ROOT_DIR: fx.stableRoot },
    clientHomes: fx.clientHomes,
    tmpdir: fx.tmpdir,
    dryRun: true,
    io: dryIo,
  });
  assert.equal(dry.ok, true);
  assert.equal(dry.stableRoot, fx.stableRoot, '入参是易失根时必须回落到声明的稳定根');
  assert.equal(fs.readFileSync(configPath, 'utf8'), before, 'dry-run 不得写盘');

  const io = silentIo();
  const result = await repairStaleAiosMcpPaths({
    rootDir: fx.staleScripts,
    env: { ...fx.env, AIOS_ROOT_DIR: fx.stableRoot },
    clientHomes: fx.clientHomes,
    tmpdir: fx.tmpdir,
    dryRun: false,
    io,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const pathsOf = (entry) => [...(entry.command || []), ...(entry.args || [])].filter((item) => typeof item === 'string' && item.startsWith('/'));
  for (const key of ['aios-auth-tools', 'aios-shell', 'mcp-browser-use']) {
    const paths = pathsOf(after.mcp[key] || {});
    assert.ok(paths.length, `${key} 应已重新 materialize: ${JSON.stringify(after.mcp[key])}`);
    assert.ok(paths.some((p) => p.startsWith(fx.stableRoot)), `${key} 应有路径落在稳定根: ${JSON.stringify(paths)}`);
    assert.ok(!paths.some((p) => p.startsWith(fx.tmpdir)), `${key} 不应残留易失路径`);
  }
  assert.equal(after.mcp['user-owned'].args[0], '/Users/someone/tools/server.js', '用户自有条目必须原样');
  assert.deepEqual(after.plugin, ['./plugins/aios-memory.ts', '@warp-dot-dev/opencode-warp'], '修复不动 plugin 数组');
  assert.equal(findVolatileAiosPaths(fs.readFileSync(configPath, 'utf8'), { env: fx.env, tmpdir: fx.tmpdir, trustedRoots: [fx.stableRoot] }).length, 0, '修复后不得残留易失路径');

  // A12：修复前必须留可回滚备份，且二次运行幂等（已无 stale）。
  const backups = fs.readdirSync(fx.clientHomes.opencode).filter((name) => name.includes('opencode.json.bak-'));
  assert.equal(backups.length, 1, `应有一份备份: ${JSON.stringify(backups)}`);
  assert.equal(fs.readFileSync(path.join(fx.clientHomes.opencode, backups[0]), 'utf8'), before, '备份必须是修复前原文');
  const textBeforeSecondRun = fs.readFileSync(configPath, 'utf8');
  const again = await repairStaleAiosMcpPaths({
    rootDir: fx.stableRoot,
    env: fx.env,
    clientHomes: fx.clientHomes,
    tmpdir: fx.tmpdir,
    dryRun: false,
    io: silentIo(),
  });
  assert.equal(again.stale.length, 0, '二次运行不得再判 stale');
  assert.equal(again.changedPaths.length, 0, '二次运行必须零写入');
  assert.equal(fs.readFileSync(configPath, 'utf8'), textBeforeSecondRun, '二次运行文件字节不变');
});

test('修复器: 没有可解析的稳定根时拒绝修复，不猜 cwd', async (t) => {
  const fx = makeFixture('aios-mcp-repair-noroot-');
  t.after(() => fs.rmSync(fx.base, { recursive: true, force: true }));
  const io = silentIo();
  const result = await repairStaleAiosMcpPaths({
    rootDir: fx.staleScripts,
    env: fx.env,
    clientHomes: fx.clientHomes,
    tmpdir: fx.tmpdir,
    dryRun: false,
    io,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /stable AIOS runtime root|no AIOS runtime root/u);
  assert.ok(io.lines.some((line) => line.includes('[fail] mcp-repair refused')), '拒绝必须说出口');
});

test('B11: 悬空 plugin 条目只报告不创建文件，远程包名保留', (t) => {
  const fx = makeFixture('aios-mcp-repair-plugin-');
  t.after(() => fs.rmSync(fx.base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fx.home, 'cfg'), { recursive: true });
  const configPath = path.join(fx.home, 'cfg', 'opencode.json');
  fs.writeFileSync(configPath, JSON.stringify({
    plugin: ['./plugins/aios-memory.ts', './plugins/present.ts', '@scope/remote-pkg'],
  }), 'utf8');
  fs.mkdirSync(path.join(fx.home, 'cfg', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(fx.home, 'cfg', 'plugins', 'present.ts'), '// ok\n', 'utf8');

  const report = findDanglingOpenCodePluginEntries(configPath);
  assert.equal(report.dropped.length, 1);
  assert.equal(report.dropped[0].entry, './plugins/aios-memory.ts');
  assert.ok(report.kept.includes('@scope/remote-pkg'), '远程包名不做本地判定');
  assert.ok(report.kept.includes('./plugins/present.ts'));
  assert.equal(fs.existsSync(path.join(fx.home, 'cfg', 'plugins', 'aios-memory.ts')), false, '修复器不代替用户建文件');
});

test('B4/B5 doctor 卫生诊断: 易失路径与 2.x 不兼容插件都被说出来', async (t) => {
  const fx = makeFixture('aios-doctor-hygiene-');
  t.after(() => fs.rmSync(fx.base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fx.clientHomes.opencode, 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(fx.clientHomes.opencode, 'opencode.json'),
    JSON.stringify({
      mcp: { 'aios-auth-tools': { command: 'python3', args: [path.join(fx.staleScripts, 'auth-tools-server.py')], enabled: true } },
    }),
    'utf8',
  );
  // 第三方 1.x-only 插件：doctor 必须报，但不改写。
  fs.writeFileSync(
    path.join(fx.clientHomes.opencode, 'plugins', 'rtk.ts'),
    'export const RtkPlugin = async () => ({})\n',
    'utf8',
  );
  const before = fs.readFileSync(path.join(fx.clientHomes.opencode, 'plugins', 'rtk.ts'), 'utf8');

  const { collectPathHygiene } = await import('../../../lib/foundation/interception/pipeline/doctor.mjs');
  const hygiene = collectPathHygiene({ rootDir: fx.stableRoot, homes: fx.clientHomes, env: fx.env });
  assert.equal(hygiene.stale_count, 1, JSON.stringify(hygiene.stale_mcp_paths));
  assert.match(hygiene.stale_mcp_paths[0].file, /opencode\.json$/u);
  assert.equal(hygiene.opencode_plugins_broken, 1);
  assert.equal(hygiene.opencode_plugins[0].verdict, 'missing-default');
  assert.equal(hygiene.opencode_plugins[0].owned, false);
  assert.match(hygiene.opencode_plugins_remediation[0].action, /third-party/u);
  assert.equal(fs.readFileSync(path.join(fx.clientHomes.opencode, 'plugins', 'rtk.ts'), 'utf8'), before, '诊断是只读的');
});
