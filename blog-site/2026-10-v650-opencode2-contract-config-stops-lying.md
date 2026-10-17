---
title: "v6.5.0: OpenCode 2.x Plugin Contract, and the Config That Stopped Lying About Where AIOS Lives"
description: "v6.5.0 fixes a class of failure that produces no error at your command line: a coding client whose integration quietly stopped working. OpenCode 2.x reads only the `default` export and requires `{ id, effect | setup }`, while AIOS shipped 1.x-style named exports — the plugin loaded as nothing, and CRG graph updates and RTK command rewriting were silently off. The same release closes a config-pollution path: a run rooted in a temporary directory wrote temp paths into long-lived client configs, and the test suite itself was one of those runners. AIOS plugins now ship dual-export and self-heal on install; `aios interception mcp-repair` re-points stale entries at the stable runtime root; and both doctors name the broken file instead of reporting a count."
date: 2026-10-17
tags: ["AIOS", "v6.5.0", "opencode", "plugin", "mcp", "config", "doctor", "release"]
---

# v6.5.0: OpenCode 2.x Plugin Contract, and the Config That Stopped Lying About Where AIOS Lives

> **TL;DR:** Two failures, one shared shape: **the system keeps working, but the integration is already dead.** OpenCode 2.x only reads a plugin's `default` export and requires `{ id, effect | setup }`; AIOS generated 1.x-style named exports, so `crg-plugin.ts` failed to load with a WARN and nothing else — the plugin was silently off. Separately, any operation rooted in a temporary directory wrote that temp path into long-lived client MCP configs, and when the OS reclaimed the directory the client stayed "installed" but disconnected forever. Running the test suite was itself one of those writers. AIOS plugins now ship a 1.x/2.x **dual export** and self-heal old files on install; `aios interception mcp-repair` re-points stale entries at the stable runtime root; a volatile-root guard refuses the write at the boundary; and both doctors name the offending file and who owns it.

## The plugin contract: 2.x reads one export, 1.x reads the other

The on-disk evidence was unambiguous:

```
PluginModule.LoadError: Effect.SchemaError: Expected object at ["default"]
PluginModule.LoadError: Effect.SchemaError: Missing key at ["default"]
```

OpenCode 2.x's loader takes only the module's `default` export and validates it as `{ id, effect | client | setup }`; named exports are not consulted at all. 1.x did the opposite — it walked named exports, each one a `(ctx) => Hooks` function. A 1.x plugin under 2.x therefore produces no hook and no error at the command line, just a WARN in a log nobody reads. Which integration died is the point: CRG graph updates and RTK command rewriting were silently switched off.

The fix is a **dual export**, because the installed base is not one version:

```ts
export const CodeReviewGraphPlugin = async (ctx) => { /* 1.x named export, kept */ };
export const aiOSMemoryPlugin = async () => ({});
export default {
  id: 'code-review-graph',
  setup: CodeReviewGraphPlugin,   // 2.x reads this; `setup` is its legacy-shape adapter
};
```

One file, both loaders. `ensureOpencodePlugin` classifies the existing file before writing and, when the shape fails the contract, keeps a `.bak-*` and rewrites it — so an existing user's machine heals on the next `aios init` / `codemap install` rather than waiting for them to notice.

Two boundaries held. `plugin-contract.mjs` is now the single source of truth for "is this plugin loadable," with verdicts that map one-to-one onto 2.x's real failure modes (`missing-default`, `default-not-object`, `default-missing-id`, `default-missing-handler`) instead of a generic "failed." And third-party files are **reported, never rewritten**: `rtk.ts` was classified `missing-default / owned=false`, left byte-for-byte alone, with the upstream fix in the report. Migrating to the v2-native `effect` API (Effect runtime, capability ctx, disposal scopes) is a separate decision and is deliberately not in this release.

What this release can honestly claim: **load compatibility**. A dual-export probe is loaded by v2.0.32 with no WARN. What it cannot claim yet: that `tool.execute.before/after` fires in a real 2.x session — every probe attempt this cycle died in the model layer before producing a single tool call, so behavior compatibility is explicitly still open.

## The pollution path: one run from `/tmp`, permanent damage in the home directory

The same disease, second organ. `migrateBrowserMcpConfig` falls back to the **real** client homes when `clientHomes` is not injected, while the absolute paths it writes come from the caller's `rootDir`. Run it from a temporary directory and `/private/tmp/xxx/mcp-server/dist/index.js` lands in `~/.config/opencode/opencode.json`. The temp directory is reclaimed; the config is not; the MCP server never starts again.

The uncomfortable part is who triggered it: **the test suite**. A test that materialized its working copy under `mkdtemp` and called the real migration function was enough. macOS shows it as `/var/folders/…`, Linux as `/tmp/…` — same failure shape, and CI hit it too.

The guard sits at the write boundary, not inside each caller:

- when the source root is volatile, persistent targets are refused and the result carries a structured `skipped: [{ reason: 'volatile-root' }]`;
- sandbox→sandbox writes still pass, otherwise a test cannot verify its own sandbox;
- the same guard is mounted on the **second** writer, `syncCodexHomeConfig`, which owns `~/.codex/config.toml`'s managed block (trust entries plus `aios-memory`). Guarding only the migrator left 5 stale paths in that file unfixed — that is how we found it.

`switchBrowserMcpMode` gained a `clientHomes` seam and the leaking test now passes an explicit sandbox, so the guard is belt-and-suspenders rather than the only thing standing between a test run and your home directory.

## `mcp-repair`, and the test I had to fix first

`aios interception mcp-repair [--client <name>] [--fix] [--json]` re-points AIOS-managed entries that drifted to a reclaimed path onto the stable runtime root. Preview by default; `--fix` to write; a `.bak-*` per file; only files that actually contain stale paths are touched; user-owned entries are left exactly as they were; `plugin[]` entries pointing at nonexistent files are **reported, not created**.

Writing its test surfaced a defect in the CLI. The default `dryRun` is `!options.fix` — preview unless you ask to write. But if the sandboxed `/tmp` scan root is also the *default* scan root, a test that seeds a fake stale config and then runs the CLI without `--fix` gets a **real write into the home directory**, because the harness resolves client homes from `process.env` when no sandbox is passed. My first version of that assertion did exactly this. Fixing the test meant threading `clientHomes` from the sandbox env through the scan, so "no injection" now means "don't touch the real home directories," with the CLI test as the proof.

Two smaller decisions: the stable root resolves in a fixed order — a non-volatile caller `rootDir`, then `AIOS_ROOT_DIR` / `AIOS_ROOT` / `ROOTPATH` / `AIOS_INSTALL_DIR`, then `null` — and when it is `null` the tool **refuses to repair** rather than falling back to `cwd`; guessing here is how you write configs into a new pit. And because one file can be written by two code paths (`[mcp_servers.*]` via the migrator, the codex managed block via the emitter), the repairer runs both or it under-reports.

## Both doctors now name the file

`aios internal codemap doctor` checks every plugin in the home directory against the 2.x contract and reports `plugin[]` entries pointing at files that no longer exist:

```
OK   opencode plugin contract ok: crg-plugin.ts
WARN opencode plugin not loadable by 2.x (missing-default): ~/.config/opencode/plugins/rtk.ts - third-party, AIOS will not rewrite it
```

`aios interception doctor` gained a path-hygiene section: stale MCP paths, the detected OpenCode major version, plugin verdicts, and a remedy for each. Both are **read-only** — diagnosis never rewrites a plugin. An AIOS-owned entry points at an action that self-heals (rerun `aios init` / `codemap install`); a third-party entry names the upstream fix or recommends pinning 1.x.

## Housekeeping, and the tests that must be wired

The repo-root `opencode.json` is out of git (`git rm --cached` + ignore rule). It is a per-machine projection written by the native emitter during `aios init`; committing it distributes one machine's absolute paths to everyone — the exact shape this release fixes elsewhere.

New test files have to be registered in `scripts/test-suites.json` or they are silently unreachable; the wiring guard (W2/W3/W5) proved that the moment the first full regression went red on three assertions.

## Upgrade notes

- Update, then rerun `aios init` (or `aios internal codemap install`) — that self-heals an OpenCode plugin file that 2.x could not load, keeping a `.bak-*`.
- `aios interception mcp-repair` to preview, add `--fix` to apply. Backups are written next to each changed file; entries you added yourself are untouched.
- `aios doctor --fix` no longer pollutes your home directory when it runs from a temporary checkout; if your configs already carry stale paths, the line above is the remedy.
- Third-party plugins are never rewritten. If `rtk.ts` or another vendor file warns, the doctor prints the owner and the fix.
- Not included: v2-native `effect` API migration; OpenCode's own cold-start race (`Location plugins did not finish activating`) and `opencode.db` growth are upstream/host concerns, untouched here.
