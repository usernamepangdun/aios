/* 中文注释：Interception 回归测试覆盖压缩、召回、指标和客户端配置，防止链路退化成 prompt-only。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compressPreSendTurn } from '../../../../lib/foundation/interception/index.mjs';
import { buildClaudePreToolUseRewriteResponse, rewriteShellCommand } from '../../../../lib/foundation/interception/index.mjs';
import { decodeEnvelope } from '../../../../lib/foundation/interception/runtime/core/envelope.mjs';

const cli = path.join(process.cwd(), 'scripts', 'aios.mjs');

function shellArg(value = '') {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_./:@=-]+$/u.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function interceptPrefix(rootDir = process.cwd()) {
  return `node ${shellArg(path.join(rootDir, 'scripts', 'aios-intercept.mjs'))} shell`;
}

function decodeEnvelopeFromWrappedCommand(command) {
  const match = String(command || '').match(/\s--envelope\s+([A-Za-z0-9_-]+)/u);
  assert.ok(match, `expected wrapped command to use --envelope: ${command}`);
  return decodeEnvelope(match[1]);
}

function runAios(args, env = {}) {
  const testHome = env.AIOS_HOME ? path.join(env.AIOS_HOME, 'clients') : '';
  const clientHomes = testHome
    ? {
      CODEX_HOME: path.join(testHome, 'codex'),
      CLAUDE_HOME: path.join(testHome, 'claude'),
      GEMINI_HOME: path.join(testHome, 'gemini'),
      OPENCODE_HOME: path.join(testHome, 'opencode'),
      GROK_HOME: path.join(testHome, 'grok'),
    }
    : {};
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...clientHomes, ...env },
  });
}

test('interception proof command emits savings and capability matrix', async () => {
  const sessionId = `proof-cli-${Date.now()}`;
  const result = runAios(['interception', 'proof', '--session', sessionId, '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.metrics.records, 2);
  assert.equal(parsed.metrics.total_saved_bytes > 0, true);
  assert.equal(parsed.metrics.raw_contains_sentinel, false);
  assert.equal(parsed.capability_matrix.some((item) => item.client === 'aios-harness' && item.targetLevel === 'L3'), true);
  assert.equal(parsed.turn_compression_matrix.ok, true);
  assert.equal(parsed.turn_compression_matrix.clients.length, parsed.capability_matrix.length);
  for (const client of parsed.turn_compression_matrix.clients) {
    assert.equal(client.compliance_status, 'compliant');
    assert.equal(client.direct_host_bypass_allowed, false);
    assert.equal(client.pre_send.saved_bytes > 0, true, `${client.client_id} pre_send metric missing`);
    assert.equal(client.post_receive.saved_bytes > 0, true, `${client.client_id} post_receive metric missing`);
  }
});

test('interception doctor and mcp migration make browser MCP direct', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'aios-interception-doctor-'));
  await mkdir(path.join(workspaceRoot, 'config'), { recursive: true });
  await copyFile(
    path.join(process.cwd(), 'config', 'host-capabilities.json'),
    path.join(workspaceRoot, 'config', 'host-capabilities.json')
  );
  await writeFile(
    path.join(workspaceRoot, '.mcp.json'),
    `${JSON.stringify({
      mcpServers: {
        'mcp-browser-use': {
          type: 'stdio',
          command: process.execPath,
          args: [
            path.join(process.cwd(), 'scripts', 'aios-mcp-proxy.mjs'),
            '--workspace', workspaceRoot,
            '--host', 'mcp-browser-use',
            '--', process.execPath, 'browser-use.mjs',
          ],
        },
      },
    }, null, 2)}\n`,
    'utf8'
  );
  const env = { AIOS_HOME: path.join(workspaceRoot, 'home') };
  /* 中文注释：本测试的前提是「目标里已经有 browser 条目」，迁移才会走「保留并升级」分支。
   * 以前这个前提靠机器上残留的真实配置供给了——一个干净检出的树里没有它们，
   * mode 就解成 none、不写 browser 条目，测试只在环变量污染过的机器上“能跑过”。
   * 现在把前提声在地自己沙箱里：向会被扫描到的目标（home 类 client home）写一条代理形态的 browser 条目。*/
  const seedHome = path.join(env.AIOS_HOME, 'clients');
  const proxiedArgs = [
    path.join(process.cwd(), 'scripts', 'aios-mcp-proxy.mjs'),
    '--host', 'mcp-browser-use',
    '--', process.execPath, 'browser-use.mjs',
  ];
  await mkdir(path.join(seedHome, 'opencode'), { recursive: true });
  await writeFile(
    path.join(seedHome, 'opencode', 'opencode.json'),
    `${JSON.stringify({ mcp: { 'mcp-browser-use': { type: 'local', command: process.execPath, args: proxiedArgs, enabled: true } } }, null, 2)}\n`,
    'utf8',
  );
  const result = runAios(['interception', 'doctor', '--fix', '--workspace', workspaceRoot, '--json'], env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mcp_delivery.ok, true);
  assert.equal(parsed.mcp_delivery.legacy_browser_proxy, 0);
  assert.equal(parsed.proof.metrics.records, 2);
  assert.equal(parsed.proof.turn_compression_matrix.ok, true);
  assert.equal(parsed.proof.turn_compression_matrix.clients.length, parsed.capability_matrix.length);
  const codexConfig = await readFile(path.join(env.AIOS_HOME, 'clients', 'codex', 'config.toml'), 'utf8');
  const browserSection = codexConfig.split('[mcp_servers.aios-auth-tools]')[0];
  assert.doesNotMatch(browserSection, /aios-mcp-proxy\.mjs/);
  assert.match(browserSection, /run-local-browser-mcp\.mjs/);
});

test('interception tail --latest returns the newest proof session with recent pre/post metrics', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'aios-interception-tail-'));
  const sessionId = `tail-cli-${Date.now()}`;

  try {
    await mkdir(path.join(workspaceRoot, 'config'), { recursive: true });
    await copyFile(
      path.join(process.cwd(), 'config', 'host-capabilities.json'),
      path.join(workspaceRoot, 'config', 'host-capabilities.json')
    );

    const proof = runAios(['interception', 'proof', '--session', sessionId, '--workspace', workspaceRoot, '--json']);
    assert.equal(proof.status, 0, proof.stderr || proof.stdout);

    const tail = runAios(['interception', 'tail', '--latest', '--workspace', workspaceRoot, '--json']);
    assert.equal(tail.status, 0, tail.stderr || tail.stdout);
    const parsed = JSON.parse(tail.stdout);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.session_id, sessionId);
    assert.equal(parsed.total_records > 0, true);
    assert.equal(parsed.recent.some((record) => record.event_kind === 'pre_send'), true);
    assert.equal(parsed.recent.some((record) => record.event_kind === 'post_receive'), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('interception doctor --enforce-turns fails when selected metrics lack post_receive', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'aios-interception-enforce-turns-'));
  const sessionId = `missing-post-${Date.now()}`;

  try {
    await mkdir(path.join(workspaceRoot, 'config'), { recursive: true });
    await copyFile(
      path.join(process.cwd(), 'config', 'host-capabilities.json'),
      path.join(workspaceRoot, 'config', 'host-capabilities.json')
    );

    await compressPreSendTurn({
      workspaceRoot,
      cwd: workspaceRoot,
      sessionId,
      clientId: 'codex-cli',
      hostLevel: 'L2',
      prompt: 'PRE_SEND_ONLY_SENTINEL'.repeat(120),
      mode: 'tight',
      thresholds: { minRawBytes: 64 },
      metrics: { enabled: true },
    });

    const result = runAios(['interception', 'doctor', '--workspace', workspaceRoot, '--session', sessionId, '--enforce-turns', '--json']);
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.ok, false);
    assert.equal(parsed.turn_compliance.enforced, true);
    assert.equal(parsed.turn_compliance.session_id, sessionId);
    assert.equal(parsed.turn_compliance.pre_send, 1);
    assert.equal(parsed.turn_compliance.post_receive, 0);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('rewriteShellCommand rewrites common noisy commands and compound commands', () => {
  const gitStatus = rewriteShellCommand('git status --short');
  assert.equal(gitStatus.action, 'rewrite');
  assert.equal(gitStatus.rewrittenCommand, 'node scripts/aios-intercept.mjs shell -- git status --short');
  assert.equal(gitStatus.strategy, 'aios-shell-command-wrapper');

  const compound = rewriteShellCommand('git status && npm test');
  assert.equal(compound.action, 'rewrite');
  assert.equal(compound.rewrittenCommand, 'node scripts/aios-intercept.mjs shell -- git status && node scripts/aios-intercept.mjs shell -- npm test');

  const fallback = rewriteShellCommand('git status || npm test');
  assert.equal(fallback.action, 'rewrite');
  assert.equal(fallback.rewrittenCommand, 'node scripts/aios-intercept.mjs shell -- git status || node scripts/aios-intercept.mjs shell -- npm test');

  const partialWrapped = rewriteShellCommand('git status && node scripts/aios-intercept.mjs shell -- npm test');
  assert.equal(partialWrapped.action, 'rewrite');
  assert.equal(partialWrapped.rewrittenCommand, 'node scripts/aios-intercept.mjs shell -- git status && node scripts/aios-intercept.mjs shell -- npm test');

  const wrappedFirst = rewriteShellCommand('node scripts/aios-intercept.mjs shell -- git status && npm test');
  assert.equal(wrappedFirst.action, 'rewrite');
  assert.equal(wrappedFirst.rewrittenCommand, 'node scripts/aios-intercept.mjs shell -- git status && node scripts/aios-intercept.mjs shell -- npm test');

  const quotedSeparator = rewriteShellCommand('git commit -m "fix && test"');
  assert.equal(quotedSeparator.action, 'rewrite');
  assert.equal(quotedSeparator.rewrittenCommand, 'node scripts/aios-intercept.mjs shell -- git commit -m "fix && test"');

  const quotedCommandLikeSeparator = rewriteShellCommand('git commit -m "fix && npm test"');
  assert.equal(quotedCommandLikeSeparator.action, 'rewrite');
  assert.equal(quotedCommandLikeSeparator.rewrittenCommand, 'node scripts/aios-intercept.mjs shell -- git commit -m "fix && npm test"');

  const singleQuotedSeparator = rewriteShellCommand("git commit -m 'fix || rg docs'");
  assert.equal(singleQuotedSeparator.action, 'rewrite');
  assert.equal(singleQuotedSeparator.rewrittenCommand, "node scripts/aios-intercept.mjs shell -- git commit -m 'fix || rg docs'");

  const semicolonInQuotes = rewriteShellCommand('git commit -m "fix; npm test"');
  assert.equal(semicolonInQuotes.action, 'rewrite');
  assert.equal(semicolonInQuotes.rewrittenCommand, 'node scripts/aios-intercept.mjs shell -- git commit -m "fix; npm test"');

  const passthroughWithQuotedSeparator = rewriteShellCommand('echo "x && git status"');
  assert.equal(passthroughWithQuotedSeparator.action, 'passthrough');
  assert.equal(passthroughWithQuotedSeparator.reason, 'no command rewrite rule matched');

  const alreadyWrapped = rewriteShellCommand('node scripts/aios-intercept.mjs shell -- git status');
  assert.equal(alreadyWrapped.action, 'passthrough');
  assert.equal(alreadyWrapped.reason, 'already routed through AIOS interception');
});

test('rewriteShellCommand avoids shell constructs where compact JSON would change semantics', () => {
  for (const command of [
    'git diff > patch.diff',
    'git status | head',
    'git log $(git rev-parse --abbrev-ref HEAD)',
    'git show "$(git rev-parse HEAD)"',
    'git show `git rev-parse HEAD`',
    'git status\nnpm test',
    'git status & npm test',
  ]) {
    const decision = rewriteShellCommand(command);
    assert.equal(decision.action, 'passthrough', command);
    assert.equal(decision.reason, 'unsupported shell construct');
  }
});

test('rewriteShellCommand leaves sensitive outbound package commands to host permissions', () => {
  for (const command of ['git push origin main', 'npm publish']) {
    const decision = rewriteShellCommand(command);
    assert.equal(decision.action, 'passthrough', command);
    assert.equal(decision.reason, 'sensitive command requires host permission review');
  }
});

test('Claude PreToolUse hook response updates Bash command without forcing host allow', () => {
  const response = buildClaudePreToolUseRewriteResponse({
    tool_name: 'Bash',
    tool_input: { command: 'git diff' },
  });

  assert.equal(response.ok, true);
  assert.equal(response.response.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(response.response.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(response.response.hookSpecificOutput.permissionDecisionReason, undefined);
  const envelope = decodeEnvelopeFromWrappedCommand(response.response.hookSpecificOutput.updatedInput.command);
  assert.equal(envelope.command, 'git diff');
  assert.deepEqual(envelope.args || [], []);

  const noMatch = buildClaudePreToolUseRewriteResponse({
    tool_name: 'Read',
    tool_input: { file_path: 'README.md' },
  });
  assert.equal(noMatch.ok, true);
  assert.deepEqual(noMatch.response, {});
  assert.equal(noMatch.decision.action, 'passthrough');
});

test('Claude PreToolUse hook preserves shell command string semantics in envelopes', () => {
  for (const command of ['NODE_ENV=test npm test', "cat 'a b.txt'"]) {
    const response = buildClaudePreToolUseRewriteResponse({
      tool_name: 'Bash',
      tool_input: { command },
    });

    assert.equal(response.ok, true);
    const envelope = decodeEnvelopeFromWrappedCommand(response.response.hookSpecificOutput.updatedInput.command);
    assert.equal(envelope.command, command);
    assert.deepEqual(envelope.args || [], []);
  }
});

test('interception rewrite CLI prints text and Claude hook JSON', () => {
  const text = runAios(['interception', 'rewrite', '--command', 'git status --short']);
  assert.equal(text.status, 0, text.stderr || text.stdout);
  assert.equal(text.stdout.trim(), `${interceptPrefix()} -- git status --short`);

  const hookInput = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const hook = runAios(['interception', 'rewrite', '--hook', 'claude', '--input', hookInput, '--json']);
  assert.equal(hook.status, 0, hook.stderr || hook.stdout);
  const parsed = JSON.parse(hook.stdout);
  const envelope = decodeEnvelopeFromWrappedCommand(parsed.hookSpecificOutput.updatedInput.command);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(envelope.command, 'npm test');
});

test('Claude hook script emits host protocol JSON directly', () => {
  if (process.platform === 'win32') {
    test.skip('POSIX shell hook script is validated through an explicit bash launcher on Windows');
    return;
  }
  const result = spawnSync('scripts/hooks/claude/aios-rewrite.sh', {
    cwd: process.cwd(),
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status --short' } }),
    encoding: 'utf8',
    env: { ...process.env, AIOS_ROOT_DIR: process.cwd() },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  const envelope = decodeEnvelopeFromWrappedCommand(parsed.hookSpecificOutput.updatedInput.command);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(envelope.command, 'git status --short');
});

test('Claude hook script emits host protocol JSON through bash on Windows-compatible shells', async () => {
  const bashProbe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bashProbe.status !== 0) {
    test.skip('bash is not available in this environment');
    return;
  }
  const hookPath = path.join(process.cwd(), 'scripts', 'hooks', 'claude', 'aios-rewrite.sh');
  await chmod(hookPath, 0o755).catch(() => {});
  const result = spawnSync('bash', [hookPath], {
    cwd: process.cwd(),
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status --short' } }),
    encoding: 'utf8',
    env: { ...process.env, AIOS_ROOT_DIR: process.cwd() },
  });

  if (result.error?.code === 'ENOENT') {
    test.skip('bash is not available in this environment');
    return;
  }

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  const envelope = decodeEnvelopeFromWrappedCommand(parsed.hookSpecificOutput.updatedInput.command);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(envelope.command, 'git status --short');
});

test('aios-intercept shell shorthand preserves failing command exit status', () => {
  const result = spawnSync(process.execPath, ['scripts/aios-intercept.mjs', 'shell', '--', 'node', '-e', 'process.exit(7)'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 7, result.stderr || result.stdout);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.source, 'shell');
  assert.equal(packet.safety.requires_human, true);
});

test('interception mcp-repair previews by default and only writes with --fix', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'aios-mcp-repair-cli-'));
  const env = { AIOS_HOME: path.join(workspaceRoot, 'home') };
  const opencodeHome = path.join(workspaceRoot, 'home', 'clients', 'opencode');
  await mkdir(opencodeHome, { recursive: true });
  const staleScript = path.join(workspaceRoot, 'gone-run', 'scripts', 'auth-tools-server.py');
  const configPath = path.join(opencodeHome, 'opencode.json');
  const seeded = `${JSON.stringify({
    mcp: {
      'aios-auth-tools': { type: 'local', command: 'python3', args: [staleScript], enabled: true },
      'user-owned': { type: 'local', command: 'node', args: ['/Users/someone/tools/server.js'], enabled: true },
    },
  }, null, 2)}\n`;
  await writeFile(configPath, seeded, 'utf8');

  const preview = runAios(['interception', 'mcp-repair', '--json', '--workspace', workspaceRoot], env);
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  const previewJson = JSON.parse(preview.stdout);
  assert.equal(previewJson.dryRun, true, '不带 --fix 必须是预览');
  assert.equal(previewJson.stale.length, 1, JSON.stringify(previewJson.stale));
  assert.equal(await readFile(configPath, 'utf8'), seeded, '预览不得写盘');
  assert.equal((await import('node:fs')).readdirSync(opencodeHome).filter((n) => n.includes('bak-')).length, 0, '预览不得留备份');

  const applied = runAios(['interception', 'mcp-repair', '--fix', '--json', '--workspace', workspaceRoot], env);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  const appliedJson = JSON.parse(applied.stdout);
  assert.equal(appliedJson.dryRun, false);
  assert.equal(appliedJson.changedPaths.length, 1, JSON.stringify(appliedJson.changedPaths));
  assert.equal(appliedJson.backups.length, 1, '写盘前必须留一份备份');

  const repaired = JSON.parse(await readFile(configPath, 'utf8'));
  const authArgs = [...(repaired.mcp['aios-auth-tools'].command || []), ...(repaired.mcp['aios-auth-tools'].args || [])]
    .filter((item) => typeof item === 'string' && item.startsWith('/'));
  assert.ok(authArgs.some((item) => !item.startsWith(workspaceRoot)), `AIOS 条目应离开失效目录: ${JSON.stringify(authArgs)}`);
  assert.equal(repaired.mcp['user-owned'].args[0], '/Users/someone/tools/server.js', '用户自有条目原样保留');

  const second = runAios(['interception', 'mcp-repair', '--fix', '--json', '--workspace', workspaceRoot], env);
  const secondJson = JSON.parse(second.stdout);
  assert.equal(secondJson.stale.length, 0, '二次运行不得再判 stale');
  assert.equal(secondJson.changedPaths.length, 0, '二次运行必须零写入');

  await rm(workspaceRoot, { recursive: true, force: true });
});
