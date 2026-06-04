/**
 * 一次 Kiro 任务的运行状态
 *
 * 设计目标：把 kiro-cli 的 stdout 流解析成结构化的 RunState 对象，
 * 让卡片渲染器可以直接读这个对象渲染漂亮的分块卡片，而不是处理
 * 一坨字符串。
 *
 * 数据模型：
 *   - blocks: 按时间顺序的"文本块 + 工具调用块"
 *   - reasoning: LLM 思考过程（如果 kiro 输出了的话）
 *   - terminal: 终态（done/error/interrupted/idle_timeout）
 *   - footer: 底部状态指示（思考中/调工具中/输出中）
 */

/**
 * 一次工具调用的完整记录。
 * 飞书卡片 panel 用 id 做 stable key（避免重新渲染时 panel 收起）。
 */
export interface ToolEntry {
  /** 稳定 id，用于卡片 panel key */
  id: string;
  /**
   * 工具名。kiro-cli 输出的工具名是小写带下划线（fs_read / execute_bash）。
   * 我们规范化成更易读的名字（Read / Bash / Grep / WebFetch 等）。
   */
  name: string;
  /**
   * Kiro 通过 ACP 提供的人类可读标题（如 "Running: echo done"、"Reading sample.txt:1"）。
   * 比自己拼的 name+input 摘要更准、更通用（MCP 工具也有）；渲染 header 时优先用它。
   */
  title?: string;
  /**
   * 工具类别（ACP 的 kind：read / execute / edit / search / fetch 等）。
   * 用于选更贴切的状态图标。
   */
  kind?: string;
  /** Kiro 说明本次调用目的（ACP rawInput.__tool_use_purpose），作为副标题展示。 */
  purpose?: string;
  /** 工具输入参数（结构因工具而异） */
  input: Record<string, unknown>;
  /** 工具的输出（命令 stdout 或文件内容片段；可选） */
  output?: string;
  /** 状态：进行中 / 完成 / 失败 */
  status: 'running' | 'done' | 'error';
  /** 开始时间戳 */
  startedAt: number;
  /** 完成时间戳（status 转 done/error 时填） */
  finishedAt?: number;
}

/**
 * blocks 里的最小展示单元。
 * 文本块 = LLM 的真正回复段落
 * 工具块 = 一次工具调用
 */
export type Block = { kind: 'text'; content: string } | { kind: 'tool'; tool: ToolEntry };

/**
 * 思考过程（reasoning）。kiro-cli 在某些模型下会输出 "Thinking: ..." 段。
 * 暂时保留接口，当前实现里 active=true，content 不动。
 */
export interface Reasoning {
  content: string;
  active: boolean;
}

/**
 * 终态。
 *  - running: 还在跑
 *  - done: 正常结束
 *  - error: kiro-cli 报错或 exitCode != 0
 *  - interrupted: 用户主动中止（点了 stop 按钮 或 /stop）
 *  - idle_timeout: 触发空闲 watchdog
 *  - timeout: 触发总超时（区别于 error：保留全部已产出内容；用户可点"继续未完成部分"）
 */
export type TerminalState =
  | 'running'
  | 'done'
  | 'error'
  | 'interrupted'
  | 'idle_timeout'
  | 'timeout';

/**
 * 底部进度状态指示。null 表示不显示。
 */
export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;

export interface RunState {
  /** 时序排列的展示块（文本 + 工具） */
  blocks: Block[];
  /** 思考过程 */
  reasoning: Reasoning;
  /** 终态 */
  terminal: TerminalState;
  /** 错误信息（terminal === 'error' 时填） */
  errorMsg?: string;
  /** 底部进度提示 */
  footer: FooterStatus;
  /** Idle watchdog 阈值（分钟）；展示用 */
  idleTimeoutMinutes?: number;
  /**
   * 任务计划（可选）——存在时由 renderRunCard 在主体顶部渲染一个 plan 面板。
   * 数据来源由 PlanSource 提供（当前是 FilePlanSource，将来 ACP）。
   */
  plan?: import('../plan/types.js').Plan;
}

/** 创建一个初始 RunState */
export function createInitialState(idleTimeoutMinutes?: number): RunState {
  const state: RunState = {
    blocks: [],
    reasoning: { content: '', active: false },
    terminal: 'running',
    footer: 'thinking',
  };
  if (idleTimeoutMinutes !== undefined) {
    state.idleTimeoutMinutes = idleTimeoutMinutes;
  }
  return state;
}

// ----- 状态变更操作（mutator 风格，调用方就地改 state） -----

/**
 * 把当前最后一个 running 工具拿出来；没有则返回 undefined。
 * 用于"完成上一个 running 工具"这类操作。
 */
export function findLastRunningTool(state: RunState): ToolEntry | undefined {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const b = state.blocks[i];
    if (b && b.kind === 'tool' && b.tool.status === 'running') return b.tool;
  }
  return undefined;
}

/** 追加一个工具调用 */
export function pushTool(state: RunState, tool: ToolEntry): void {
  state.blocks.push({ kind: 'tool', tool });
  state.footer = 'tool_running';
}

/**
 * 追加文本到最后一个 text block；如果最后一个不是 text，新建一个。
 * 用于流式累积 LLM 回复。
 */
export function appendText(state: RunState, content: string): void {
  if (!content) return;
  const last = state.blocks[state.blocks.length - 1];
  if (last && last.kind === 'text') {
    last.content += content;
  } else {
    state.blocks.push({ kind: 'text', content });
  }
  state.footer = 'streaming';
}

/**
 * 把当前 running 的工具标记成 done/error，并填入 output（如果有）。
 */
export function finishLastRunningTool(
  state: RunState,
  status: 'done' | 'error',
  output?: string,
): void {
  const tool = findLastRunningTool(state);
  if (!tool) return;
  tool.status = status;
  tool.finishedAt = Date.now();
  if (output !== undefined) tool.output = output;
}

/** 给当前 running 的工具追加 output 文本 */
export function appendToolOutput(state: RunState, chunk: string): void {
  if (!chunk) return;
  const tool = findLastRunningTool(state);
  if (!tool) return;
  tool.output = (tool.output ?? '') + chunk;
}
