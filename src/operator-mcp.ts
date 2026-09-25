import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Bridge } from './bridge.js';
import { CHATGPT_WORK_CAPABILITIES, englishOperatorInstruction } from './operator-contract.js';
import { createOperatorReceipt } from './operator-receipt.js';

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerOperatorTools(server: McpServer, bridge: Bridge): void {
  server.registerTool('dsh_operator_capabilities', {
    title: 'ChatGPT Work capability manifest',
    description: 'Machine-readable English manifest describing the operator-layer capabilities and autonomy available to ChatGPT Work.',
    inputSchema: z.object({}),
  }, async () => result(CHATGPT_WORK_CAPABILITIES));

  server.registerTool('dsh_delegate_goal', {
    title: 'Delegate a substantial goal to DeepSeek Harness',
    description: 'High-level ChatGPT Work entrypoint. Delegates a substantial goal to DSH with English operator output and autonomous feature-branch editing, commits, builds, tests, and iterative repair under the existing DSH approval policy.',
    inputSchema: z.object({
      workspace: z.string().min(1),
      goal: z.string().min(1).max(20000),
      plan: z.string().max(20000).optional(),
      session_id: z.string().optional(),
      request_id: z.string().min(1).max(200).optional(),
      execution_mode: z.enum(['standard','minimal','strict']).optional(),
    }),
  }, async (args: {workspace:string;goal:string;plan?:string;session_id?:string;request_id?:string;execution_mode?:'standard'|'minimal'|'strict'}) => {
    const language = englishOperatorInstruction();
    const plan = [language, 'Work autonomously on the current feature branch: edit, commit, build, test, diagnose failures, repair, and re-test as needed.', args.plan ?? ''].filter(Boolean).join('\n\n');
    const out = await bridge.startGoal({...args, plan});
    return result({...out, operator_language:'en-US', operator_contract_version:1});
  });

  server.registerTool('dsh_review_handoff', {
    title: 'Prepare independent final-review handoff',
    description: 'Returns bounded final DSH evidence plus explicit instructions for an independent ChatGPT/PStack review. This does not mark the implementation verified by itself.',
    inputSchema: z.object({session_id:z.string().min(1),max_chars:z.number().int().min(100).max(100000).optional()}),
  }, async ({session_id,max_chars}:{session_id:string;max_chars?:number}) => {
    const finalResult = await bridge.getResult(session_id,max_chars);
    const status = await bridge.getTaskStatus(session_id);
    const schema = finalResult.result_schema;
    const toolOperations = finalResult.tool_calls.map((call) => ({ tool: call.name, outcome: call.isError === true ? 'failed' : 'observed' }));
    const testSuites = schema?.tests.suites ?? [];
    const tests = testSuites.map((name) => ({
      name,
      status: (schema?.tests.fail ?? 0) > 0 ? 'failed' : 'passed',
      evidence: (schema?.tests.evidence_ids ?? []).join(', ') || undefined,
    }));
    const unresolved = [
      ...(finalResult.error === undefined ? [] : [finalResult.error.message]),
      ...(schema?.warnings ?? []),
      ...((status.blocked_steps ?? []).map((step) => `Blocked step: ${step}`)),
    ];
    const receipt = createOperatorReceipt({
      session_id,
      goal_revision: status.goal?.revision,
      status: finalResult.status,
      summary: finalResult.summary,
      changed_files: schema?.changes.changed_files ?? finalResult.changed_files,
      commits: schema?.changes.commits ?? [],
      tests,
      builds: toolOperations
        .filter((item) => /build/i.test(item.tool))
        .map((item) => ({ name: item.tool, status: item.outcome })),
      tool_operations: toolOperations,
      unresolved,
      review_ready: finalResult.status === 'completed' && unresolved.length === 0,
    });
    return result({
      receipt,
      evidence: { dsh_result: finalResult, task_status: status },
      review_instruction:'Independently inspect the changed files, commit evidence, build/test evidence, unresolved failures, and acceptance criteria. Do not treat the worker self-report as verification.',
      recommended_reviewers:['ChatGPT Work','PStack'],
    });
  });
}
