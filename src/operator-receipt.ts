export interface OperatorReceipt {
  schema_version: 1;
  language: 'en-US';
  session_id: string;
  goal_revision?: number;
  status: string;
  summary: string;
  changed_files: string[];
  commits: string[];
  tests: Array<{ name: string; status: string; evidence?: string }>;
  builds: Array<{ name: string; status: string; evidence?: string }>;
  tool_operations: Array<{ tool: string; outcome: string }>;
  unresolved: string[];
  review_ready: boolean;
}

export function createOperatorReceipt(input: Omit<OperatorReceipt, 'schema_version'|'language'>): OperatorReceipt {
  return { schema_version: 1, language: 'en-US', ...input };
}
