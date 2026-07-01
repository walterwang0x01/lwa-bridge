/**
 * Kiro CLI 一次对话（turn）封装
 *
 * 职责：
 *   - 每个 turn 起一个 `kiro-cli acp` 子进程（AcpClient），跑完即关。
 *   - initialize → loadSession(resumeId) 失败则降级 newSession(cwd) → prompt。
 *   - 消费 SessionEvent 异步迭代器，通过 onEvent 结构化透传给上层（卡片渲染器）。
 *   - turn_end 用 ACP 的 sessionId 回填 newSessionId（不再 list-sessions）。
 *   - 支持总超时 / idle watchdog / 外部 abort：先 client.cancel(sessionId)，
 *     2 秒后兜底 client.close()（SIGTERM→SIGKILL）强制收尾，维持现有终态语义。
 */
import { AcpClient, type AcpClientConfig } from './acp/client.js';
import type { SessionEvent } from './acp/messages.js';
import { getLogger } from '../lib/logger.js';

const log = () => getLogger().child({ module: 'kiro-runner' });

export interface RunOptions {
  /** 用户消息（喂给 kiro-cli 的 prompt） */
  prompt: string;
  /** 工作目录（必须绝对路径） */
  cwd: string;
  /** 续接的 session id；不传或加载失败则新建会话 */
  resumeId?: string | undefined;
  /** kiro-cli 可执行文件，默认 'kiro-cli' */
  binPath?: string;
  /** 信任的工具集合（ACP 下由 client 的 permission policy 自动放行，保留以维持契约） */
  trustedTools?: string[];
  /** 模型名（可选） */
  model?: string | undefined;
  /** Agent 名（可选；保留以维持契约） */
  agent?: string | undefined;
  /** 总超时毫秒 */
  timeoutMs?: number;
  /**
   * 空闲 watchdog 阈值（毫秒）。
   * 若连续这么久没有新 SessionEvent 就认为假死，cancel + 兜底强杀。
   * 0 或不传 = 关闭 watchdog（仅依赖 timeoutMs）。
   */
  idleTimeoutMs?: number;
  /**
   * 结构化事件回调；把 ACP 的 SessionEvent 原样透传给上层，
   * 由调用方（RunCardController）派发到 RunState。
   */
  onEvent?: (ev: SessionEvent) => void;
  /** AbortSignal 用于外部打断 */
  signal?: AbortSignal;
  /**
   * 额外的环境变量（合并到 process.env 之上）。
   * 用途：把飞书侧上下文（chatId / chatType / senderOpenId）注入子进程。
   */
  extraEnv?: Record<string, string>;
  /**
   * 池化模式：外部（AcpPool）已 spawn + initialize + load/new 好的 client + sessionId。
   * 有则跳过 spawn/initialize/load 直接 prompt（0 开销复用常驻进程）；
   * 无则走自管模式（每 turn spawn 一进程，turn 结束 close）。
   */
  pooled?: { client: AcpClient; sessionId: string };
}

export interface RunResult {
  /** 完整回复（累积所有 message 事件的文本） */
  text: string;
  /** 退出码：0 成功，1 出错，超时/中止时为 null */
  exitCode: number | null;
  /** turn 结束后用于续接的 session id */
  newSessionId?: string;
  /** 是否被外部信号中止 */
  aborted: boolean;
  /** 是否因总超时被终止 */
  timedOut: boolean;
  /** 是否因 idle watchdog 被终止 */
  idleTimedOut: boolean;
  /** Kiro 当前 agent 可用的 skill 列表（来自 _kiro.dev/commands/available） */
  availableSkills?: Array<{ name: string; description: string }>;
}

/**
 * 跑一次 kiro-cli turn。超时 / idle / 外部 abort 都安全终止。
 */
export async function runKiro(opts: RunOptions): Promise<RunResult> {
  const {
    prompt,
    cwd,
    resumeId,
    binPath = 'kiro-cli',
    model,
    agent,
    timeoutMs = 10 * 60 * 1000,
    idleTimeoutMs = 0,
    onEvent,
    signal,
    extraEnv,
  } = opts;

  log().info(
    { cwd, resumeId, timeoutMs, idleTimeoutMs, pooled: !!opts.pooled },
    'starting ACP turn',
  );

  let timedOut = false;
  let aborted = false;
  let idleTimedOut = false;
  let text = '';
  let lastEventAt = Date.now();

  // 池化模式 vs 自管模式
  const isPooled = !!opts.pooled;
  let client: AcpClient;
  let sessionId: string | undefined;

  if (isPooled) {
    // 池化：外部已 spawn + initialize + load/new，直接复用（0 开销）
    client = opts.pooled!.client;
    sessionId = opts.pooled!.sessionId;
  } else {
    // 自管：自己 spawn + initialize + load/new（每 turn 一进程）
    const spawnCfg: AcpClientConfig = { binPath, cwd };
    if (model) spawnCfg.model = model;
    if (agent) spawnCfg.agent = agent;
    if (extraEnv) spawnCfg.env = extraEnv;
    client = AcpClient.spawn(spawnCfg);
  }

  let closeTimer: NodeJS.Timeout | null = null;

  /** 先 cancel（优雅），2 秒后兜底 close（SIGTERM→SIGKILL）强制收尾。 */
  const terminate = (): void => {
    if (sessionId) client.cancel(sessionId).catch(() => undefined);
    if (!closeTimer) {
      closeTimer = setTimeout(() => {
        void client.close();
      }, 2000);
    }
  };

  // 总超时
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    log().warn({ timeoutMs }, 'ACP turn timed out, cancelling');
    terminate();
  }, timeoutMs);

  // 空闲 watchdog
  let idleHandle: NodeJS.Timeout | null = null;
  if (idleTimeoutMs > 0) {
    const checkInterval = Math.min(30_000, Math.max(5_000, Math.floor(idleTimeoutMs / 4)));
    idleHandle = setInterval(() => {
      if (Date.now() - lastEventAt < idleTimeoutMs) return;
      idleTimedOut = true;
      log().warn(
        { idleTimeoutMs, sinceLastEventMs: Date.now() - lastEventAt },
        'ACP idle timeout, cancelling',
      );
      terminate();
      if (idleHandle) {
        clearInterval(idleHandle);
        idleHandle = null;
      }
    }, checkInterval);
  }

  // 外部 abort
  const onAbort = (): void => {
    aborted = true;
    log().info('ACP turn abort requested');
    terminate();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let exitCode: number | null = 0;
  try {
    if (!isPooled) {
      // 自管模式：自己初始化 + 建/续接 session
      await client.initialize();
      if (resumeId) {
        try {
          await client.loadSession(resumeId, cwd);
          sessionId = resumeId;
        } catch (e) {
          log().warn({ err: e, resumeId }, 'loadSession failed; falling back to newSession');
        }
      }
      if (!sessionId) {
        sessionId = await client.newSession(cwd);
      }
    }

    for await (const ev of client.prompt(sessionId!, prompt)) {
      lastEventAt = Date.now();
      if (ev.kind === 'message') text += ev.text;
      try {
        onEvent?.(ev);
      } catch (e) {
        log().error({ err: e }, 'onEvent callback threw');
      }
    }
  } catch (e) {
    log().error({ err: e }, 'ACP turn failed');
    exitCode = 1;
  } finally {
    clearTimeout(timeoutHandle);
    if (idleHandle) clearInterval(idleHandle);
    if (closeTimer) clearTimeout(closeTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
    // 池化模式不 close（由 pool 管生命周期）；自管模式自己收尾
    if (!isPooled) await client.close();
  }

  log().info(
    { exitCode, textLen: text.length, aborted, timedOut, idleTimedOut, sessionId },
    'ACP turn finished',
  );

  return {
    text: text.trim(),
    exitCode: aborted || timedOut || idleTimedOut ? null : exitCode,
    newSessionId: sessionId ?? resumeId,
    aborted,
    timedOut,
    idleTimedOut,
    availableSkills: client.availableSkills.length > 0 ? client.availableSkills : undefined,
  };
}
