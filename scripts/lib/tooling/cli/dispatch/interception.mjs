/* 中文注释：interception 分发独立成命令处理器，避免顶层 dispatch 继续承载业务细节。 */
import { runInterceptionDoctor } from '../../../foundation/interception/pipeline/doctor.mjs';
import { runInterceptionProof } from '../../../foundation/interception/pipeline/proof.mjs';
import { runInterceptionRewrite } from '../../../foundation/interception/pipeline/rewrite.mjs';
import { runInterceptionTail } from '../../../foundation/interception/pipeline/tail.mjs';

/* 中文注释：proof 只验证链路；doctor/mcp-migrate/mcp-repair 复用同一修复实现，防止修复逻辑分叉。 */
export async function runInterceptionCommand(parsed, { rootDir, workspaceRoot }) {
  if (parsed.options.subcommand === 'proof') {
    return runInterceptionProof(parsed.options, { rootDir: workspaceRoot });
  }
  if (parsed.options.subcommand === 'tail') {
    return runInterceptionTail(parsed.options, { rootDir: workspaceRoot });
  }
  if (parsed.options.subcommand === 'rewrite') {
    return runInterceptionRewrite({ ...parsed.options, rootDir });
  }
  if (parsed.options.subcommand === 'audit') {
    const { runAuditAggregation } = await import('../../../foundation/interception/observability/audit/aggregate.mjs');
    const { runAuditQuery } = await import('../../../foundation/interception/observability/audit/query.mjs');

    /* 中文注释：audit 子命令先聚合再查询；聚合是从原始 metrics JSONL 生成 hourly.jsonl。 */
    const aggResult = await runAuditAggregation({ workspaceRoot });
    const queryResult = runAuditQuery({
      workspaceRoot,
      timezone: parsed.options.timezone,
      date: parsed.options.date,
      json: parsed.options.json,
    });

    const result = {
      ok: true,
      aggregation: aggResult,
      query: queryResult,
    };

    if (parsed.options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      /* 中文注释：文本输出格式：逐桶打印，方便运维快速扫描。 */
      console.log('AIOS Interception Audit');
      console.log('------------------------');
      console.log(`timezone=${queryResult.timezone}  date=${queryResult.date}  buckets=${queryResult.bucket_count}`);
      for (const bucket of queryResult.buckets) {
        console.log(`  ${bucket.date_utc} ${bucket.hour_utc}:00  agent=${bucket.agent_id}  calls=${bucket.tool_calls}  raw=${bucket.total_raw_bytes}  compact=${bucket.total_compact_bytes}  saved=${bucket.total_saved_bytes}  ratio=${bucket.avg_saving_ratio}  raw_tokens=${bucket.total_raw_tokens_estimate}  compact_tokens=${bucket.total_compact_tokens_estimate}`);
      }
      if (queryResult.buckets.length === 0) {
        console.log(queryResult.message || 'No audit data for the selected date/timezone.');
      }
    }

    return result;
  }

  if (parsed.options.subcommand === 'mcp-repair') {
    const { repairStaleAiosMcpPaths } = await import('../../../tooling/components/browser/mcp/mcp-path-repair.mjs');
    const json = Boolean(parsed.options.json);
    /* 中文注释：mcp-repair 默认只预览：改的是用户长期配置，必须 --fix 才写盘。
     * （mcp-migrate 仍保持旧行为：它的语义就是“迁移并写入”。） */
    const result = await repairStaleAiosMcpPaths({
      rootDir,
      client: parsed.options.client || 'all',
      dryRun: !parsed.options.fix,
      io: json ? { log() {} } : console,
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`mcp-repair: stableRoot=${result.stableRoot || 'NONE'} stale=${result.stale.length} changed=${result.changedPaths.length} dryRun=${result.dryRun}`);
      if (result.reason) console.log(`  reason: ${result.reason}`);
    }
    return { ...result, exitCode: result.ok ? 0 : 1 };
  }

  if (parsed.options.subcommand === 'doctor' || parsed.options.subcommand === 'mcp-migrate') {
    return runInterceptionDoctor({
      ...parsed.options,
      fix: parsed.options.subcommand === 'mcp-migrate' ? true : parsed.options.fix,
    }, {
      rootDir,
      projectRoot: workspaceRoot,
    });
  }

  return { exitCode: 1 };
}
