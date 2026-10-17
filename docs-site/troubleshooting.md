---
title: Troubleshooting AIOS
description: Diagnose setup, ContextDB, client sync, workflow, team, browser, token-tool, and privacy failures with observable evidence.
schema_type: faq
faq:
  - q: "Should I delete .aios to fix a problem?"
    a: "No. Identify the first failure and back up sessions, exports, and memo JSONL before removing derived data."
  - q: "Does a successful dry-run mean the system works?"
    a: "No. It proves local parsing and planned state. Run a small live task when provider and credential checks are in scope."
  - q: "Which output should I share?"
    a: "Share the command, exit code, runtime versions, and the smallest redacted excerpt that proves the symptom."
  - q: "How do I recover a failed AIOS installation?"
    a: "Run aios doctor --native --verbose to find the first actionable issue, then re-run aios init --all from the intended project root."
  - q: "Why are my MCP servers closed after an upgrade or after moving the project?"
    a: "MCP entries store absolute script paths. After moving the project or install directory, re-run aios update or aios internal browser mcp-migrate from the new root, then restart the client."
  - q: "My MCP entries point at a /tmp or /var/folders path that no longer exists."
    a: "Run aios interception mcp-repair to preview, then aios interception mcp-repair --fix. It re-points AIOS-managed entries to the stable runtime root, backs up each changed file, and leaves your own entries untouched."
  - q: "My OpenCode plugin stopped working after upgrading to OpenCode 2.x."
    a: "OpenCode 2.x loads only a default export shaped { id, setup | effect }. Re-run aios init (or aios internal codemap install) to self-heal AIOS-generated plugins; aios internal codemap doctor names the offending file."
---

# Troubleshooting

## Quick Answer

Start with one diagnostic command and keep its output:

~~~bash
aios doctor --native --verbose
~~~

Then classify the symptom. Do not infer a live provider failure from a dry-run, and do not delete project data before identifying the first failing command.

## Installation and Node.js

**Symptom:** aios is missing or ContextDB commands fail after switching Node.

~~~bash
node -v
npm -v
command -v aios
aios doctor --native --verbose
~~~

Expected evidence is Node.js 24 LTS and a resolved aios path. On macOS or Linux, reload the profile or open a new shell. On Windows, run the TLS-safe installer and reload PowerShell with . $PROFILE. If a dependency build is involved, run the project-specific test rather than deleting node_modules first.

## ContextDB and registry

**Symptom:** the client cannot find project memory.

~~~bash
test -f .aios/context-db/index.json
find .aios/context-db -maxdepth 2 -type f | head -n 30
aios doctor --native --verbose
~~~

Confirm that aios init --all ran from the intended project root. Use unified search or an explicit memo/checkpoint to test recall. The legacy .contextdb-enable file is only a compatibility switch; it is not proof of current initialization.

**Symptom:** a search returns no results.

~~~bash
node scripts/aios.mjs search "release readiness" --agent codex-cli --json
aios memo storage status
aios memo storage rebuild
~~~

Expected evidence is a source list or a storage status report. Rebuild derived indexes only after checking the canonical memo files.

## Client sync and route shortcuts

**Symptom:** native instructions or shortcuts are missing.

~~~bash
aios doctor --native --verbose
node scripts/aios.mjs init --all --dry-run
aios doctor --native --fix
~~~

Read the dry-run plan before applying a fix. Client capability varies; a synced file does not prove that a provider route is live.

## Workflow Policy and plans

**Symptom:** a plan was created for a read-only question, or a small change is unexpectedly blocked.

~~~bash
node scripts/aios.mjs plan auto-gate --task "Explain the current auth flow" --dry-run --json
node scripts/aios.mjs plan auto-gate --task "Refactor auth across modules" --json
~~~

Check whether the disposition is noop, direct, guarded, or planned, and whether persistence is none, reuse, or create. Policy routing is separate from pre-edit safety and final verification. See [Workflow Policy](workflow-policy.md).

## Team and Solo Harness

**Symptom:** a team or harness run stops, is blocked, or shows no live progress.

~~~bash
aios team history --provider codex --limit 5
aios harness status --session <session-id> --json
aios hud --session <session-id> --json
~~~

Read the first failed job or iteration. For a blocked team, retry only the blocked work:

~~~bash
aios team --resume <session-id> --retry-blocked --provider codex --workers 2
~~~

For a solo run, stop with a reason and resume after fixing the first failure:

~~~bash
aios harness stop --session <session-id> --reason "diagnose first failure"
aios harness resume --session <session-id>
~~~

A dry-run creates local state but does not test provider credentials or live routes.

## Browser MCP

**Symptom:** browser tools are missing or page actions fail.

~~~bash
aios internal browser doctor
aios internal browser cdp-status
~~~

Use the documented browser-use CDP path: launch a visible CDP browser, connect, read a semantic snapshot or targeted text, then act and verify. Keep authentication walls human-controlled. Playwright MCP is a compatibility path.

**Symptom:** MCP servers show "connection closed" after an upgrade or after moving the project/install directory.

~~~bash
aios internal browser mcp-migrate
aios update
~~~

MCP entries in client configs (for example `~/.config/opencode/opencode.json`) store absolute paths to this repository's `scripts/` launchers. After the project or install directory is physically moved, those entries point at a path that no longer exists, so the servers fail to start. `aios update` rewrites them by default (the browser component is in the default update set); `aios internal browser mcp-migrate` rewrites them directly. Run either from the new project root, then restart the client. `aios doctor` checks the launcher paths without rewriting anything.

**Symptom:** entries point at a temporary directory (`/tmp/...`, `/var/folders/...`) that no longer exists.

~~~bash
aios interception mcp-repair
aios interception mcp-repair --fix
~~~

A temporary root — an unpacked install, a test sandbox, or a `/tmp` checkout — can be captured as an absolute path in a long-lived client config. When the OS reclaims that directory, the servers never start again and re-running `mcp-migrate` from another temporary root just replaces one dead path with another. `mcp-repair` resolves the stable AIOS runtime root (`AIOS_ROOT_DIR`, or the installed runtime the `aios` launcher points at) and re-points only AIOS-managed entries onto it: preview by default, `--fix` to write, a `.bak-*` per changed file, your own entries left byte-for-byte, `--client <name>` to narrow the scope. It refuses to run when no stable root can be resolved rather than guessing. AIOS now also refuses to write persistent configs when the source root is itself temporary, so this shape no longer recurs.

**Symptom:** an OpenCode plugin (code-review-graph, or another AIOS-generated one) stops working after upgrading OpenCode to 2.x, with only a log line like `PluginModule.LoadError: Expected object at ["default"]`.

~~~bash
aios internal codemap doctor
aios init
~~~

OpenCode 2.x reads only the module's `default` export and requires `{ id, effect | setup }`; 1.x walked named exports instead. A 1.x-shaped plugin under 2.x produces no error on the command line and fires no hooks — the integration is silently off. AIOS-generated plugins now ship both shapes and self-heal on install (`aios init`, or `aios internal codemap install`), keeping a `.bak-*` of the old file. `codemap doctor` names any plugin file that 2.x cannot load and any `"plugin": [...]` entry pointing at a missing file. Third-party plugin files are reported, never rewritten.

## Token tools

**Symptom:** RTK, Caveman, or Headroom is missing or the consent flow stops.

~~~bash
node scripts/aios.mjs init --all --dry-run
aios doctor --native --verbose
node scripts/aios.mjs init --all --yes-compression-tools --yes-headroom-mcp
~~~

The package-install consent and user-scope MCP consent are separate. Inspect external or conflict Headroom registrations before changing them. Do not claim savings without headroom_stats showing positive saved-token totals.

## Privacy and sensitive files

**Symptom:** a command would expose credentials or private configuration.

~~~bash
aios privacy status
aios privacy read --file .env
~~~

Use the redacted output, never raw .env, cookies, tokens, private keys, or browser profiles. If a report needs logs, remove provider tokens and personal paths first.

## FAQ

### Should I delete .aios to fix a problem?

No. Identify the first failure and back up sessions, exports, and memo JSONL before removing derived data.

### Does a successful dry-run mean the system works?

No. It proves local parsing and planned state. Run a small live task when provider and credential checks are in scope.

### Which output should I share?

Share the command, exit code, runtime versions, and the smallest redacted excerpt that proves the symptom.

## Next steps

- [Quick Start](getting-started.md)
- [ContextDB](contextdb.md)
- [Workflow Policy](workflow-policy.md)
- [Token Intelligence](token-compression.md)
- [Case Library](case-library.md)
