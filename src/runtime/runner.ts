/**
 * 统一 Agent turn 执行（替代原 runKiro 核心逻辑）。
 */
import { getLogger } from '../lib/logger.js';
import { AcpClient } from '../kiro/acp/client.js';
import { createAgentRuntime } from './factory.js';
import { KiroAcpRuntime } from './kiroAcpRuntime.js';
import { CursorCliRuntime } from './cursorCliRuntime.js';
import { decodeSessionId, encodeSessionId } from './sessionId.js';
import type { RuntimeProfile, AgentTurnOptions, AgentTurnResult } from './types.js';

const log = () => getLogger().child({ module: 'agent-runner' });

export type { AgentTurnOptions, AgentTurnResult };

/**
 * 跑一次 agent turn。兼容原 runKiro 选项（binPath/model/agent 通过 profile 传入）。
 */
export async function runAgentTurn(
  profile: RuntimeProfile,
  opts: AgentTurnOptions,
): Promise<AgentTurnResult> {
  const {
    prompt,
    cwd,
    resumeId: rawResumeId,
    timeoutMs = profile.timeoutMs ?? 10 * 60 * 1000,
    idleTimeoutMs = 0,
    onEvent,
    signal,
    extraEnv,
    pooled,
  } = opts;

  const nativeResume = decodeSessionId(rawResumeId, profile.kind);

  log().info(
    { cwd, kind: profile.kind, resumeId: nativeResume, timeoutMs, idleTimeoutMs, pooled: !!pooled },
    'starting agent turn',
  );

  let timedOut = false;
  let aborted = false;
  let idleTimedOut = false;
  let text = '';
  let lastEventAt = Date.now();
  let sessionId: string | undefined;
  let runtime: ReturnType<typeof createAgentRuntime> | null = null;
  let ownsRuntime = true;

  if (pooled && profile.kind === 'kiro-cli-acp') {
    runtime = new KiroAcpRuntime(pooled.client, false);
    sessionId = pooled.sessionId;
    ownsRuntime = false;
  } else {
    runtime = createAgentRuntime(profile, { cwd, extraEnv });
  }

  let closeTimer: NodeJS.Timeout | null = null;
  const terminate = (): void => {
    if (sessionId) runtime?.cancel(sessionId).catch(() => undefined);
    if (!closeTimer) {
      closeTimer = setTimeout(() => {
        void runtime?.close();
      }, 2000);
    }
  };

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    log().warn({ timeoutMs }, 'agent turn timed out');
    terminate();
  }, timeoutMs);

  let idleHandle: NodeJS.Timeout | null = null;
  if (idleTimeoutMs > 0) {
    const checkInterval = Math.min(30_000, Math.max(5_000, Math.floor(idleTimeoutMs / 4)));
    idleHandle = setInterval(() => {
      if (Date.now() - lastEventAt < idleTimeoutMs) return;
      idleTimedOut = true;
      log().warn({ idleTimeoutMs }, 'agent idle timeout');
      terminate();
      if (idleHandle) {
        clearInterval(idleHandle);
        idleHandle = null;
      }
    }, checkInterval);
  }

  const onAbort = (): void => {
    aborted = true;
    terminate();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let exitCode: number | null = 0;
  try {
    if (!pooled) {
      await runtime.initialize();
      if (nativeResume) {
        try {
          await runtime.loadSession(nativeResume, cwd);
          sessionId = nativeResume;
        } catch (e) {
          log().warn({ err: e, resumeId: nativeResume }, 'loadSession failed; newSession');
        }
      }
      if (!sessionId) {
        sessionId = await runtime.newSession(cwd);
      }
    }

    for await (const ev of runtime.prompt(sessionId!, prompt)) {
      lastEventAt = Date.now();
      if (ev.kind === 'message') text += ev.text;
      try {
        onEvent?.(ev);
      } catch (e) {
        log().error({ err: e }, 'onEvent callback threw');
      }
    }

    if (runtime instanceof CursorCliRuntime && runtime.lastSessionId) {
      sessionId = runtime.lastSessionId;
    }
  } catch (e) {
    log().error({ err: e }, 'agent turn failed');
    exitCode = 1;
  } finally {
    clearTimeout(timeoutHandle);
    if (idleHandle) clearInterval(idleHandle);
    if (closeTimer) clearTimeout(closeTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (ownsRuntime) await runtime?.close();
  }

  const storedSessionId = sessionId ? encodeSessionId(profile.kind, sessionId) : rawResumeId;

  return {
    text: text.trim(),
    exitCode: aborted || timedOut || idleTimedOut ? null : exitCode,
    newSessionId: storedSessionId,
    aborted,
    timedOut,
    idleTimedOut,
    runtimeKind: profile.kind,
    availableSkills: runtime.availableSkills.length > 0 ? runtime.availableSkills : undefined,
  };
}

/** @deprecated 使用 runAgentTurn；保留兼容旧调用方。 */
export async function runKiroFromProfile(
  profile: RuntimeProfile,
  opts: AgentTurnOptions & { binPath?: string },
): Promise<AgentTurnResult> {
  if (opts.binPath && profile.kind === 'kiro-cli-acp') {
    profile = { ...profile, bin: opts.binPath };
  }
  return runAgentTurn(profile, opts);
}

export type PooledAcp = { client: AcpClient; sessionId: string };
