/**
 * ACP 子进程客户端：封装一层 `kiro-cli acp` 子进程，提供 async API。
 *
 * 设计：
 *   - 子进程通过 stdin/stdout 跑 JSON-RPC 2.0
 *   - 后台 reader 持续读 stdout，把响应分流到 pending Promise / 事件队列
 *   - 上层用 await / async-iterator 拿结果，无需关心协议细节
 *
 * 最小生命周期：
 *   const client = AcpClient.spawn({ cwd: '/tmp/foo' });
 *   await client.initialize();
 *   const sid = await client.newSession('/tmp/foo');
 *   for await (const event of client.prompt(sid, 'hello')) { ... }
 *   await client.close();
 */
import { execa, type ResultPromise } from 'execa';
import { isAbsolute } from 'node:path';
import { getLogger } from '../../lib/logger.js';
import { AsyncQueue, QUEUE_CLOSED } from './asyncQueue.js';
import {
  ACP_PROTOCOL_VERSION,
  AcpError,
  type JsonRpcErrorObject,
  JSONRPC_VERSION,
  type MetadataEvent,
  Method,
  type SessionEvent,
  SessionUpdate,
} from './messages.js';

const log = () => getLogger().child({ module: 'acp-client' });

export interface AcpClientConfig {
  /** kiro-cli 可执行文件路径或命令名，默认 'kiro-cli'。 */
  binPath?: string;
  /** 子进程参数，默认 ['acp']。 */
  args?: string[];
  /** 子进程 cwd（默认继承）。 */
  cwd?: string;
  /** 额外环境变量（合并到 process.env 之上）。 */
  env?: Record<string, string>;
  /** 等待响应的超时毫秒，默认 60000。 */
  responseTimeoutMs?: number;
  /** 自动决策 session/request_permission 的 option kind，默认 'allow_once'。 */
  permissionPolicy?: string;
  /** 启动时通过 --model 指定模型（不传用 Kiro 默认）。 */
  model?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 session/update 的 update 体解析出高层事件，未识别返回 null。 */
function mapUpdate(
  sessionId: string,
  kind: unknown,
  update: Record<string, any>,
): SessionEvent | null {
  switch (kind) {
    case SessionUpdate.AGENT_MESSAGE_CHUNK:
      return { kind: 'message', sessionId, text: textOf(update) };
    case SessionUpdate.AGENT_THOUGHT_CHUNK:
      return { kind: 'thought', sessionId, text: textOf(update) };
    case SessionUpdate.TOOL_CALL:
    case SessionUpdate.TOOL_CALL_UPDATE:
      return {
        kind: 'tool',
        sessionId,
        toolCallId: String(update.toolCallId ?? update.id ?? ''),
        name: String(update.name ?? update.toolName ?? ''),
        status: String(update.status ?? 'unknown'),
        raw: update,
      };
    default:
      // plan 等未在事件联合中的类型安全忽略
      return null;
  }
}

function textOf(update: Record<string, any>): string {
  const content = update.content;
  if (content && typeof content === 'object') return String(content.text ?? '');
  return '';
}

/**
 * 从 `_kiro.dev/metadata` 的 meteringUsage 数组里累加 credit 用量。
 * 形如 [{ value: 0.37, unit: 'credit', unitPlural: 'credits' }]；无则返回 undefined。
 */
function extractCredits(meteringUsage: unknown): number | undefined {
  if (!Array.isArray(meteringUsage)) return undefined;
  let total = 0;
  let found = false;
  for (const item of meteringUsage) {
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const unit = String(rec.unit ?? '');
      if (unit.startsWith('credit') && typeof rec.value === 'number') {
        total += rec.value;
        found = true;
      }
    }
  }
  return found ? total : undefined;
}

/** 从 _kiro.dev/commands/available 的 skills 数组提取 name + description。 */
function parseSkills(raw: unknown): Array<{ name: string; description: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; description: string }> = [];
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const r = item as Record<string, unknown>;
      const name = typeof r.name === 'string' ? r.name : '';
      const desc = typeof r.description === 'string' ? r.description : '';
      if (name) out.push({ name, description: desc });
    }
  }
  return out;
}

/** 从 _kiro.dev/commands/available 的 tools 数组提取工具名。 */
function parseToolNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const name = (item as Record<string, unknown>).name;
      if (typeof name === 'string') out.push(name);
    }
  }
  return out;
}

export class AcpClient {
  private readonly proc: ResultPromise;
  private readonly responseTimeoutMs: number;
  private readonly permissionPolicy: string;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly sessionQueues = new Map<string, AsyncQueue<SessionEvent>>();
  private buffer = '';
  private closed = false;

  /** Kiro 推送的当前 agent 可用 skill 列表（name + description）。 */
  private _availableSkills: Array<{ name: string; description: string }> = [];
  /** Kiro 推送的当前 agent 可用工具名列表。 */
  private _availableTools: string[] = [];

  /** 获取最近一次 session 建好后 Kiro 推送的可用 skill 列表。 */
  get availableSkills(): Array<{ name: string; description: string }> {
    return this._availableSkills;
  }

  /** 获取最近一次 session 建好后 Kiro 推送的可用工具名列表。 */
  get availableTools(): string[] {
    return this._availableTools;
  }

  private constructor(proc: ResultPromise, config: AcpClientConfig) {
    this.proc = proc;
    this.responseTimeoutMs = config.responseTimeoutMs ?? 60_000;
    this.permissionPolicy = config.permissionPolicy ?? 'allow_once';
    this.attachReaders();
  }

  /** 启动 kiro-cli acp 子进程。 */
  static spawn(config: AcpClientConfig = {}): AcpClient {
    const bin = config.binPath ?? 'kiro-cli';
    const args = [...(config.args ?? ['acp'])];
    if (config.model) args.push('--model', config.model);
    log().debug({ bin, args, cwd: config.cwd }, 'spawning ACP subprocess');
    const proc = execa(bin, args, {
      cwd: config.cwd,
      reject: false,
      buffer: false,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: config.env ? { ...process.env, ...config.env } : undefined,
    });
    return new AcpClient(proc, config);
  }

  // ------------------------------------------------------------- public API

  /** ACP initialize 握手，返回代理的 agentCapabilities。 */
  async initialize(): Promise<unknown> {
    const result = (await this.call(Method.INITIALIZE, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'lark-kiro-bridge', version: '0.0.1' },
    })) as Record<string, any> | undefined;
    return result?.agentCapabilities ?? result;
  }

  /** 创建新 session，返回 sessionId（cwd 必须绝对路径）。 */
  async newSession(cwd: string): Promise<string> {
    if (!isAbsolute(cwd)) {
      throw new Error(`session/new cwd must be absolute, got ${cwd}`);
    }
    const result = (await this.call(Method.SESSION_NEW, {
      cwd,
      mcpServers: [],
    })) as Record<string, any> | undefined;
    const sessionId = result?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new AcpError(-1, 'session/new result missing sessionId');
    }
    this.sessionQueues.set(sessionId, new AsyncQueue<SessionEvent>());
    return sessionId;
  }

  /** 续接已有 session。cwd 必须绝对路径（Kiro 的 session/load 与 session/new 同样要求 cwd + mcpServers）。 */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    if (!isAbsolute(cwd)) {
      throw new Error(`session/load cwd must be absolute, got ${cwd}`);
    }
    // 在发请求前就建 queue：Kiro 收到 session/load 后会立刻重播该 session 的历史事件，
    // 如果等响应后才建 queue，重播事件全部被当成 "event for unknown session" 丢弃。
    // 提前建 queue 让这些事件有地方着落（runner 的 for-await 会自然跳过历史，只消费新 turn）。
    if (!this.sessionQueues.has(sessionId)) {
      this.sessionQueues.set(sessionId, new AsyncQueue<SessionEvent>());
    }
    await this.call(Method.SESSION_LOAD, { sessionId, cwd, mcpServers: [] });
  }

  /**
   * 发送 prompt，返回流式事件异步迭代器。
   * 收到 session/prompt 响应后投递 turn_end 并结束迭代。
   */
  prompt(sessionId: string, content: string): AsyncIterableIterator<SessionEvent> {
    const queue = this.sessionQueues.get(sessionId);
    if (!queue) {
      throw new Error(`unknown sessionId: ${sessionId}`);
    }
    // prompt 调用失败（JSON-RPC error / 子进程崩溃 / 超时）时记录错误，
    // iterate 在队列结束时据此抛出，让上层（runner）走 error 终态，
    // 而不是静默结束被误判为"成功完成"。
    let promptError: Error | null = null;
    // prompt 调用不设内部超时（或设为极大值），由 runner 的外部 timeout/idle 机制管理。
    // 默认的 responseTimeoutMs (60s) 对一个可能跑几分钟的 turn 来说太短。
    this.call(
      Method.SESSION_PROMPT,
      {
        sessionId,
        prompt: [{ type: 'text', text: content }],
      },
      30 * 60 * 1000,
    ).then(
      (result) => {
        const stopReason = (result as Record<string, any> | undefined)?.stopReason;
        queue.push({
          kind: 'turn_end',
          sessionId,
          stopReason: stopReason != null ? String(stopReason) : undefined,
        });
      },
      (err) => {
        log().debug({ err }, 'prompt call failed; closing session queue');
        promptError = err instanceof Error ? err : new Error(String(err));
        queue.close();
      },
    );
    return this.iterate(queue, () => promptError);
  }

  /** 取消当前 session 进行中的操作。 */
  async cancel(sessionId: string): Promise<void> {
    await this.call(Method.SESSION_CANCEL, { sessionId });
  }

  /** 关闭客户端：失败所有 pending、收尾队列、终止子进程。 */
  async close(): Promise<void> {
    this.finalize(new Error('ACP client closed'));
    try {
      this.proc.kill('SIGTERM');
    } catch {
      // 已退出
    }
    const exited = await Promise.race([
      this.proc.then(
        () => true,
        () => true,
      ),
      delay(5_000).then(() => false),
    ]);
    if (!exited) {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }

  // --------------------------------------------------------------- internal

  private async *iterate(
    queue: AsyncQueue<SessionEvent>,
    getError?: () => Error | null,
  ): AsyncIterableIterator<SessionEvent> {
    while (true) {
      const item = await queue.take();
      if (item === QUEUE_CLOSED) {
        // 队列因 prompt 失败而关闭时，把错误抛给上层而不是静默结束，
        // 避免 Kiro 报错被误判为"成功完成"（空回复 + done 终态）。
        const err = getError?.();
        if (err) throw err;
        return;
      }
      yield item;
      if (item.kind === 'turn_end') return;
    }
  }

  private call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('ACP client is closed'));
    }
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs ?? this.responseTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: JSONRPC_VERSION, id, method, params });
    });
  }

  private send(payload: object): void {
    if (this.closed) return;
    const stdin = this.proc.stdin;
    if (!stdin) return;
    try {
      stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (e) {
      log().debug({ err: e }, 'acp send failed');
    }
  }

  private attachReaders(): void {
    const stdout = this.proc.stdout;
    if (stdout) {
      stdout.setEncoding('utf-8');
      stdout.on('data', (chunk: string) => this.onStdout(chunk));
      stdout.on('end', () => this.finalize(new Error('ACP stdout closed')));
    }
    const stderr = this.proc.stderr;
    if (stderr) {
      stderr.setEncoding('utf-8');
      stderr.on('data', (chunk: string) => {
        const text = chunk.trim();
        if (text) log().debug({ stderr: text.slice(0, 500) }, 'kiro stderr');
      });
    }
    // 子进程意外退出 → 收尾，避免 pending 永久挂起
    this.proc.then(
      () => this.finalize(new Error('ACP subprocess exited')),
      () => this.finalize(new Error('ACP subprocess exited')),
    );
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.handleLine(line);
      nl = this.buffer.indexOf('\n');
    }
  }

  private handleLine(raw: string): void {
    const text = raw.trim();
    if (!text) return;
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      log().warn({ line: text.slice(0, 200) }, 'non-JSON line from ACP');
      return;
    }
    this.dispatch(msg);
  }

  private dispatch(msg: any): void {
    if (msg === null || typeof msg !== 'object') {
      log().warn({ msg }, 'unrecognized ACP message');
      return;
    }
    // 响应：无 method、有 id、含 result/error
    if (msg.method === undefined && msg.id !== undefined && ('result' in msg || 'error' in msg)) {
      this.handleResponse(msg);
      return;
    }
    // 通知：有 method、无 id
    if (typeof msg.method === 'string' && msg.id === undefined) {
      this.handleNotification(msg);
      return;
    }
    // 反向请求：有 method、有 id
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      this.handleReverseRequest(msg);
      return;
    }
    log().warn({ msg }, 'unrecognized ACP message');
  }

  private handleResponse(msg: any): void {
    const id = msg.id;
    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.error != null) {
      pending.reject(AcpError.fromWire(msg.error as JsonRpcErrorObject));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleNotification(msg: any): void {
    const method = msg.method as string;
    const params = (msg.params ?? {}) as Record<string, any>;

    if (method === Method.SESSION_UPDATE) {
      this.handleSessionUpdate(params);
      return;
    }
    if (method === '_kiro.dev/metadata') {
      const credits = extractCredits(params.meteringUsage);
      log().debug(
        {
          contextUsagePercentage: params.contextUsagePercentage,
          credits,
          turnDurationMs: params.turnDurationMs,
        },
        'kiro metadata',
      );
      // 投递到 session 队列，让卡片能展示用量/成本（最后一次带 credits/耗时）
      const sessionId = String(params.sessionId ?? params.session_id ?? '');
      const queue = this.sessionQueues.get(sessionId);
      if (queue) {
        const ev: MetadataEvent = { kind: 'metadata', sessionId };
        if (typeof params.contextUsagePercentage === 'number') {
          ev.contextUsagePercentage = params.contextUsagePercentage;
        }
        if (typeof credits === 'number') ev.credits = credits;
        if (typeof params.turnDurationMs === 'number') ev.turnDurationMs = params.turnDurationMs;
        queue.push(ev);
      }
      return;
    }
    if (method === '_kiro.dev/commands/available') {
      // Kiro 推送当前 agent 可用的 skills + tools 列表。存到实例属性，外部可读。
      this._availableSkills = parseSkills(params.skills);
      this._availableTools = parseToolNames(params.tools);
      log().debug(
        { skills: this._availableSkills.length, tools: this._availableTools.length },
        'commands/available received',
      );
      return;
    }
    // 其他通知（含 _kiro.dev/*）安全忽略
    log().debug({ method }, 'ignoring notification');
  }

  private handleSessionUpdate(params: Record<string, any>): void {
    const sessionId = String(params.sessionId ?? params.session_id ?? '');
    const update = params.update && typeof params.update === 'object' ? params.update : params;
    const kind = update.sessionUpdate ?? update.type;
    const queue = this.sessionQueues.get(sessionId);
    if (!queue) {
      log().warn({ sessionId, kind }, 'event for unknown session');
      return;
    }
    const event = mapUpdate(sessionId, kind, update);
    if (event) queue.push(event);
  }

  private handleReverseRequest(msg: any): void {
    const method = msg.method as string;
    const id = msg.id;
    const params = (msg.params ?? {}) as Record<string, any>;

    if (method === 'session/request_permission') {
      this.respondPermission(id, params);
      return;
    }
    // 其他反向请求（fs/* terminal/* 等）暂不实现，回 method-not-found
    log().warn({ method, id }, 'unimplemented reverse request; replying -32601');
    this.send({
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code: -32601, message: `client does not implement ${method}` },
    });
  }

  private respondPermission(id: unknown, params: Record<string, any>): void {
    const options: any[] = Array.isArray(params.options) ? params.options : [];
    let chosen: string | undefined;
    for (const opt of options) {
      if (opt && opt.kind === this.permissionPolicy) {
        chosen = String(opt.optionId ?? '');
        break;
      }
    }
    if (chosen === undefined) {
      const first = options.find((o) => o && o.optionId !== undefined);
      if (first) chosen = String(first.optionId);
    }
    if (chosen === undefined) {
      log().warn({ params }, 'permission request has no usable options');
      this.send({ jsonrpc: JSONRPC_VERSION, id, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    log().debug({ policy: this.permissionPolicy, optionId: chosen }, 'auto-responding permission');
    this.send({
      jsonrpc: JSONRPC_VERSION,
      id,
      result: { outcome: { outcome: 'selected', optionId: chosen } },
    });
  }

  /** 收尾：失败所有 pending，关闭所有 session 队列。幂等。 */
  private finalize(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    for (const queue of this.sessionQueues.values()) {
      queue.close();
    }
  }
}
