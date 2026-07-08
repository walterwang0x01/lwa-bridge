/**
 * 按 RuntimeProfile 创建具体 AgentRuntime 实例。
 */
import { CursorCliRuntime } from './cursorCliRuntime.js';
import { KiroAcpRuntime } from './kiroAcpRuntime.js';
import type { AgentRuntime, RuntimeProfile } from './types.js';

export function createAgentRuntime(
  profile: RuntimeProfile,
  opts: { cwd: string; extraEnv?: Record<string, string> },
): AgentRuntime {
  switch (profile.kind) {
    case 'kiro-acp':
      return KiroAcpRuntime.spawn(profile, opts);
    case 'cursor-cli':
      return new CursorCliRuntime(profile, opts);
    default: {
      const _exhaustive: never = profile.kind;
      throw new Error(`Unsupported runtime kind: ${String(_exhaustive)}`);
    }
  }
}
