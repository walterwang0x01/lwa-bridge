/**
 * Kiro CLI 一次对话（turn）封装
 *
 * 向后兼容层：内部委托给 runtime/runAgentTurn。
 * 新代码请直接使用 `runAgentTurn` + `RuntimeProfile`。
 */
import type { SessionEvent } from './acp/messages.js';
import type { AcpClient } from './acp/client.js';
import { runAgentTurn, type AgentTurnResult } from '../runtime/runner.js';
import type { RuntimeProfile } from '../runtime/types.js';

export interface RunOptions {
  prompt: string;
  cwd: string;
  resumeId?: string | undefined;
  binPath?: string;
  trustedTools?: string[];
  model?: string | undefined;
  agent?: string | undefined;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  onEvent?: (ev: SessionEvent) => void;
  signal?: AbortSignal;
  extraEnv?: Record<string, string>;
  pooled?: { client: AcpClient; sessionId: string };
}

export type RunResult = Omit<AgentTurnResult, 'runtimeKind'> & {
  newSessionId?: string;
  availableSkills?: Array<{ name: string; description: string }>;
};

function optionsToProfile(opts: RunOptions): RuntimeProfile {
  const profile: RuntimeProfile = {
    kind: 'kiro-acp',
    bin: opts.binPath ?? 'kiro-cli',
  };
  if (opts.model) profile.model = opts.model;
  if (opts.agent) profile.agent = opts.agent;
  if (opts.trustedTools) profile.trustedTools = opts.trustedTools;
  if (opts.timeoutMs) profile.timeoutMs = opts.timeoutMs;
  return profile;
}

export async function runKiro(opts: RunOptions): Promise<RunResult> {
  const profile = optionsToProfile(opts);
  const result = await runAgentTurn(profile, opts);
  const { runtimeKind: _rk, ...rest } = result;
  return rest;
}
