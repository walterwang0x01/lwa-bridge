import { describe, expect, it, vi } from 'vitest';
import { listSlashCommands, pickFromList, setCliInteract } from './slashPicker.js';

describe('slashPicker', () => {
  it('lists core slash commands for code mode', () => {
    const cmds = listSlashCommands('code');
    const names = cmds.map((c) => c.cmd);
    expect(names).toContain('/model');
    expect(names).toContain('/runtime');
    expect(names).toContain('/runtime auto');
    expect(names).toContain('/help');
    expect(cmds.find((c) => c.cmd === '/model')?.insert).toBe('/model');
  });
});

/**
 * 复现（真实截图报告的 /model 引擎切换问题的真正根因，用真实 Python pty 测试
 * 定位，非代码推理，见 PROGRESS.md 的完整调查记录）：
 *
 * 1. Node 内部 readline.emitKeypressEvents（channel.ts 的 this.rl 构造时自动
 *    挂载，全程存在，close() 也无法移除）有一个内部 'data' 处理器，逻辑是
 *    `if (stream.listenerCount('keypress') > 0) { ...才完整处理并传播... }`。
 *    若把 keypress 监听器数量清空到 0，方向键等多字节 CSI 序列会被这个内部
 *    处理器消费但未完整处理，我们自己的 'data' 监听器完全收不到。
 * 2. pickFromList 原来的执行顺序是先 render()（同步渲染一次菜单）再在
 *    Promise 内部注册 stdin.on('data', onData)。这中间的时间窗口里如果用户
 *    按键，会被 Node 内部处理器独自处理掉（此时它是唯一的 'data' 监听器）。
 *
 * 修复：(a) 保留一个空操作的 'keypress' 占位监听器，不清空到 0；
 *      (b) 把 onData 的定义和注册提前到 render() 调用之前。
 * 真实效果：修复前，方向键按下后菜单永远停在默认高亮项，Enter 确认的是
 * 从未被方向键移动过的第一项；修复后，方向键正确移动高亮，Enter 确认用户
 * 真正选中的项。
 */
describe('pickFromList — arrow key handling regression', () => {
  function mockStdin() {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const stdin = {
      isTTY: true,
      isRaw: false,
      setRawMode: vi.fn((v: boolean) => {
        stdin.isRaw = v;
        return stdin;
      }),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        const arr = listeners.get(event) ?? [];
        arr.push(fn);
        listeners.set(event, arr);
        return stdin;
      }),
      off: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        const arr = listeners.get(event) ?? [];
        listeners.set(
          event,
          arr.filter((f) => f !== fn),
        );
        return stdin;
      }),
      removeListener: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        const arr = listeners.get(event) ?? [];
        listeners.set(
          event,
          arr.filter((f) => f !== fn),
        );
        return stdin;
      }),
      listeners: vi.fn((event: string) => [...(listeners.get(event) ?? [])]),
      listenerCount: vi.fn((event: string) => (listeners.get(event) ?? []).length),
      emit(event: string, ...args: unknown[]) {
        for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
      },
    };
    return stdin;
  }

  it('never drops the keypress listener count to zero while running', async () => {
    const stdin = mockStdin();
    const writes: string[] = [];
    vi.stubGlobal('process', {
      ...process,
      stdin,
      stdout: { isTTY: true, columns: 80, rows: 24, write: (s: string) => writes.push(s) },
    });
    setCliInteract({ ask: async () => '', pauseReadline: vi.fn(), resumeReadline: vi.fn() });

    const items = [
      { value: 'auto', label: 'Auto', hint: '' },
      { value: 'kiro', label: '[engine] kiro', hint: '' },
    ];
    const promise = pickFromList({ title: 'Select', items });

    // 运行期间必须始终存在至少一个 keypress 监听器（占位或真实），否则 Node
    // 内部的按键解析器会认为"无人关心"，导致多字节转义序列（方向键）被消费
    // 但不完整处理，永远传不到我们自己的 'data' 监听器。
    expect(stdin.listenerCount('keypress')).toBeGreaterThan(0);

    stdin.emit('data', '\u001b[B'); // 方向键：移动到第二项
    stdin.emit('data', '\r'); // Enter 确认
    const picked = await promise;
    expect(picked).toBe('kiro');

    setCliInteract(null);
    vi.unstubAllGlobals();
  });

  it('registers the data listener before the first render, not after', async () => {
    const stdin = mockStdin();
    const writeOrder: string[] = [];
    const originalOn = stdin.on;
    stdin.on = vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      if (event === 'data') writeOrder.push('data-listener-registered');
      return originalOn(event, fn);
    }) as typeof stdin.on;
    vi.stubGlobal('process', {
      ...process,
      stdin,
      stdout: {
        isTTY: true,
        columns: 80,
        rows: 24,
        write: (s: string) => {
          // 只记录真正的菜单渲染写入（跳过 setRawMode 等前置调用产生的空写）
          if (s) writeOrder.push('render-write');
        },
      },
    });
    setCliInteract({ ask: async () => '', pauseReadline: vi.fn(), resumeReadline: vi.fn() });

    const items = [{ value: 'auto', label: 'Auto', hint: '' }];
    const promise = pickFromList({ title: 'Select', items });
    stdin.emit('data', '\r');
    await promise;

    const dataIdx = writeOrder.indexOf('data-listener-registered');
    const renderIdx = writeOrder.indexOf('render-write');
    expect(dataIdx).toBeGreaterThanOrEqual(0);
    expect(renderIdx).toBeGreaterThanOrEqual(0);
    expect(dataIdx).toBeLessThan(renderIdx);

    setCliInteract(null);
    vi.unstubAllGlobals();
  });
});
