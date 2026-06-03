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
});
