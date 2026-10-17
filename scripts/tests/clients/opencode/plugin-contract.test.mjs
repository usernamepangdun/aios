/* 中文注释：OpenCode 插件契约测试——锁定"一份文件同时被 1.x 和 2.x 加载器接受"这条兼容边界。
 * 断言对象是 2.x 加载器的真实 schema（default = { id, effect | setup }），不是字符串巧合。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  auditOpenCodePlugins,
  buildDualExportTail,
  classifyOpenCodePluginSource,
  detectOpenCodeMajor,
  isAiosOwnedPluginSource,
  parseOpenCodeVersion,
  resolveOpenCodePluginCompat,
} from '../../../lib/clients/opencode/plugin-contract.mjs';
import { ensureOpencodePlugin } from '../../../lib/tooling/components/codemap/targets/opencode-plugin.mjs';
import { doctorCodemap } from '../../../lib/tooling/components/codemap/lifecycle/doctor.mjs';

function makeTempHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function silentIo() {
  const lines = [];
  return { lines, log: (msg) => lines.push(String(msg)) };
}

// 现场四个失败形状，对应 opencode 2.0.32 log 里的 Expected object / Missing key。
const LEGACY_1X_ONLY = `export const RtkPlugin: Plugin = async () => ({ 'tool.execute.before': async () => {} })\n`;
const DEFAULT_IS_FUNCTION = `const P = async () => ({})\nexport default P\n`;
const DEFAULT_NO_ID = `export default { setup: async () => ({}) }\n`;
const DEFAULT_NO_HANDLER = `export default { id: 'x' }\n`;
const DUAL_EXPORT = `export const P = async () => ({})\n${buildDualExportTail({ id: 'x', legacyExport: 'P' })}`;

test('classify: 1.x-only 具名导出判为 missing-default（对应 Missing key at ["default"]）', () => {
  const verdict = classifyOpenCodePluginSource(LEGACY_1X_ONLY);
  assert.equal(verdict.verdict, 'missing-default');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.hasNamedPluginExport, true, '1.x 入口仍在，只是 2.x 不读它');
});

test('classify: `export default <函数>` 判为 default-not-object（对应 Expected object at ["default"]）', () => {
  assert.equal(classifyOpenCodePluginSource(DEFAULT_IS_FUNCTION).verdict, 'default-not-object');
});

test('classify: default 对象缺 id / 缺 handler 各自单独可观察', () => {
  assert.equal(classifyOpenCodePluginSource(DEFAULT_NO_ID).verdict, 'default-missing-id');
  assert.equal(classifyOpenCodePluginSource(DEFAULT_NO_HANDLER).verdict, 'default-missing-handler');
});

test('classify: 双导出形状判为 ok 且保留 1.x 具名导出', () => {
  const verdict = classifyOpenCodePluginSource(DUAL_EXPORT);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.verdict, 'ok');
  assert.equal(verdict.hasNamedPluginExport, true);
});

test('buildDualExportTail: 只补 2.x 的 default，参数不全时拒绝', () => {
  const tail = buildDualExportTail({ id: 'code-review-graph', legacyExport: 'CodeReviewGraphPlugin' });
  assert.match(tail, /export default \{ id: 'code-review-graph', setup: CodeReviewGraphPlugin \}/u);
  assert.throws(() => buildDualExportTail({ id: '' }), /requires \{ id, legacyExport \}/u);
});

test('compat: 版本未知走保守默认（仍产出 default 导出，两边可加载）', () => {
  assert.deepEqual(resolveOpenCodePluginCompat(null), { known: false, requiresDefaultExport: true, label: 'unknown' });
  assert.equal(resolveOpenCodePluginCompat(1).requiresDefaultExport, false);
  assert.equal(resolveOpenCodePluginCompat(1).label, 'v1');
  assert.equal(resolveOpenCodePluginCompat(2).label, 'v2');
});

test('parse/detect: 版本解析失败返回 null，不抛', () => {
  assert.equal(parseOpenCodeVersion('1.15.12'), 1);
  assert.equal(parseOpenCodeVersion('opencode v2.0.32'), 2);
  assert.equal(parseOpenCodeVersion('nonsense'), null);
  assert.equal(detectOpenCodeMajor({ capture: () => 'v2.0.32', exists: () => true }), 2);
  assert.equal(detectOpenCodeMajor({ capture: () => { throw new Error('boom'); }, exists: () => true }), null);
  assert.equal(detectOpenCodeMajor({ capture: () => 'v2.0.32', exists: () => false }), null, '命令不存在时不假装探测成功');
});

test('AIOS 生成的 CRG 插件同时满足 1.x 与 2.x 契约', () => {
  const home = makeTempHome('aios-opencode-crg-compat-');
  const result = ensureOpencodePlugin(home, { io: silentIo() });
  const source = fs.readFileSync(result.path, 'utf8');
  assert.equal(classifyOpenCodePluginSource(source).ok, true, '2.x 必须能加载');
  assert.match(source, /export const CodeReviewGraphPlugin: Plugin = async/u, '1.x 具名导出必须保留');
});

test('自愈: 旧 1.x-only CRG 文件重跑安装即变双导出，并留备份', () => {
  const home = makeTempHome('aios-opencode-crg-heal-');
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  const filePath = path.join(home, 'plugins', 'crg-plugin.ts');
  // 历史模板：CRG 托管 + default 是函数（今天 log 里的失败样本）。
  fs.writeFileSync(filePath, `// code-review-graph managed\n${DEFAULT_IS_FUNCTION}`, 'utf8');

  const io = silentIo();
  const result = ensureOpencodePlugin(home, { io });
  assert.equal(result.status, 'updated');
  assert.equal(result.previousContract, 'default-not-object');
  assert.equal(result.contract, 'ok');
  assert.ok(io.lines.some((line) => line.includes('not loadable by OpenCode 2.x')), '必须把降级说出口');
  assert.ok(
    fs.readdirSync(path.join(home, 'plugins')).some((name) => name.includes('crg-plugin.ts.bak')),
    '重写前必须留备份',
  );
  assert.equal(classifyOpenCodePluginSource(fs.readFileSync(filePath, 'utf8')).ok, true);
});

test('幂等 + 用户自有文件不被覆盖', () => {
  const home = makeTempHome('aios-opencode-crg-idempotent-');
  const io = silentIo();
  assert.equal(ensureOpencodePlugin(home, { io }).status, 'created');
  assert.equal(ensureOpencodePlugin(home, { io }).status, 'unchanged');

  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  const userFile = path.join(home, 'plugins', 'crg-plugin.ts');
  const userContent = '// my own plugin, not CRG\nexport const Mine = async () => ({})\n';
  fs.writeFileSync(userFile, userContent, 'utf8');
  const skipped = ensureOpencodePlugin(home, { io: silentIo() });
  assert.equal(skipped.status, 'skipped');
  assert.equal(fs.readFileSync(userFile, 'utf8'), userContent, '非 AIOS 管理文件必须逐字节不变');
});

test('audit: 第三方 1.x-only 插件只报告不改写，AIOS 自有插件给出可自愈动作', () => {
  const home = makeTempHome('aios-opencode-audit-');
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, 'plugins', 'rtk.ts'), LEGACY_1X_ONLY, 'utf8');
  ensureOpencodePlugin(home, { io: silentIo() });

  const audit = auditOpenCodePlugins({ opencodeHome: home, major: 2 });
  assert.equal(audit.scanStatus, 'ok');
  assert.equal(audit.compat.label, 'v2');
  const byName = new Map(audit.findings.map((item) => [item.name, item]));

  const thirdParty = byName.get('rtk.ts');
  assert.equal(thirdParty.ok, false);
  assert.equal(thirdParty.owned, false, '不是 AIOS 拥有的文件');
  const crg = byName.get('crg-plugin.ts');
  assert.equal(crg.ok, true);
  assert.equal(crg.owned, true);

  assert.equal(audit.broken.length, 1);
  const fix = audit.remediation[0];
  assert.equal(fix.owned, false);
  assert.match(fix.action, /third-party/u);
  assert.ok(audit.remediation.every((item) => !item.owned || /rerun/iu.test(item.action)), 'AIOS 自有项必须指向可自愈动作');
  assert.equal(fs.readFileSync(path.join(home, 'plugins', 'rtk.ts'), 'utf8'), LEGACY_1X_ONLY, '审计不得改第三方文件');
});

test('isAiosOwnedPluginSource: 只对 AIOS 写入的插件为真', () => {
  assert.equal(isAiosOwnedPluginSource('// code-review-graph managed\n'), true);
  assert.equal(isAiosOwnedPluginSource('export const RtkPlugin = async () => ({})'), false);
});

test('B4/B5 codemap doctor 点名报告不可加载插件与悬空 plugin 条目，且不改写第三方文件', async () => {
  const home = makeTempHome('aios-crg-doctor-contract-');
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, 'opencode.json'), JSON.stringify({ plugin: ['./plugins/gone.ts'] }), 'utf8');
  fs.writeFileSync(path.join(home, 'plugins', 'third-party.ts'), LEGACY_1X_ONLY, 'utf8');
  const before = fs.readFileSync(path.join(home, 'plugins', 'third-party.ts'), 'utf8');

  const io = silentIo();
  await doctorCodemap({
    rootDir: home,
    projectRoot: home,
    clientHomes: { opencode: home },
    client: 'opencode',
    skipCrgChecks: true,
    graphFreshness: { exists: false, stale: false, nodes: 0 },
    io,
  });
  const blob = io.lines.join('\n');
  assert.match(blob, /not loadable by 2\.x \(missing-default\)/u, '必须点名失败原因');
  assert.match(blob, /third-party, AIOS will not rewrite it/u);
  assert.match(blob, /plugin entry points at a missing file: \.\/plugins\/gone\.ts/u);
  assert.equal(fs.readFileSync(path.join(home, 'plugins', 'third-party.ts'), 'utf8'), before, 'doctor 只诊断不改写');
});

test('B4 codemap doctor 对 AIOS 自有旧插件给出可自愈修法', async () => {
  const home = makeTempHome('aios-crg-doctor-owned-');
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, 'plugins', 'crg-plugin.ts'), `// code-review-graph managed\n${DEFAULT_IS_FUNCTION}`, 'utf8');

  const io = silentIo();
  await doctorCodemap({
    rootDir: home,
    projectRoot: home,
    clientHomes: { opencode: home },
    client: 'opencode',
    skipCrgChecks: true,
    graphFreshness: { exists: false, stale: false, nodes: 0 },
    io,
  });
  assert.match(io.lines.join('\n'), /rerun "aios internal codemap install" to heal/u);
});
