/* 中文注释：journal 初始化负责创建基础文件和首次摘要，不处理迭代追加。 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomic } from '../../../../../environment/fs/atomic-write.mjs';
import { readSoloControl, writeSoloControl } from './control.mjs';
import { renderObjectiveMarkdown } from '../plumbing/io.mjs';
import { defaultWorktreeState, formatRelativePath, normalizeText } from '../content/normalizers.mjs';
import { getSoloHarnessPaths, sessionDir } from '../plumbing/paths.mjs';
import { readSoloRunSummary, writeSoloRunSummary } from '../content/summary.mjs';

export async function initSoloRunJournal(input = {}) {
  const sessionId = normalizeText(input.sessionId);
  if (!sessionId) {
    throw new Error('solo run journal requires sessionId');
  }
  const paths = getSoloHarnessPaths(input);
  await mkdir(paths.dir, { recursive: true });

  const existingSummary = await readSoloRunSummary(input);
  const summary = await writeSoloRunSummary({
    rootDir: input.rootDir,
    ...(existingSummary || {}),
    sessionId,
    objective: normalizeText(input.objective, existingSummary?.objective || ''),
    provider: normalizeText(input.provider, existingSummary?.provider || 'codex'),
    clientId: normalizeText(input.clientId, existingSummary?.clientId || 'codex-cli'),
    profile: normalizeText(input.profile, existingSummary?.profile || 'standard'),
    aiosRootDir: normalizeText(input.aiosRootDir, existingSummary?.aiosRootDir || ''),
    workspaceRoot: normalizeText(input.workspaceRoot, existingSummary?.workspaceRoot || ''),
    providerSettings: normalizeText(input.providerSettings, existingSummary?.providerSettings || ''),
    status: normalizeText(existingSummary?.status, 'running'),
    stopRequested: existingSummary?.stopRequested === true,
    worktree: {
      ...(existingSummary?.worktree || defaultWorktreeState(input.worktree)),
      ...defaultWorktreeState(input.worktree),
    },
    continuity: {
      markdownPath: formatRelativePath(input.rootDir, path.join(sessionDir(input.rootDir, sessionId), 'continuity-summary.md')),
      jsonPath: formatRelativePath(input.rootDir, path.join(sessionDir(input.rootDir, sessionId), 'continuity.json')),
    },
    createdAt: normalizeText(existingSummary?.createdAt, new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  });

  const existingControl = await readSoloControl(input);
  const control = await writeSoloControl({
    rootDir: input.rootDir,
    ...(existingControl || {}),
    sessionId,
    stopRequested: existingControl?.stopRequested === true,
    reason: existingControl?.reason || '',
    requestedAt: existingControl?.requestedAt || null,
    updatedAt: new Date().toISOString(),
  });

  await writeFileAtomic(
    paths.objectivePath,
    `${renderObjectiveMarkdown({
      objective: summary.objective,
      provider: summary.provider,
      profile: summary.profile,
    })}\n`
  );
  try {
    await readFile(paths.operatorNotesPath, 'utf8');
  } catch {
    await writeFileAtomic(paths.operatorNotesPath, '');
  }
  try {
    await readFile(paths.hookEventsPath, 'utf8');
  } catch {
    await writeFileAtomic(paths.hookEventsPath, '');
  }

  return {
    sessionId,
    dir: paths.dir,
    summaryPath: paths.summaryPath,
    controlPath: paths.controlPath,
    hookEventsPath: paths.hookEventsPath,
    objectivePath: paths.objectivePath,
    operatorNotesPath: paths.operatorNotesPath,
    summary,
    control,
  };
}
