import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildClaudeSettingsArgs,
  extractSettingsPath,
  findClaudeAncestor,
  normalizeSettingsPath,
  resolveInheritedClaudeSettings,
} from '../../../lib/foundation/clients/execution/profile-inheritance.mjs';

function makeProfileFile(name = 'profile.json') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aios-profile-'));
  const file = path.join(dir, name);
  writeFileSync(file, '{"model":"test"}');
  return file;
}

test('extractSettingsPath supports both flag forms and keeps the last value', () => {
  assert.equal(extractSettingsPath(['--settings', '/a.json']), '/a.json');
  assert.equal(extractSettingsPath(['--settings=/b.json']), '/b.json');
  assert.equal(extractSettingsPath(['--settings', '/a.json', '--settings', '/c.json']), '/c.json');
  assert.equal(extractSettingsPath(['--settings']), '');
});

test('normalizeSettingsPath accepts existing files and rejects inline JSON', () => {
  const file = makeProfileFile();
  assert.equal(normalizeSettingsPath(file), file);
  assert.equal(normalizeSettingsPath('/definitely/missing/profile.json'), '');
  assert.equal(normalizeSettingsPath('{"model":"x"}'), '');
  assert.equal(normalizeSettingsPath(''), '');
});

test('findClaudeAncestor reads settings from the nearest claude ancestor', () => {
  const file = makeProfileFile();
  const processTable = [
    '    1     0 /sbin/launchd',
    '  100     1 /bin/zsh',
    `  200   100 claude --settings ${file} --dangerously-skip-permissions`,
    '  300   200 node scripts/aios.mjs harness run',
  ].join('\n');

  const result = findClaudeAncestor({ pid: 300, processTable, platform: 'darwin' });
  assert.equal(result.found, true);
  assert.equal(result.ancestorPid, 200);
  assert.equal(result.settingsPath, file);
});

test('findClaudeAncestor stops at the nearest claude even without --settings', () => {
  const outer = makeProfileFile('outer.json');
  const processTable = [
    `  200   100 claude --settings ${outer}`,
    '  300   200 claude',
    '  400   300 node scripts/aios.mjs harness run',
  ].join('\n');

  const result = findClaudeAncestor({ pid: 400, processTable, platform: 'darwin' });
  assert.equal(result.found, true);
  assert.equal(result.ancestorPid, 300);
  assert.equal(result.settingsPath, '');
});

test('resolveInheritedClaudeSettings prefers the ancestor over the env marker', () => {
  const ancestorProfile = makeProfileFile('ancestor.json');
  const markerProfile = makeProfileFile('marker.json');
  const processTable = [
    `  200   100 claude --settings ${ancestorProfile}`,
    '  300   200 node aios',
  ].join('\n');

  const result = resolveInheritedClaudeSettings({
    pid: 300,
    processTable,
    platform: 'darwin',
    env: { AIOS_CLAUDE_SETTINGS: markerProfile },
  });
  assert.equal(result.settingsPath, ancestorProfile);
  assert.equal(result.source, 'ancestor-argv');
});

test('resolveInheritedClaudeSettings uses the marker when no claude ancestor exists', () => {
  const markerProfile = makeProfileFile('marker.json');
  const processTable = ['  300     1 node aios'].join('\n');

  const result = resolveInheritedClaudeSettings({
    pid: 300,
    processTable,
    platform: 'darwin',
    env: { AIOS_CLAUDE_SETTINGS: markerProfile },
  });
  assert.equal(result.settingsPath, markerProfile);
  assert.equal(result.source, 'env-marker');
});

test('buildClaudeSettingsArgs returns the --settings pair', () => {
  const file = makeProfileFile();
  const processTable = [`  200   100 claude --settings ${file}`].join('\n');

  assert.deepEqual(
    buildClaudeSettingsArgs({ pid: 200, processTable, platform: 'darwin' }),
    ['--settings', file]
  );
});
