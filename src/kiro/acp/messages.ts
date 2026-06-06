/**
 * ACP（Agent Client Protocol）消息类型定义。
 *
 * 传输：JSON-RPC 2.0 over stdio。
 * 参考：https://agentclientprotocol.com/protocol/overview
 *
 * 仅定义本模块用到的子集，完整 schema 用到时再补。
 */

/** JSON-RPC 协议版本，所有消息固定 "2.0"。 */
export const JSONRPC_VERSION = '2.0';

/** ACP 协议版本（Kiro 实测是数字 1，不是日期串）。 */
export const ACP_PROTOCOL_VERSION = 1;

/** ACP 方法名常量，避免散落字符串。 */
export const Method = {
  INITIALIZE: 'initialize',
  SESSION_NEW: 'session/new',
  SESSION_LOAD: 'session/load',
  SESSION_PROMPT: 'session/prompt',
  SESSION_CANCEL: 'session/cancel',
  SESSION_UPDATE: 'session/update',
} as const;

/** session/update 通知里的 sessionUpdate 类型枚举。 */
export const SessionUpdate = {
  AGENT_MESSAGE_CHUNK: 'agent_message_chunk',
  AGENT_THOUGHT_CHUNK: 'agent_thought_chunk',
  TOOL_CALL: 'tool_call',
  TOOL_CALL_UPDATE: 'tool_call_update',
  PLAN: 'plan',
} as const;

/** JSON-RPC 2.0 错误对象（wire 形态）。 */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 2.0 请求。无 id 即通知。 */
export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: Record<string, unknown>;
  id?: number | string;
}

/** JSON-RPC 2.0 响应。result 与 error 互斥。 */
export interface JsonRpcResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

/** JSON-RPC 2.0 通知（无 id，不需响应）。 */
export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: Record<string, unknown>;
}

/** 代理流式输出 / 思考的一段文本。 */
export interface MessageEvent {
  kind: 'message' | 'thought';
  sessionId: string;
  text: string;
}

/** 代理调用工具事件（开始 / 进度 / 完成）。 */
export interface ToolEvent {
  kind: 'tool';
  sessionId: string;
  toolCallId: string;
  name: string;
  status: string;
  raw: Record<string, unknown>;
}

/** 一轮 prompt 处理完成。 */
export interface TurnEndEvent {
  kind: 'turn_end';
  sessionId: string;
  stopReason?: string;
}

/**
 * Kiro 扩展的用量/成本元数据（`_kiro.dev/metadata`）。
 * 每个 turn 会推若干次，最后一次带 meteringUsage（credit）和 turnDurationMs。
 */
export interface MetadataEvent {
  kind: 'metadata';
  sessionId: string;
  /** 上下文使用率百分比（0–100） */
  contextUsagePercentage?: number;
  /** 本次计费用量（credit 等） */
  credits?: number;
  /** 本轮耗时毫秒 */
  turnDurationMs?: number;
}

/** 解析后的高层 session 事件联合。 */
export type SessionEvent = MessageEvent | ToolEvent | TurnEndEvent | MetadataEvent;

/** ACP 调用返回了 error 对象时抛出的异常。 */
export class AcpError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(`ACP error ${code}: ${message}`);
    this.name = 'AcpError';
    this.code = code;
    this.data = data;
  }

  static fromWire(error: JsonRpcErrorObject): AcpError {
    return new AcpError(
      typeof error?.code === 'number' ? error.code : -1,
      String(error?.message ?? 'unknown'),
      error?.data,
    );
  }
}
