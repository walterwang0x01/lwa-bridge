/**
 * 把 RunState 渲染成飞书 v2 卡片 JSON
 *
 * 设计目标见下方注释。
 *
 * 视觉策略：
 *   - 工具调用 < 3 个：每个独立 collapsible_panel
 *   - 工具调用 ≥ 3 个：
 *     - 进行中：前面的折叠成「☕ N 个工具调用」总结，最新的 1 个完整展示
 *     - 已结束：全部折叠成总结
 *   - 思考过程独立 panel；进行中默认展开，结束后默认折叠
 *   - 进行中底部显示 footer status（🧠/🧰/✍️）和 ⏹ 终止按钮
 *   - 完成态去掉 footer 和按钮
 *   - 卡片配置 streaming_mode=true（进行中）让飞书显示打字光标
 *   - summary.content 在飞书通知列表显示状态
 */
import type { Block, FooterStatus, RunState, ToolEntry } from '../kiro/runState.js';
import { toolBodyMd, toolHeaderText } from './toolRender.js';
import { renderPlanElements, shouldShowPlan } from '../plan/render.js';

const REASONING_MAX = 1500;
const COLLAPSE_TOOL_THRESHOLD = 3;

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

/**
 * 渲染一张完整的卡片 JSON。
 */
export function renderRunCard(state: RunState): object {
  const elements: object[] = [];

  // 任务计划 panel（如果有）—— 在主体最顶部，让用户优先看到进度
  if (shouldShowPlan(state.plan)) {
    elements.push(...renderPlanElements(state.plan));
  }

  // 思考过程 panel
  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  // 工具组 + 文本块按时序展示
  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        elements.push(markdown(group.content));
      }
    } else {
      elements.push(...renderToolGroup(group.tools, state.terminal !== 'running'));
    }
  }

  // 终态注解
  if (state.terminal === 'interrupted') {
    elements.push(noteMd("<font color='grey'>⏹ 已被中断</font>"));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`<font color='grey'>⏱ ${mins} 分钟无响应，已自动终止</font>`));
  } else if (state.terminal === 'timeout') {
    // 总超时：跟 idle_timeout 区分——这里是任务真在跑、只是太久没完。
    // 已产出的 blocks 全保留（前面已经渲染过），只在尾部加状态行 + 一个"继续"按钮
    elements.push(
      noteMd("<font color='orange'>⏰ 任务超时（已运行超过最大时长），上方为已完成的部分</font>"),
    );
    elements.push(continueButton());
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`<font color='red'>⚠️ Kiro 失败：${escapeMd(state.errorMsg)}</font>`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd("<font color='grey'>（未返回内容）</font>"));
  }

  // 进行中：底部状态 + 终止按钮
  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state.footer));
    elements.push(stopButton());
  }

  return {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    header: cardHeader(state),
    body: { elements },
  };
}

/** 卡片 header（含 title + template 颜色） */
function cardHeader(state: RunState): object {
  const { title, template } = headerOf(state.terminal);
  return {
    title: { tag: 'plain_text', content: title },
    template,
  };
}

function headerOf(terminal: RunState['terminal']): { title: string; template: string } {
  switch (terminal) {
    case 'running':
      return { title: '💬 Kiro', template: 'blue' };
    case 'done':
      return { title: '✅ Kiro', template: 'green' };
    case 'error':
      return { title: '❌ Kiro 出错', template: 'red' };
    case 'interrupted':
      return { title: '⏹ 已中止', template: 'orange' };
    case 'idle_timeout':
      return { title: '⏱ 超时', template: 'red' };
    case 'timeout':
      // 跟 error 区分用 yellow（飞书 template）：黄色暗示"产出可用，但需要后续动作"
      return { title: '⏰ 任务超时（已产出可用）', template: 'yellow' };
  }
}

/**
 * 把 blocks 按相邻同类型分组。
 * 连续的工具块合并成一个 ToolGroup，方便后续做"≥3 折叠"逻辑。
 */
function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

/**
 * 渲染一组工具调用。
 * - 工具数 < 3：每个独立 panel
 * - 工具数 ≥ 3：
 *   - finalized=true（任务已结束）：全部折叠成 summary
 *   - finalized=false（进行中）：前 N-1 折叠成 summary，最新 1 个完整展示
 */
function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  // 进行中：前面的折叠，最新的展开
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

/** 思考过程 panel */
function reasoningPanel(content: string, active: boolean): object {
  const title = active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**';
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

/** 单个工具调用 panel */
function toolPanel(tool: ToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || "<font color='grey'>无输出</font>",
  });
}

/**
 * 多个工具调用折叠成一个总结面板。
 * 只显示每个工具的 header（图标 + 名字 + 简短摘要），不显示 body。
 * 因为完整 body 嵌套很容易超过飞书 30KB 单 element 限制。
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): object {
  const suffix = finalized ? '（已结束）' : '';
  const title = `☕ **${tools.length} 个工具调用${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join('\n');
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: headerList, text_size: 'notation' }],
  };
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  body: string;
}

function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function stopButton(): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    size: 'small',
    behaviors: [{ type: 'callback', value: { action: 'session.stop' } }],
  };
}

/**
 * "继续未完成部分"按钮——出现在 timeout 终态卡片底部。
 * 点击后 dispatcher 会在同一 chat 复用 sessionId 触发新一轮 prompt：
 *   "继续上次未完成的工作"
 * kiro-cli 借助 session 续接读到上下文，知道接着干哪一步。
 */
function continueButton(): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '▶️ 继续未完成的部分' },
    type: 'primary',
    size: 'small',
    behaviors: [{ type: 'callback', value: { action: 'session.continue' } }],
  };
}

function footerStatus(status: Exclude<FooterStatus, null>): object {
  const text =
    status === 'thinking'
      ? "<font color='grey'>🧠 正在思考</font>"
      : status === 'tool_running'
        ? "<font color='grey'>🧰 正在调用工具</font>"
        : "<font color='grey'>✍️ 正在输出</font>";
  return noteMd(text);
}

/** 飞书通知列表里显示的简短摘要 */
function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'timeout') return '超时（已产出可用）';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}
