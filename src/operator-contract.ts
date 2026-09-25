export const OPERATOR_LANGUAGE = 'en-US' as const;

export const CHATGPT_WORK_CAPABILITIES = {
  version: 1,
  language: OPERATOR_LANGUAGE,
  autonomy: {
    feature_branch_edits: true,
    feature_branch_commits: true,
    builds: true,
    tests: true,
    iterative_repair: true,
  },
  supervision: {
    exact_action_approval: true,
    invalidate_changed_pending_action: true,
    execution_receipts: true,
    final_review_handoff: true,
  },
  delegation: {
    high_level_goal: true,
    durable_session: true,
    long_wait: true,
  },
} as const;

export function englishOperatorInstruction(): string {
  return [
    'Operator language is English (en-US).',
    'All user-facing summaries, questions, approval explanations, progress updates, receipts, and final results must be written in English.',
    'Do not translate code identifiers, paths, commands, API names, model names, protocol constants, or quoted source text when translation could change meaning.',
    'If source material is not English, explain its meaning in English rather than emitting untranslated operator-facing prose.',
  ].join(' ');
}
