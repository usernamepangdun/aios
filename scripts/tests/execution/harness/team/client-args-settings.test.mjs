import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRoutedExtraArgs } from '../../../../lib/execution/harness/team/subagent-runtime/context/client-args.mjs';

test('buildRoutedExtraArgs prefers claude settings and suppresses model router args', () => {
  const args = buildRoutedExtraArgs('claude-code', null, { AIOS_MODEL_ROUTER: '1' }, {
    settingsArgs: ['--settings', '/tmp/profile.json'],
  });

  assert.deepEqual(args, ['--settings', '/tmp/profile.json']);
});

test('buildRoutedExtraArgs ignores settingsArgs for non-claude clients', () => {
  const args = buildRoutedExtraArgs('codex-cli', null, { AIOS_MODEL_ROUTER: '1' }, {
    settingsArgs: ['--settings', '/tmp/profile.json'],
  });

  assert.deepEqual(args, []);
});
