/**
 * 固定角色 subagent 提示（explore / test / review）。
 * 结果以摘要形式回主会话，不共享可写工作树冲突（并行请用 /worktree）。
 */
export type SubagentRole = 'explore' | 'test' | 'review';

export function buildSubagentPrompt(role: SubagentRole, userText: string): string {
  switch (role) {
    case 'explore':
      return [
        '[SUBAGENT: explore — read-only]',
        'Search and read the repo to answer the question. Do NOT edit files.',
        'Return: key files, findings, recommended next steps (bullet list).',
        '',
        userText,
      ].join('\n');
    case 'test':
      return [
        '[SUBAGENT: test]',
        'Run relevant tests for this repo (detect package.json / pytest / go test / etc.).',
        'Prefer existing scripts (pnpm test, npm test, make test). Do not install huge deps unless required.',
        'Return: what you ran, pass/fail summary, failing test names, suggested fixes (do not bulk-edit unless asked).',
        '',
        userText || 'Run the default test suite and summarize.',
      ].join('\n');
    case 'review':
      return [
        '[SUBAGENT: review — read-only]',
        'Review the current changes (git diff / status). Do NOT edit files.',
        'Return: Findings (severity), Risks, Suggestions.',
        '',
        userText || 'Review uncommitted changes vs HEAD.',
      ].join('\n');
  }
}

export function subagentDefaultRuntime(_role: SubagentRole): string {
  // 用户套餐：kiro 无限 → 固定角色默认 kiro
  return 'kiro';
}
