/**
 * RunCardController.applyEvent 映射测试
 *
 * 验证 ACP SessionEvent → RunState 的结构化映射：
 *   - message       → text block（连续 message 合并进同一块）
 *   - thought       → reasoning
 *   - tool（首次）  → 新建 tool entry（name 规范化 + input 透传 + status 映射）
 *   - tool（更新）  → 按 toolCallId 更新已有 entry 的 status
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { RunCardController } from './runCardController.js';
import type { LarkClient } from '../lark/client.js';
import type { RunState } from '../kiro/runState.js';

const controllers: RunCardController[] = [];

function makeController(): RunCardController {
  const noop = () => undefined;
  const logger = {
    child: () => logger,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    trace: noop,
  } as unknown as Logger;
  const lark = {} as unknown as LarkClient;
  // intervalMs 设大；测试不触发真实 patch（无 messageId），结束时 discard 清理定时器
  const ctrl = new RunCardController({ lark, chatId: 'c1', intervalMs: 100_000, logger });
  controllers.push(ctrl);
  return ctrl;
}

function stateOf(ctrl: RunCardController): RunState {
  return (ctrl as unknown as { state: RunState }).state;
}

/**
 * 造一个能记录 patchCard 调用、且 patch 有可控延迟的 controller，
 * 用于测试「流式 flush 与 finalize 的 patch 竞态」。
 * 注入 messageId 让 patch 路径真正执行。
 */
function makeRacingController(patchDelayMs: number): {
  ctrl: RunCardController;
  patched: Array<{ streaming: boolean; template: string }>;
} {
  const noop = () => undefined;
  const logger = {
    child: () => logger,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    trace: noop,
  } as unknown as Logger;
  const patched: Array<{ streaming: boolean; template: string }> = [];
  const lark = {
    patchCard: async (_id: string, card: unknown) => {
      const c = card as {
        config?: { streaming_mode?: boolean };
        header?: { template?: string };
      };
      await new Promise((r) => setTimeout(r, patchDelayMs));
      patched.push({
        streaming: c.config?.streaming_mode === true,
        template: c.header?.template ?? '',
      });
    },
  } as unknown as LarkClient;
  const ctrl = new RunCardController({ lark, chatId: 'c1', intervalMs: 5, logger });
  (ctrl as unknown as { messageId: string }).messageId = 'om_test';
  controllers.push(ctrl);
  return { ctrl, patched };
}

afterEach(() => {
  // discard 在无 messageId 时是纯同步：取消 debounce 定时器，不触碰 lark
  for (const c of controllers.splice(0)) void c.discard();
});

describe('RunCardController.applyEvent', () => {
  it('message → 合并进同一个 text block', () => {
    const ctrl = makeController();
    ctrl.applyEvent({ kind: 'message', sessionId: 's', text: 'Hello ' });
    ctrl.applyEvent({ kind: 'message', sessionId: 's', text: 'world' });
    const st = stateOf(ctrl);
    expect(st.blocks).toHaveLength(1);
    expect(st.blocks[0]).toEqual({ kind: 'text', content: 'Hello world' });
  });

  it('thought → 写入 reasoning', () => {
    const ctrl = makeController();
    ctrl.applyEvent({ kind: 'thought', sessionId: 's', text: '先读文件' });
    ctrl.applyEvent({ kind: 'thought', sessionId: 's', text: '再改代码' });
    const st = stateOf(ctrl);
    expect(st.reasoning.content).toBe('先读文件再改代码');
    expect(st.reasoning.active).toBe(true);
    expect(st.blocks).toHaveLength(0);
  });

  it('tool_call → 新建 tool entry（name 规范化 + input 透传 + running 状态）', () => {
    const ctrl = makeController();
    ctrl.applyEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't1',
      name: 'execute_bash',
      status: 'pending',
      raw: { sessionUpdate: 'tool_call', rawInput: { command: 'ls -la' } },
    });
    const st = stateOf(ctrl);
    expect(st.blocks).toHaveLength(1);
    const block = st.blocks[0];
    expect(block?.kind).toBe('tool');
    if (block?.kind === 'tool') {
      expect(block.tool.name).toBe('Bash');
      expect(block.tool.status).toBe('running');
      expect(block.tool.input).toEqual({ command: 'ls -la' });
      expect(block.tool.finishedAt).toBeUndefined();
    }
  });

  it('tool_call_update → 按 toolCallId 更新状态，不新增块', () => {
    const ctrl = makeController();
    ctrl.applyEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't1',
      name: 'bash',
      status: 'in_progress',
      raw: { sessionUpdate: 'tool_call' },
    });
    ctrl.applyEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't1',
      name: 'bash',
      status: 'completed',
      raw: { sessionUpdate: 'tool_call_update' },
    });
    const st = stateOf(ctrl);
    expect(st.blocks).toHaveLength(1);
    const block = st.blocks[0];
    if (block?.kind === 'tool') {
      expect(block.tool.status).toBe('done');
      expect(block.tool.finishedAt).toBeTypeOf('number');
    }
  });

  it('tool status failed → error', () => {
    const ctrl = makeController();
    ctrl.applyEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't2',
      name: 'fs_read',
      status: 'pending',
      raw: {},
    });
    ctrl.applyEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't2',
      name: 'fs_read',
      status: 'failed',
      raw: {},
    });
    const st = stateOf(ctrl);
    const block = st.blocks[0];
    if (block?.kind === 'tool') {
      expect(block.tool.name).toBe('Read');
      expect(block.tool.status).toBe('error');
    }
  });

  it('turn_end → no-op（不改 blocks/reasoning）', () => {
    const ctrl = makeController();
    ctrl.applyEvent({ kind: 'message', sessionId: 's', text: 'done' });
    ctrl.applyEvent({ kind: 'turn_end', sessionId: 's', stopReason: 'end_turn' });
    const st = stateOf(ctrl);
    expect(st.blocks).toHaveLength(1);
    expect(st.blocks[0]).toEqual({ kind: 'text', content: 'done' });
  });

  it('metadata → 累积到 state.usage（contextPercent 取最新，credits/耗时取最后带的）', () => {
    const ctrl = makeController();
    // 第一条只有 context（turn 开始）
    ctrl.applyEvent({ kind: 'metadata', sessionId: 's', contextUsagePercentage: 6.7 });
    // 最后一条带 credits + 耗时 + 更新的 context（turn 结束）
    ctrl.applyEvent({
      kind: 'metadata',
      sessionId: 's',
      contextUsagePercentage: 12.0,
      credits: 0.37,
      turnDurationMs: 8054,
    });
    const u = stateOf(ctrl).usage;
    expect(u?.contextPercent).toBe(12.0);
    expect(u?.credits).toBe(0.37);
    expect(u?.turnDurationMs).toBe(8054);
  });

  it('提取 ACP title / kind / purpose / rawOutput.Text', () => {
    const ctrl = makeController();
    ctrl.applyEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't-read',
      name: 'fs_read',
      status: 'completed',
      raw: {
        sessionUpdate: 'tool_call_update',
        title: 'Reading sample.txt:1',
        kind: 'read',
        rawInput: { __tool_use_purpose: '读取配置', operations: [] },
        rawOutput: { items: [{ Text: 'hello from probe\nline2' }] },
      },
    });
    const block = stateOf(ctrl).blocks[0];
    expect(block?.kind).toBe('tool');
    if (block?.kind === 'tool') {
      expect(block.tool.title).toBe('Reading sample.txt:1');
      expect(block.tool.kind).toBe('read');
      expect(block.tool.purpose).toBe('读取配置');
      expect(block.tool.output).toBe('hello from probe\nline2');
    }
  });

  it('提取 shell rawOutput.items[].Json 的 stdout', () => {
    const ctrl = makeController();
    ctrl.applyEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't-bash',
      name: 'execute_bash',
      status: 'completed',
      raw: {
        sessionUpdate: 'tool_call_update',
        rawOutput: {
          items: [{ Json: { exit_status: 'exit status: 0', stdout: 'done\n', stderr: '' } }],
        },
      },
    });
    const block = stateOf(ctrl).blocks[0];
    if (block?.kind === 'tool') {
      expect(block.tool.output).toBe('done');
    }
  });

  it('tool 结果跨多条 update 合并（title 先到、output 后到）', () => {
    const ctrl = makeController();
    ctrl.applyEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't-x',
      name: 'execute_bash',
      status: 'pending',
      raw: { sessionUpdate: 'tool_call', title: 'Running: echo hi', kind: 'execute' },
    });
    ctrl.applyEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't-x',
      name: 'execute_bash',
      status: 'completed',
      raw: {
        sessionUpdate: 'tool_call_update',
        content: [{ type: 'content', content: { type: 'text', text: 'hi\n' } }],
      },
    });
    const st = stateOf(ctrl);
    expect(st.blocks).toHaveLength(1);
    const block = st.blocks[0];
    if (block?.kind === 'tool') {
      expect(block.tool.title).toBe('Running: echo hi');
      expect(block.tool.status).toBe('done');
      expect(block.tool.output).toBe('hi');
    }
  });
});

describe('RunCardController patch 竞态', () => {
  it('finalize 的 done 不被延迟的流式 flush 覆盖（最后一次 patch 必为 done）', async () => {
    // patch 有 20ms 延迟：模拟流式 flush 的 patch 还在飞行时 finalize 就被调
    const { ctrl, patched } = makeRacingController(20);

    // 触发一次流式 flush（debounce 5ms 后执行，patch 耗时 20ms）
    ctrl.applyEvent({ kind: 'message', sessionId: 's', text: '流式中…' });
    // 等 flush 的 patch 进入飞行（debounce 触发但 patch 未完成）
    await new Promise((r) => setTimeout(r, 8));

    // 此时 finalize：done patch 应排在飞行中的 flush 之后，且后续无覆盖
    await ctrl.finalize('done');

    // 再等一会，确保没有延迟的 flush 在 finalize 之后偷偷 patch
    await new Promise((r) => setTimeout(r, 40));

    expect(patched.length).toBeGreaterThan(0);
    const last = patched[patched.length - 1];
    // 最后一次 patch 必须是 done 态：非 streaming、绿色 header
    expect(last?.streaming).toBe(false);
    expect(last?.template).toBe('green');
  });
});
