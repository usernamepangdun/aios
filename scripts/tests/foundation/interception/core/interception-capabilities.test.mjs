/* 中文注释：Interception 回归测试覆盖压缩、召回、指标和客户端配置，防止链路退化成 prompt-only。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const capabilities = JSON.parse((await readFile(new URL('../../../../../config/host-capabilities.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));

test('host capability matrix is honest about Codex raw shell limitation', () => {
  assert.equal(capabilities.clients.codex.targetLevel, 'L2');
  assert.match(capabilities.clients.codex.limits.join('\n'), /Do not claim raw host shell L3/);
});

test('AIOS harness is the controlled L3 runtime target', () => {
  assert.equal(capabilities.clients['aios-harness'].targetLevel, 'L3');
  assert.equal(capabilities.clients['aios-harness'].capabilities.includes('controlledShellRunner'), true);
  assert.equal(capabilities.clients['aios-harness'].capabilities.includes('compactPacket'), true);
});

test('Claude declares guarded pre-tool rewrite without overclaiming full shell L3', () => {
  assert.equal(capabilities.clients.claude.targetLevel, 'L2');
  assert.equal(capabilities.clients.claude.capabilities.includes('preToolRewrite'), true);
  assert.match(capabilities.clients.claude.limits.join('\n'), /unsupported shell constructs fail open/);
});

test('Cursor remains advisory until a real hook surface exists', () => {
  assert.equal(capabilities.clients.cursor.targetLevel, 'L1');
  assert.match(capabilities.clients.cursor.limits.join('\n'), /verified extension\/hook surface/);
});

test('all host capability entries require bidirectional turn compression and disallow bypass', () => {
  for (const [clientId, entry] of Object.entries(capabilities.clients)) {
    assert.equal(entry.requiredEntrypoint, 'aios-managed-runner', `${clientId} must require AIOS-managed entrypoint`);
    assert.equal(entry.directHostBypassAllowed, false, `${clientId} must reject direct host bypass`);
    assert.equal(entry.turnCompression?.preSendRequired, true, `${clientId} must require pre-send compression`);
    assert.equal(entry.turnCompression?.postReceiveRequired, true, `${clientId} must require post-receive compression`);
    assert.equal(entry.turnCompression?.uncontrolledHostOutput, 'policy-violation', `${clientId} must treat uncontrolled host output as a violation`);
  }
});

/* 中文注释：能力矩阵是随运行时分发的静态内容，不是用户工程产物。历史缺陷是把它按调用方
   rootDir（= 工作区）拼路径，在仓库外跑 `aios interception doctor` 会直接 ENOENT；开发机上
   看不出来，是因为工作区恰好就是仓库根。以下三例锁住「工作区优先、缺失则回落模块锦定的运行时根」。 */
const { resolveInterceptionConfigPath, loadHostCapabilities } = await import(
  '../../../../lib/foundation/interception/transport/clients/capabilities.mjs'
);

function tempWorkspace(prefix) {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix));
}

test('capabilities config resolves from the caller workspace when the workspace ships one', () => {
  const workspace = tempWorkspace('aios-cap-workspace-');
  fs.mkdirSync(nodePath.join(workspace, 'config'), { recursive: true });
  fs.writeFileSync(nodePath.join(workspace, 'config', 'host-capabilities.json'), JSON.stringify({
    schemaVersion: 1,
    clients: {
      'workspace-override': {
        targetLevel: 'L0', capabilities: [], limits: [],
        requiredEntrypoint: 'aios-managed-runner', directHostBypassAllowed: false,
      },
    },
  }), 'utf8');
  const resolved = resolveInterceptionConfigPath(workspace);
  assert.equal(resolved, nodePath.join(workspace, 'config', 'host-capabilities.json'));
  assert.equal(loadHostCapabilities(workspace).clients['workspace-override'].targetLevel, 'L0');
});

test('capabilities config falls back to the runtime root for a workspace without one', () => {
  const workspace = tempWorkspace('aios-cap-plain-');
  const resolved = resolveInterceptionConfigPath(workspace);
  assert.ok(!resolved.startsWith(workspace), `a workspace without config/ must not win: ${resolved}`);
  assert.ok(fs.existsSync(resolved), `fallback must reach a shipped config, got ${resolved}`);
  assert.equal(loadHostCapabilities(workspace).schemaVersion, 1);
});

test('capabilities config resolves without a caller root at all', () => {
  for (const root of [undefined, '', null]) {
    const resolved = resolveInterceptionConfigPath(root);
    assert.ok(fs.existsSync(resolved), `root=${String(root)} must still resolve, got ${resolved}`);
  }
});
