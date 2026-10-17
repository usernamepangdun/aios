import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_OLDER_THAN_MINUTES,
  classify,
  defaultRoots,
  execute,
  isSandboxName,
  isVolatileRoot,
  main,
  parseArgs,
  probeFacts,
  scanRoots,
  trashDirFor,
} from '../../../aios-tmp-gc.mjs';

const DAY = 24 * 60;

function facts(overrides = {}) {
  return {
    name: 'abhome-1zbU',
    path: '/tmp/scan/abhome-1zbU',
    isDirectory: true,
    isSymlink: false,
    mtimeMs: 0,
    hasSecrets: false,
    gitState: 'none',
    ...overrides,
  };
}

test('name shape matches mktemp random suffixes and spares real project names', () => {
  for (const name of [
    'abhome-1zbU', 'rex0111-qLxI', 'ci-repro-home-R2MG', 'asset-check-EYJZ',
    'v650-patch-check-38213', 'ab-v641-x97833', 'revert-probe-4vAl', 'aios-agent-bin-0fFGRo',
  ]) {
    assert.equal(isSandboxName(name), true, name);
  }
  /* 中文注释：这一批是 ~/codes 里真实存在的工程名，任何一个被误判即为数据丢失事故。 */
  for (const name of [
    'harness-cli', 'aios', 'aios-pro', 'rex-work', 'rex-game', 'rex-hugo', 'rex-koubo',
    'rex-videos', 'rex-ai-tools', 'rex-ppt-codex', 'hermes-setup', 'wordpress-shens',
    'claude-relay-service', 'yilang-browser', 'inkloom.im', 'inkloom.im.worktrees',
    'docsrag', 'agno-go', 'xsapp', 'huabu', 'chrexai', 'tocraft-wordpass', 'rex-wordpass-tp',
  ]) {
    assert.equal(isSandboxName(name), false, name);
  }
});

test('classify collects sandbox-shaped old dirs and keeps everything else', () => {
  const policy = { nowMs: DAY * 60000, olderThanMinutes: 60 };
  assert.equal(classify(facts(), policy).action, 'collect');
  assert.deepEqual(classify(facts({ name: 'harness-cli' }), policy).reasons, ['name-not-sandbox-shaped']);
  assert.equal(classify(facts({ isSymlink: true }), policy).action, 'keep');
  assert.equal(classify(facts({ isDirectory: false }), policy).action, 'keep');
});

test('classify keeps young dirs so live probes are never swept', () => {
  const nowMs = DAY * 60000;
  const verdict = classify(facts({ mtimeMs: nowMs - 5 * 60000 }), { nowMs, olderThanMinutes: 60 });
  assert.equal(verdict.action, 'keep');
  assert.deepEqual(verdict.reasons, ['too-young:5m']);
});

test('classify fails closed on every unreadable or unsafe git state', () => {
  const policy = { nowMs: DAY * 60000, olderThanMinutes: 60 };
  const expected = {
    dirty: 'uncommitted-work',
    unpushed: 'unpushed-commits',
    stashed: 'stash-present',
    unknown: 'git-state-unreadable',
  };
  for (const [gitState, reason] of Object.entries(expected)) {
    const verdict = classify(facts({ gitState }), policy);
    assert.equal(verdict.action, 'keep', gitState);
    assert.deepEqual(verdict.reasons, [reason]);
  }
  assert.equal(classify(facts({ gitState: 'clean' }), policy).action, 'collect');
});

test('classify keeps dirs holding local credentials unless explicitly allowed', () => {
  const policy = { nowMs: DAY * 60000, olderThanMinutes: 60 };
  assert.deepEqual(classify(facts({ hasSecrets: true }), policy).reasons, ['secrets-present']);
  assert.equal(classify(facts({ hasSecrets: true }), { ...policy, allowSecrets: true }).action, 'collect');
});

test('parseArgs refuses irreversible purge without the second explicit opt-in', () => {
  assert.match(parseArgs(['--mode', 'purge']).error, /requires --yes/);
  assert.equal(parseArgs(['--mode', 'purge', '--yes']).options.mode, 'purge');
  assert.match(parseArgs(['--mode', 'wat']).error, /invalid --mode/);
  assert.match(parseArgs(['--older-than', '-3']).error, /invalid --older-than/);
  assert.match(parseArgs(['--nope']).error, /unknown argument/);
  assert.equal(parseArgs([]).options.mode, 'dry-run', 'default must be non-destructive');
  assert.equal(parseArgs([]).options.olderThanMinutes, DEFAULT_OLDER_THAN_MINUTES);
});

test('volatile system temp root is opt-in only', () => {
  const tmpdir = os.tmpdir();
  assert.equal(isVolatileRoot(tmpdir, { tmpdir }), true);
  assert.equal(isVolatileRoot(fs.mkdtempSync(path.join(tmpdir, 'aios-gc-root-')), { tmpdir }), false);
  const roots = defaultRoots({ home: '/nonexistent-home', tmpdir });
  assert.deepEqual(roots, [tmpdir], 'missing ~/codes must not be invented');
});

test('probeFacts reads real filesystem facts including secrets and git state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-gc-probe-'));
  const sandbox = path.join(root, 'abhome-1zbU');
  fs.mkdirSync(sandbox);
  fs.writeFileSync(path.join(sandbox, '.env.deploy.local'), 'TOKEN=secret\n');
  const probed = probeFacts(sandbox);
  assert.equal(probed.isDirectory, true);
  assert.equal(probed.hasSecrets, true);
  assert.equal(probed.gitState, 'none');

  const dirty = path.join(root, 'v650-patch-check-38213');
  fs.mkdirSync(dirty);
  execFileSync('git', ['init', '-q', dirty]);
  fs.writeFileSync(path.join(dirty, 'tracked.txt'), 'x\n');
  assert.equal(probeFacts(dirty).gitState, 'dirty', 'uncommitted work must never be collected');

  const committed = path.join(root, 'ab-v641-x97833');
  fs.mkdirSync(committed);
  git(committed, ['init', '-q']);
  fs.writeFileSync(path.join(committed, 'a.txt'), 'x\n');
  git(committed, ['add', 'a.txt']);
  git(committed, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x']);
  assert.equal(probeFacts(committed).gitState, 'unknown', 'no upstream -> state unreadable, fail closed');

  fs.writeFileSync(path.join(root, 'not-a-sandbox'), 'x');
  assert.equal(probeFacts(path.join(root, 'not-a-sandbox')).isDirectory, false);
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

test('scanRoots splits collect vs keep over a real directory tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-gc-scan-'));
  const oldMs = Date.now() - 2 * DAY * 60000;
  for (const name of ['abhome-1zbU', 'ci-repro-home-R2MG']) {
    fs.mkdirSync(path.join(root, name));
    fs.utimesSync(path.join(root, name), new Date(oldMs), new Date(oldMs));
  }
  fs.mkdirSync(path.join(root, 'harness-cli'));
  fs.mkdirSync(path.join(root, 'fresh-probe-aB3cD'));
  const { collected, kept } = scanRoots([root], { olderThanMinutes: 60 });
  assert.deepEqual(collected.map((c) => c.name).sort(), ['abhome-1zbU', 'ci-repro-home-R2MG']);
  assert.equal(kept.some((k) => k.name === 'harness-cli'), true);
  assert.equal(kept.some((k) => k.name === 'fresh-probe-aB3cD'), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('execute moves to a staging trash dir and never touches kept items', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-gc-exec-'));
  const trashDir = path.join(root, '.trash');
  const victim = path.join(root, 'abhome-1zbU');
  const bystander = path.join(root, 'harness-cli');
  fs.mkdirSync(victim);
  fs.mkdirSync(bystander);

  const dry = execute([{ path: victim, name: 'abhome-1zbU' }], { mode: 'dry-run', trashDir });
  assert.equal(dry[0].result, 'reported');
  assert.equal(fs.existsSync(victim), true, 'dry-run must leave the tree untouched');

  const moved = execute([{ path: victim, name: 'abhome-1zbU' }], { mode: 'to-trash', trashDir });
  assert.equal(moved[0].result, 'removed');
  assert.equal(fs.existsSync(victim), false);
  assert.equal(fs.existsSync(path.join(trashDir, 'abhome-1zbU')), true, 'reversible staging, not unlink');
  assert.equal(fs.existsSync(bystander), true);

  const staged = execute([{ path: path.join(trashDir, 'abhome-1zbU'), name: 'abhome-1zbU' }], { mode: 'purge', trashDir });
  assert.equal(staged[0].result, 'removed');
  assert.equal(fs.existsSync(path.join(trashDir, 'abhome-1zbU')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('trashDirFor stages under the user Trash with a dated folder', () => {
  const dir = trashDirFor({ home: '/home/rex', now: new Date('2026-10-17T12:00:00Z') });
  assert.equal(dir, path.join('/home/rex', '.Trash', 'aios-tmp-gc-2026-10-17'));
});

test('main defaults to dry-run and skips a volatile root without the flag', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-gc-main-'));
  const oldMs = Date.now() - 3 * DAY * 60000;
  const sandbox = path.join(root, 'asset-check-EYJZ');
  fs.mkdirSync(sandbox);
  fs.utimesSync(sandbox, new Date(oldMs), new Date(oldMs));

  const writes = [];
  const original = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    assert.equal(main(['--root', root]), 0);
    assert.equal(fs.existsSync(sandbox), true, 'CLI default must not delete');
    assert.match(writes.join(''), /collect=1/);

    assert.equal(main(['--root', root, '--mode', 'to-trash', '--trash-dir', path.join(root, 'staging')]), 0);
    assert.equal(fs.existsSync(sandbox), false, 'explicit to-trash moves it out');
    assert.equal(fs.existsSync(path.join(root, 'staging', 'asset-check-EYJZ')), true, 'stays in the declared staging dir, never the real ~/.Trash');
    assert.equal(main(['--root', os.tmpdir()]), 1, 'volatile root alone leaves nothing usable');
    assert.match(writes.join(''), /skipped volatile root/);
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
