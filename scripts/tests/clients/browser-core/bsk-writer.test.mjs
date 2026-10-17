/* 中文注释：BSK（BrowserSkill）模式下发 + 连接基线的 CI 单测。
   覆盖 step 4：三步引导文案 + 工具集转发表 + version_skew:false 判定；
   覆盖 step 3：切到 bsk 时下发引导（互斥三态下，bsk 与 Playwright 不共线）。 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import {
  BSK_INSTALL_STEPS,
  BSK_TOOL_MAP,
  parseBskStatusJson,
  renderBskInstallGuide,
  printBskInstallGuide,
  checkBskConnect,
  resolveBskRuntime,
} from '../../../lib/tooling/components/browser/modes/bsk-writer.mjs';
import { switchBrowserMcpMode } from '../../../lib/tooling/components/browser/modes/switch.mjs';
import { resolveBrowserMode } from '../../../lib/tooling/components/browser/modes/mcp-mode.mjs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// 单参 mkdtemp(prefix) 会把目录建在 process.cwd() 下——测试一跑就在仓库根里长出
// aios-browser-mode-*/aios-bsk-switch-* 之类的垃圾，一次 git add -A 就会把它们提交进
// main（已发生过：v6.2.0 的 tag 树里带了 18 个测试垃圾文件）。统一落 os.tmpdir()，
// 并在文件级 after 钩子里清理：断言失败也要删，否则等于没清理。
const createdTempDirs = [];

async function makeTemp(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  createdTempDirs.push(dir);
  return dir;
}

/* 中文注释：沙箱 clientHomes —— 切换测试必须把落点收进临时目录。
 * 不传就会用真实家目录，测试一跑就把临时路径写进真机配置（迁移期真实事故）。 */
function sandboxClientHomes(rootDir) {
  const home = path.join(rootDir, 'home');
  return {
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
  };
}

after(async () => {
  await Promise.all(createdTempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ── 静态数据契约 ──

test('BSK_INSTALL_STEPS：三步（install/connect/run）结构完整', () => {
  assert.deepEqual(BSK_INSTALL_STEPS.map((s) => s.stage), ['install', 'connect', 'run']);
  for (const step of BSK_INSTALL_STEPS) {
    assert.equal(typeof step.title, 'string');
    assert.ok(step.title.length > 0);
    assert.equal(typeof step.command, 'string');
    assert.ok(step.command.length > 0);
    assert.equal(typeof step.note, 'string');
  }
});

test('BSK_TOOL_MAP：每个 browser 工具有对应的 bsk CLI 转发表项', () => {
  assert.ok(BSK_TOOL_MAP.length >= 5, '至少覆盖 snapshot/screenshot/navigate/connect 等');
  const byBrowser = new Map(BSK_TOOL_MAP.map((e) => [e.browser, e]));
  for (const entry of BSK_TOOL_MAP) {
    assert.equal(typeof entry.usage, 'string');
    assert.match(entry.usage, /^bsk /u, `usage 以 bsk 命令开头: ${entry.usage}`);
    assert.equal(typeof entry.description, 'string');
    assert.equal(byBrowser.get(entry.browser), entry, '按 browser 键唯一');
  }
  assert.ok(byBrowser.has('snapshot'));
  assert.ok(byBrowser.has('screenshot'));
  assert.ok(byBrowser.has('navigate'));
});

// ── parseBskStatusJson：version_skew:false 基线判定 ──

test('parseBskStatusJson：version_skew:false → ok，解析浏览器名', () => {
  const parsed = parseBskStatusJson(JSON.stringify({
    version_skew: false,
    browsers: [{ name: 'chrome' }, { id: 'chrome-headless' }],
    processId: 4321,
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.version_skew, false);
  assert.deepEqual(parsed.browsers, ['chrome', 'chrome-headless']);
  assert.equal(parsed.processId, 4321);
  assert.equal(parsed.reason, null);
});

test('parseBskStatusJson：version_skew:true → 未连上', () => {
  const parsed = parseBskStatusJson(JSON.stringify({ version_skew: true, browsers: [] }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'version_skew=true');
  assert.deepEqual(parsed.browsers, []);
});

test('parseBskStatusJson：JSON 非法 / 非对象 → ok:false，不抛', () => {
  assert.equal(parseBskStatusJson('not json').ok, false);
  assert.equal(parseBskStatusJson('[1,2,3]').ok, false, '数组顶值非对象');
  assert.equal(parseBskStatusJson('').ok, false);
});

// ── render/print 引导 ──

test('renderBskInstallGuide：包含三步与工具集映射与 version_skew 基线', () => {
  const lines = renderBskInstallGuide();
  const blob = lines.join('\n');
  for (const step of BSK_INSTALL_STEPS) {
    assert.ok(blob.includes(`[${step.stage}]`), `含阶段 ${step.stage}`);
    assert.ok(blob.includes(step.command), `含命令 ${step.command}`);
  }
  assert.ok(blob.includes('Tool map'), '含工具集映射标题');
  for (const entry of BSK_TOOL_MAP) {
    assert.ok(blob.includes(entry.browser), `含工具 ${entry.browser}`);
    assert.ok(blob.includes(entry.usage), `含 usage ${entry.usage}`);
  }
  assert.ok(blob.includes('version_skew:false'), '含连通性基线说明');
  assert.ok(blob.includes('mutually exclusive with Playwright'), '互斥提示');
});

test('printBskInstallGuide：把引导逐行交给 io', () => {
  const lines = [];
  printBskInstallGuide({ io: { log: (m) => lines.push(m) } });
  assert.ok(lines.length >= BSK_INSTALL_STEPS.length + BSK_TOOL_MAP.length);
  assert.ok(lines.some((l) => l.includes('BSK / BrowserSkill')));
});

// ── checkBskConnect：version_skew:false 基线（注入运行时）──

test('checkBskConnect：bsk CLI 缺失 → 不报错，reason=bsk-cli-missing', async () => {
  const verdict = await checkBskConnect({
    runtime: {
      commandExists: () => false,
      captureCommand: () => { throw new Error('should not be called'); },
    },
    io: { log() {} },
  });
  assert.equal(verdict.checked, false);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bsk-cli-missing');
});

test('checkBskConnect：dryRun → ok:null', async () => {
  const verdict = await checkBskConnect({
    dryRun: true,
    runtime: { commandExists: () => true, captureCommand: () => { throw new Error('should not run'); } },
    io: { log() {} },
  });
  assert.equal(verdict.checked, false);
  assert.equal(verdict.ok, null);
  assert.equal(verdict.reason, 'dry-run');
});

test('checkBskConnect：命令失败 → ok:false', async () => {
  const verdict = await checkBskConnect({
    runtime: {
      commandExists: () => true,
      captureCommand: () => ({ status: 127, stdout: '', stderr: 'not found' }),
    },
    io: { log() {} },
  });
  assert.equal(verdict.checked, true);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'command-failed');
  assert.equal(verdict.status, 127);
});

test('checkBskConnect：version_skew:true → 未连上', async () => {
  const verdict = await checkBskConnect({
    runtime: {
      commandExists: () => true,
      captureCommand: () => ({ status: 0, stdout: JSON.stringify({ version_skew: true, browsers: [] }) }),
    },
    io: { log() {} },
  });
  assert.equal(verdict.checked, true);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'version-skew');
});

test('checkBskConnect：version_skew:false + 浏览器 → 连接成功', async () => {
  const verdict = await checkBskConnect({
    runtime: {
      commandExists: () => true,
      captureCommand: () => ({
        status: 0,
        stdout: JSON.stringify({ version_skew: false, browsers: [{ name: 'chrome' }], processId: 99 }),
      }),
    },
    io: { log() {} },
  });
  assert.equal(verdict.checked, true);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.browsers, ['chrome']);
  assert.equal(verdict.processId, 99);
});

// ── 注入式运行时契约 ──

test('resolveBskRuntime：未注入时回退真实命令函数', () => {
  const rt = resolveBskRuntime();
  assert.equal(typeof rt.commandExists, 'function');
  assert.equal(typeof rt.captureCommand, 'function');
});

// ── 切换命令互斥：切到 bsk 后产出引导，切回 playwright 不再带引导 ──

test('switch 到 bsk：落盘 + 产出 BSK 引导；切回 playwright 不带引导', async () => {
  const rootDir = await makeTemp('aios-bsk-switch-');
  await mkdir(path.join(rootDir, 'config'), { recursive: true });

  const bskLogs = [];
  const switchBsk = await switchBrowserMcpMode({
    rootDir, mode: 'bsk',
    clientHomes: sandboxClientHomes(rootDir),
    io: { log: (m) => bskLogs.push(String(m)) },
  });
  assert.equal(switchBsk.mode, 'bsk');
  assert.equal(resolveBrowserMode(null, { rootDir }), 'bsk');
  const bskBlob = bskLogs.join('\n');
  assert.ok(bskBlob.includes('BSK / BrowserSkill'), '切到 bsk 下发引导');

  const pwLogs = [];
  const switchPw = await switchBrowserMcpMode({
    rootDir, mode: 'playwright',
    clientHomes: sandboxClientHomes(rootDir),
    io: { log: (m) => pwLogs.push(String(m)) },
  });
  assert.equal(switchPw.mode, 'playwright');
  assert.equal(resolveBrowserMode(null, { rootDir }), 'playwright');
  const pwBlob = pwLogs.join('\n');
  assert.ok(!pwBlob.includes('BSK / BrowserSkill'), '切回 playwright 不带 BSK 引导');

  // 写回的 settings 是合法 JSON 且存了 mode
  const settings = JSON.parse(await readFile(path.join(rootDir, 'config', 'settings.json'), 'utf8'));
  assert.equal(settings.browser.mcp, 'playwright');

  // 中文注释：materialize 的落点必须在沙箱 home 里，而不是真实用户家目录。
  const sandboxConfig = path.join(sandboxClientHomes(rootDir).opencode, 'opencode.json');
  const written = JSON.parse(await readFile(sandboxConfig, 'utf8'));
  assert.ok(written.mcp, '沙箱 opencode.json 应被写入 mcp 段');
});
