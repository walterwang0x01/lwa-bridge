/**
 * 多 Agent CLI 运行时抽象层。
 *
 * 上层（dispatcher / conduit）只依赖本模块的类型与 runAgentTurn，
 * 具体 kiro-cli acp / cursor agent 由适配器实现。
 */
import type { SessionEvent } from '../kiro/acp/messages.js';

/** 支持的运行时种类。新增 CLI 时扩展此联合类型并实现对应适配器。 */
export type RuntimeKind = 'kiro-acp' | 'cursor-cli';

export const RUNTIME_KINDS = new Set<RuntimeKind>(['kiro-acp', 'cursor-cli']);

/** 与 ACP SessionEvent 对齐的统一事件（卡片渲染器直接消费）。 */
export type UnifiedSessionEvent = SessionEvent;

export interface RuntimeCapabilities {
  /** 是否基于 ACP JSON-RPC */
  acp: boolean;
  /** 是否支持流式输出 */
  streaming: boolean;
  /** 是否推送 tool 事件 */
  toolEvents: boolean;
  /** 是否支持 session 续接 */
  sessionResume: boolean;
  /** 是否适合 conduit 并行 worker（同 DAG 应 homogeneous） */
  parallelWorkers: boolean;
  /** 是否支持 kiro agent / skill 列表 */
  skills: boolean;
  /** 是否支持进程池复用（仅 kiro-acp） */
  poolable: boolean;
}

/** 单个 runtime profile（config.runtime.profiles 的一项）。 */
export interface RuntimeProfile {
  kind: RuntimeKind;
  /** 可执行文件：kiro-cli | agent */
  bin: string;
  model?: string;
  agent?: string;
  /** cursor-cli：等同 --force / --yolo */
  force?: boolean;
  timeoutMs?: number;
  idleTimeoutMinutes?: number;
  systemPromptPrefix?: string;
  trustedTools?: string[];
}

export interface AgentTurnOptions {
  prompt: string;
  cwd: string;
  resumeId?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  onEvent?: (ev: UnifiedSessionEvent) => void;
  signal?: AbortSignal;
  extraEnv?: Record<string, string>;
  /** 仅 kiro-acp 池化模式 */
  pooled?: {
    client: import('../kiro/acp/client.js').AcpClient;
    sessionId: string;
  };
}

export interface AgentTurnResult {
  text: string;
  exitCode: number | null;
  newSessionId?: string;
  aborted: boolean;
  timedOut: boolean;
  idleTimedOut: boolean;
  runtimeKind: RuntimeKind;
  availableSkills?: Array<{ name: string; description: string }>;
}

/** 一次 turn 的生命周期接口（短生命周期：initialize → prompt → close）。 */
export interface AgentRuntime {
  readonly kind: RuntimeKind;
  readonly capabilities: RuntimeCapabilities;
  initialize(): Promise<void>;
  newSession(cwd: string): Promise<string>;
  loadSession(id: string, cwd: string): Promise<void>;
  prompt(sessionId: string, text: string): AsyncIterable<UnifiedSessionEvent>;
  cancel(sessionId: string): Promise<void>;
  close(): Promise<void>;
  get availableSkills(): Array<{ name: string; description: string }>;
}
