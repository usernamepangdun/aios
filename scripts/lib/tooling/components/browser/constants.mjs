export const DEFAULT_CDP_SERVICE_PORT = 9222;
export const CDP_SERVICE_LABEL_PREFIX = 'com.aios.cdp';
export const PRIMARY_BROWSER_ALIAS = 'mcp-browser-use';
export const LEGACY_HERMES_BROWSER_ALIASES = ['browser-use', 'mcp-browser', 'ai-browser-use'];

export const AUTH_TOOLS_ALIAS = 'aios-auth-tools';
export const SHELL_ALIAS = 'aios-shell';
export const MEMORY_ALIAS = 'aios-memory';

/* 中文注释：指向 AIOS 运行时根内脚本的路径标记。修复器只重 materialize 包含这些标记的
 * 易失路径（= AIOS 自己拥有的条目），用户自有的绝对路径一律不碰。 */
export const AIOS_MANAGED_PATH_MARKERS = Object.freeze([
  'aios-mcp-proxy',
  'run-local-browser-mcp',
  'auth-tools-server',
  'shell-mcp-server',
  'memory-mcp-server',
  'aios-bridge',
  '.rexcil/aios',
]);
