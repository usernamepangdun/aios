---
title: "v6.5.0: OpenCode 2.x 플러그인 계약, 그리고 AIOS의 위치를 거짓으로 적지 않게 된 설정"
description: "v6.5.0이 고치는 것은 명령줄에 오류를 남기지 않는 고장 유형: 클라이언트는 돌아가지만 통합은 이미 죽어 있다. OpenCode 2.x는 default export만 읽고 { id, effect | setup }을 요구하는데 AIOS는 1.x식 named export를 생성했다——플러그인은 WARN 한 줄만 남긴 채 로드되지 않고, CRG 그래프 갱신과 RTK 명령 재작성이 조용히 멈췄다. 같은 릴리스로 다른 오염 경로도 막았다: 임시 디렉터리를 root로 도는 처리가 그 경로를 장기 클라이언트 설정에 써 넣고, 테스트 스위트가 바로 그 주체였다. AIOS 플러그인은 1.x/2.x dual export가 되고 설치 시 자기 복구하며, aios interception mcp-repair는 이탈한 항목을 안정 runtime root로 되돌린다. 두 doctor는 파일과 소유자를 실명으로 보고한다."
date: 2026-10-17
tags: ["AIOS", "v6.5.0", "opencode", "플러그인", "mcp", "설정", "doctor", "릴리스"]
---

# v6.5.0: OpenCode 2.x 플러그인 계약, 그리고 AIOS의 위치를 거짓으로 적지 않게 된 설정

> **요약:** 두 가지 고장, 하나의 형태.**시스템은 계속 돌아가지만 통합은 이미 죽어 있다.** OpenCode 2.x 로더는 모듈의 `default` export만 읽어 `{ id, effect | setup }`을 검증하고, named export는 아예 보지 않는다. AIOS가 만들어 온 것은 1.x식 named export였으므로 `crg-plugin.ts`는 WARN 한 줄만 남고 로드되지 않았다——아무 후크도 발화하지 않는다. 나머지 하나는, 임시 디렉터리를 root로 하는 호출이 그 절대 경로를 장기 클라이언트 MCP 설정에 써 넣고, OS가 디렉터리를 회수한 뒤에도 설정은 남아 클라이언트가 「설치된 채 영구히 접속 불가」가 되는 경로였다. 쓰기 주체는 **테스트 스위트**였다. 이제 AIOS 플러그인은 1.x/2.x **dual export**로 나와 설치 시 기존 파일을 자기 복구하고, `aios interception mcp-repair`는 이탈한 항목을 안정 runtime root로 되돌리며, 쓰기 경계에는 volatile-root 가드가 걸리고, 두 doctor는 어느 파일이고누구의 물건인지 실명으로 보고한다.

## 플러그인 계약: 2.x는 하나의 export, 1.x는 다른 하나

현장 증거는 분명했다.

```
PluginModule.LoadError: Effect.SchemaError: Expected object at ["default"]
PluginModule.LoadError: Effect.SchemaError: Missing key at ["default"]
```

OpenCode 2.x는 `default`만 읽어 `{ id, effect | client | setup }`으로 검증하고 named export는 읽지 않는다. 1.x는 정반대로 named export를 훑어 각 `(ctx) => Hooks`를 채택한다. 그래서 1.x 플러그인은 2.x에서 오류도 없이 무효화되고, 아무도 보지 않는 로그에 WARN만 남는다. 멈춘 것은 CRG 그래프 갱신과 RTK 명령 재작성——문제의 핵심이 그것이다.

수정은 **dual export**. 이미 설치한 사용자층이 한 버전이 아니기 때문이다.

```ts
export const CodeReviewGraphPlugin = async (ctx) => { /* 1.x named export 유지 */ };
export const aiOSMemoryPlugin = async () => ({});
export default {
  id: 'code-review-graph',
  setup: CodeReviewGraphPlugin,   // 2.x는 여기를 읽는다. setup은 구버전 형태 어댑터
};
```

한 파일로 두 로더를 통과한다. `ensureOpencodePlugin`은 쓰기 전에 기존 파일 형태를 판정하고, 계약에 못 미치면 `.bak-*`를 남기고 다시 쓴다. 기존 사용자는 `aios init` / `codemap install`만 다시 돌리면 자기 복구되고, 이상을 스스로 발견할 필요가 없다.

두 개의 경계를 지켰다. `plugin-contract.mjs`가 「이 플러그인이 로드되는가」의 단일 판정원이 되었고, verdict은 2.x의 실제 실패 형태(`missing-default` / `default-not-object` / `default-missing-id` / `default-missing-handler`)와 1:1로 대응한다. 모호한 「실패」가 아니다. 그리고 서드파티 파일은 **보고만 하고 고치지 않는다**: `rtk.ts`는 `missing-default / owned=false`로 판정되어 1바이트도 건드리지 않고, 보고에 upstream 수정법이 나온다. v2 네이티브 `effect` API(Effect runtime, capability ctx, disposal scope)로의 migration은 별개 결정이고, 이 릴리스에 **포함하지 않는다**.

이 릴리스가 정직하게 말할 수 있는 것은 **로드 호환**까지다: dual export probe가 v2.0.32에서 WARN 없이 로드된다. 말할 수 없는 것은 실제 2.x 세션에서 `tool.execute.before/after`가 발화하는가——이번 주기의 probe는 모두 모델 계층에서 실패해 tool_call이 한 번도 생성되지 않았으므로, 동작 호환은 명시적으로 미클로지로 남긴다.

## 오염 경로: `/tmp`에서 돈 한 번이 홈 설정을 영구히 손상한다

같은 병의 다른 장기. `migrateBrowserMcpConfig`는 `clientHomes`가 주입되지 않으면 **실제 홈**으로 fallback하는데, 설정에 쓰는 절대 경로는 호출자의 `rootDir`에서 온다. 임시 디렉터리에서 한 번 돌리면 `/private/tmp/xxx/mcp-server/dist/index.js`가 `~/.config/opencode/opencode.json`에 들어간다. 디렉터리는 회수되지만 설정은 남고——그 MCP server는 다시 기동하지 않는다.

불편한 것은 주체: **테스트 스위트**였다. `mkdtemp`로 작업 복사본을 만들어 실제 migration 함수를 부르는 테스트 하나로 충분했다. macOS에서는 `/var/folders/…`, Linux에서는 `/tmp/…`, 같은 실패 형태로 CI도 그대로 맞았다.

가드는 각 호출자가 아니라 **쓰기 경계**에 앉는다.

- source root가 volatile 아래면 영속 대상은 전부 거부하고 구조화된 `skipped: [{ reason: 'volatile-root' }]`를 반환한다;
- sandbox→sandbox는 통과시킨다. 그렇지 않으면 테스트가 자기 sandbox를 검증할 수 없다;
- 같은 가드를 **두 번째 쓰기 주체** `syncCodexHomeConfig`에도 걸었다——`~/.codex/config.toml`의 관리 블록(trust 항목과 `aios-memory`)은 이쪽이 쓴다. migration만 지키면 그 파일의 stale 경로 5개가 수리되지 않고 남았고, 그렇게 발견했다.

`switchBrowserMcpMode`에 `clientHomes` seam을 추가하고, 새던 테스트는 sandbox를 명시 passing 한다. 가드는 이중 안전장치이지, 테스트 실행과 당신 홈 사이를 막는 유일한 것이 아니다.

## `mcp-repair`, 그리고 먼저 고쳐야 했던 테스트

`aios interception mcp-repair [--client <name>] [--fix] [--json]`는 회수된 경로로 이탈한 AIOS 관리 MCP 항목을 안정 runtime root로 되돌린다. 기본은 preview, `--fix`부터 쓰기, 파일별 `.bak-*`, 실제로 stale을 포함한 파일만 건드리고, 사용자 소유 항목은 그대로 두며, 존재하지 않는 파일을 가리키는 `plugin[]` 항목은 **보고만 하고 만들지 않는다**.

테스트를 쓰는 동안 CLI의 결함이 드러났다. 기본값은 이제 `dryRun = !options.fix`다. 그런데 「sandbox화된 `/tmp` scan root」가 **기본 scan root**를 겸하고 있으면, 「가짜 stale 설정을 짜서 넣고 `--fix` 없이 CLI를 돌리는」 테스트는 **실제 홈에 대한 실제 쓰기**를 얻는다——harness가 미주입 시 `process.env`에서 클라이언트 홈을 해석하기 때문. 첫 버전 assertion이 바로 이걸 하고 있었다. 수정은 `clientHomes`를 sandbox env에서 scan 계층까지 관통시켜 「미주입 = 실제 홈을 건드리지 않는다」를 진짜로 만들고, CLI 테스트를 증거로 삼았다.

작은 결정 두 개. 안정 root 해석 순서는 고정——non-volatile한 호출자 `rootDir` → `AIOS_ROOT_DIR` / `AIOS_ROOT` / `ROOTPATH` / `AIOS_INSTALL_DIR` → `null`——그리고 `null`이면 `cwd`로 fallback하지 않고 **수리를 거부**한다. 여기서 추측하면 설정을 새 구덩이에 쓰는 일이다. 그리고 같은 파일에 쓰기 경로가 두 개다(`[mcp_servers.*]`는 migration, codex 관리 블록은 emitter). 하나만 돌면 누락 수리가 나므로 둘 다 돈다.

## 두 doctor가 파일을 호명한다

`aios internal codemap doctor`는 홈 안 플러그인을 2.x 계약으로 하나씩 판정하고, 없는 파일을 가리키는 `plugin[]` 항목을 보고한다.

```
OK   opencode plugin contract ok: crg-plugin.ts
WARN opencode plugin not loadable by 2.x (missing-default): ~/.config/opencode/plugins/rtk.ts - third-party, AIOS will not rewrite it
```

`aios interception doctor`에는 경로 위생 구간이 늘었다: stale MCP 경로, 탐지된 OpenCode major, 플러그인 verdict과 항목별 처방. 두 개 모두 **읽기 전용**——진단이 플러그인을 다시 쓰는 일은 없다. AIOS 소유 항목은 자기 복구되는 동작(`aios init` / `codemap install` 재실행)을 가리키고, 서드파티는 upstream 수정법이나 1.x pinning을 제시한다.

## 뒷정리, 그리고 배선은 필수인 테스트

repo root의 `opencode.json`은 git 추적에서 빠졌다(`git rm --cached` + ignore). `aios init` 때 기계별로 만들어지는 projection 산물이고, 커밋하면 한 기계의 절대 경로를everyone에게 뿌리는 일——이 릴리스가 다른 곳에서 고치는 바로 그 형태다.

새 테스트 파일은 `scripts/test-suites.json` 배선이 필수이다. 배선 없으면 조용히 도달 불가가 되고, W2/W3/W5 가드가 첫 full regression에서 세 개를 빨갛게 만들며 즉시 증명했다.

## 업그레이드 노트

- 업데이트 후 `aios init`(또는 `aios internal codemap install`) 재실행——2.x가 읽지 못했던 OpenCode 플러그인 파일이 `.bak-*`를 남기고 자기 복구된다.
- 먼저 `aios interception mcp-repair`로 preview, 확인 후 `--fix`. 변경된 파일 옆에 backup이 남고, 당신이 추가한 항목은 무결하다.
- 임시 checkout에서 `aios doctor --fix`를 돌려도 홈을 오염시키지 않는다. 이미 설정에 무효 경로가 들어 있다면 위 명령이 처방이다.
- 서드파티 플러그인은 절대 다시 쓰지 않는다. `rtk.ts` 등이 WARN을 내면 doctor가 소유자와 수정법을 출력한다.
- 이번 배치에 포함하지 않음: v2 네이티브 `effect` API migration. OpenCode 자체의 cold-start 경쟁(`Location plugins did not finish activating`)과 `opencode.db` 팽창은 upstream/호스트 운영 과제라 손대지 않았다.
