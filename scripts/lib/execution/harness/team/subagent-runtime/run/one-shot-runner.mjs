import { commandExists } from '../../../../../foundation/platform/process.mjs';
import { buildClaudeSettingsArgs } from '../../../../../foundation/clients/execution/profile-inheritance.mjs';
import { buildOneShotInvocation } from '../../subagent-clients/one-shot.mjs';
import { runClientInvocation } from '../../subagent-clients/invocation-runner.mjs';

import { CLIENT_COMMAND } from '../state/constants.mjs';
import {
  buildClaudeUnattendedArgs,
  buildCodexConfigArgs,
  buildCodexUnattendedArgs,
  buildGeminiUnattendedArgs,
  buildGrokUnattendedArgs,
  buildRoutedExtraArgs,
} from '../context/client-args.mjs';
import { normalizeText } from '../context/text.mjs';

const PENDING_SMOKE_SUBAGENT_CLIENTS = new Set([]);

function buildRuntimeInvocation({ clientId, systemPrompt, userPrompt, env, codexOutput, modelRouting }) {
  const systemText = normalizeText(systemPrompt);
  const promptText = normalizeText(userPrompt);
  // 中文注释：claude worker 跟随当前会话的 profile；有 settings 时 buildRoutedExtraArgs 会抑制 --model。
  const settingsArgs = clientId === 'claude-code' ? buildClaudeSettingsArgs({ env }) : [];
  const routedExtraArgs = buildRoutedExtraArgs(clientId, modelRouting, env, { settingsArgs });
  const invocation = buildOneShotInvocation({
    clientId,
    systemText,
    promptText,
    routedExtraArgs,
    env,
    codexOutput,
    adapters: {
      buildClaudeUnattendedArgs,
      buildGeminiUnattendedArgs,
      buildCodexConfigArgs,
      buildCodexUnattendedArgs,
      buildGrokUnattendedArgs,
    },
  });
  return { invocation, routedExtraArgs };
}

export async function runOneShot(clientId, {
  systemPrompt,
  userPrompt,
  timeoutMs,
  env,
  io = null,
  cwd = null,
  codexOutput = null,
  modelRouting = null,
}) {
  if (PENDING_SMOKE_SUBAGENT_CLIENTS.has(clientId)) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: '',
      error: `${clientId} is pending-smoke: live subagent execution is blocked until CLI arguments, MCP config, and unattended smoke evidence are verified.`,
    };
  }

  const command = CLIENT_COMMAND[clientId];
  if (!command) {
    return { exitCode: 1, stdout: '', stderr: '', error: `Unsupported subagent client: ${clientId}` };
  }

  if (!commandExists(command, { env })) {
    return { exitCode: 127, stdout: '', stderr: '', error: `Command not found: ${command}` };
  }

  const { invocation, routedExtraArgs } = buildRuntimeInvocation({
    clientId,
    systemPrompt,
    userPrompt,
    env,
    codexOutput,
    modelRouting,
  });
  if (!invocation) {
    return { exitCode: 1, stdout: '', stderr: '', error: `Unsupported subagent client: ${clientId}` };
  }

  const result = await runClientInvocation(command, invocation, { env, timeoutMs, cwd, io, codexOutput, routedExtraArgs });
  return {
    ...result,
    // Evidence must name the final argv that produced this runner result.
    managedInvocation: {
      runner: 'aios.harness.one-shot.v1',
      command,
      args: [...(result.executedArgs || [])],
    },
  };
}
