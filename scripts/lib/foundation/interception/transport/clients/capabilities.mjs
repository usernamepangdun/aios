/* 中文注释：客户端能力矩阵只声明真实可达的拦截层级，避免对不同宿主过度承诺。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_CLIENTS } from '../../../clients/selection/core/definitions.mjs';

export {
  buildAiosMcpProxyServer,
  isAiosMcpProxyEntry,
  unwrapAiosMcpProxyEntry,
} from '../mcp/proxy/proxy-config.mjs';
export {
  collectInterceptionMcpTargets,
  inspectMcpProxyTarget,
  inspectMcpProxyTargets,
} from '../mcp/proxy/proxy-inspector.mjs';

export const INTERCEPTION_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3']);
// CLI 客户端成员来自注册表；aios-harness/cursor/generic-mcp 是注册表外的宿主槽位，能力各自声明在 config/host-capabilities.json。
export const CLIENT_ORDER = Object.freeze(['aios-harness', ...ALL_CLIENTS, 'cursor', 'generic-mcp']);
export const REQUIRED_TURN_COMPRESSION = Object.freeze({
  preSendRequired: true,
  postReceiveRequired: true,
  mode: 'tight',
  uncontrolledHostOutput: 'policy-violation',
});

/* 中文注释：能力矩阵是跨客户端承诺的事实源，避免文档、Skill 和代码各说各话。 */
/* 中文注释：config/host-capabilities.json 是随运行时分发的**静态内容**，不是用户工程产物。
   调用方传的 rootDir 是工作区（用户工程目录）；工作区没有 config/ 时必须回落到本模块所在的
   安装根。否则在仓库外跑 `aios interception doctor` 会直接 ENOENT：开发机上看不出来，是因为
   工作区恰好就是仓库根。写入目标仍以 rootDir 为准，只有内容根源改为模块锦定。 */
const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

function interceptionConfigPath(rootDir) {
  if (rootDir) {
    const workspaceCandidate = path.join(rootDir, 'config', 'host-capabilities.json');
    if (fs.existsSync(workspaceCandidate)) return workspaceCandidate;
  }
  return path.join(RUNTIME_ROOT, 'config', 'host-capabilities.json');
}
export function resolveInterceptionConfigPath(rootDir) {
  return interceptionConfigPath(rootDir);
}

/* 中文注释：schemaVersion 校验让未来扩展矩阵时显式升级，而不是静默读错字段。 */
export function loadHostCapabilities(rootDir) {
  const filePath = interceptionConfigPath(rootDir);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1) {
    throw new Error(`invalid host capabilities config: ${filePath}`);
  }
  return parsed;
}

/* 中文注释：未知客户端降级到 L0；宁可保守，也不能冒充宿主支持未验证 hook。 */
export function getClientCapability(capabilities, client) {
  const entry = capabilities?.clients?.[client];
  if (!entry) {
  return {
    client,
    targetLevel: 'L0',
    effectiveLevel: 'L0',
    capabilities: [],
    limits: [`Unknown client: ${client}`],
    requiredEntrypoint: 'aios-managed-runner',
    directHostBypassAllowed: false,
    turnCompression: { ...REQUIRED_TURN_COMPRESSION },
  };
  }

  /* 中文注释：这里只记录已验证能力，不记录愿望清单；产品口径也必须从这里取。 */
  return {
    client,
    targetLevel: entry.targetLevel || 'L0',
    effectiveLevel: entry.targetLevel || 'L0',
    capabilities: Array.isArray(entry.capabilities) ? [...entry.capabilities] : [],
    limits: Array.isArray(entry.limits) ? [...entry.limits] : [],
    requiredEntrypoint: entry.requiredEntrypoint || 'aios-managed-runner',
    directHostBypassAllowed: entry.directHostBypassAllowed === true,
    turnCompression: {
      ...REQUIRED_TURN_COMPRESSION,
      ...(entry.turnCompression && typeof entry.turnCompression === 'object' ? entry.turnCompression : {}),
    },
  };
}

/* 中文注释：输出顺序固定，便于 proof/doctor 快照对比，也方便人读跨客户端差异。 */
export function buildCapabilityMatrix(rootDir, { clients = CLIENT_ORDER } = {}) {
  const capabilities = loadHostCapabilities(rootDir);
  return clients.map((client) => getClientCapability(capabilities, client));
}
