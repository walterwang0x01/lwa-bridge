// AcpClient 单元测试：用真子进程跑 fakeAcpServer.mjs，吐预设 JSON-RPC 行。
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpClient, type AcpClientConfig } from './client.js';
import type { SessionEvent } from './messages.js';

const FAKE = fileURLToPath(new URL('./fakeAcpServer.mjs', import.meta.url));
const ABS_CWD = process.cwd();

const clients: AcpClient[] = [];

function makeClient(script: object, overrides: Partial<AcpClientConfig> = {}): AcpClient {
  const client = AcpClient.spawn({
    binPath: process.execPath,
    args: [FAKE],
    env: { ACP_FAKE_SCRIPT: JSON.stringify(script) },
    responseTimeoutMs: 2_000,
    ...overrides,
  });
  clients.push(client);
  return client;
}

async function collect(
  client: AcpClient,
  sessionId: string,
  text: string,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const ev of client.prompt(sessionId, text)) events.push(ev);
  return events;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe('AcpClient.initialize', () => {
  it('握手返回 agentCapabilities', async () => {
    const caps = { promptCapabilities: { image: false } };
    const client = makeClient({ initialize: { protocolVersion: 1, agentCapabilities: caps } });
    await expect(client.initialize()).resolves.toEqual(caps);
  });
});

describe('AcpClient.newSession', () => {
  it('相对路径报错', async () => {
    const client = makeClient({ sessionNew: { sessionId: 's1' } });
    await expect(client.newSession('relative/dir')).rejects.toThrow(/absolute/);
  });

  it('绝对路径返回 sessionId', async () => {
    const client = makeClient({ sessionNew: { sessionId: 'sess_abc' } });
    await expect(client.newSession(ABS_CWD)).resolves.toBe('sess_abc');
  });
});

describe('AcpClient.prompt', () => {
  it('完整 turn：多个 message + tool_call + tool_call_update + turn_end 顺序不乱', async () => {
    const client = makeClient({
      sessionNew: { sessionId: 'sess_turn' },
      prompts: [
        {
          notifications: [
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
            { sessionUpdate: 'tool_call', toolCallId: 't1', name: 'bash', status: 'pending' },
            {
              sessionUpdate: 'tool_call_update',
              toolCallId: 't1',
              name: 'bash',
              status: 'completed',
            },
          ],
          result: { stopReason: 'end_turn' },
        },
      ],
    });
    const sid = await client.newSession(ABS_CWD);
    const events = await collect(client, sid, 'hi');

    expect(events.map((e) => e.kind)).toEqual(['message', 'message', 'tool', 'tool', 'turn_end']);
    expect((events[0] as { text: string }).text).toBe('Hello ');
    expect((events[1] as { text: string }).text).toBe('world');
    const tool0 = events[2] as { toolCallId: string; name: string; status: string };
    expect(tool0).toMatchObject({ toolCallId: 't1', name: 'bash', status: 'pending' });
    expect((events[3] as { status: string }).status).toBe('completed');
    expect((events[4] as { stopReason: string }).stopReason).toBe('end_turn');
  });

  it('未识别通知（plan / 未知类型）被安全忽略', async () => {
    const client = makeClient({
      sessionNew: { sessionId: 'sess_ign' },
      prompts: [
        {
          notifications: [
            { sessionUpdate: 'plan', entries: [] },
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
            { sessionUpdate: 'totally_unknown', foo: 1 },
          ],
          result: { stopReason: 'end_turn' },
        },
      ],
    });
    const sid = await client.newSession(ABS_CWD);
    const events = await collect(client, sid, 'hi');
    expect(events.map((e) => e.kind)).toEqual(['message', 'turn_end']);
  });

  it('permission 反向请求自动应答（allow_once）', async () => {
    const client = makeClient({
      sessionNew: { sessionId: 'sess_perm' },
      prompts: [
        {
          reverseRequests: [
            {
              method: 'session/request_permission',
              params: {
                options: [
                  { kind: 'allow_once', optionId: 'opt-allow' },
                  { kind: 'reject_once', optionId: 'opt-reject' },
                ],
              },
            },
          ],
          result: { stopReason: 'end_turn' },
        },
      ],
    });
    const sid = await client.newSession(ABS_CWD);
    const events = await collect(client, sid, 'do it');
    const echo = events.find((e) => e.kind === 'message') as { text: string } | undefined;
    expect(echo?.text).toContain('selected');
    expect(echo?.text).toContain('opt-allow');
    expect(events.at(-1)?.kind).toBe('turn_end');
  });

  it('未实现反向请求回 -32601', async () => {
    const client = makeClient({
      sessionNew: { sessionId: 'sess_unimpl' },
      prompts: [
        {
          reverseRequests: [{ method: 'fs/read_text_file', params: { path: '/x' } }],
          result: { stopReason: 'end_turn' },
        },
      ],
    });
    const sid = await client.newSession(ABS_CWD);
    const events = await collect(client, sid, 'read');
    const echo = events.find((e) => e.kind === 'message') as { text: string } | undefined;
    expect(echo?.text).toContain('-32601');
    expect(echo?.text).toContain('error');
  });
});

describe('AcpClient lifecycle', () => {
  it('_call 超时被拒绝', async () => {
    const client = makeClient(
      { behaviors: { noRespondInitialize: true } },
      { responseTimeoutMs: 200 },
    );
    await expect(client.initialize()).rejects.toThrow(/timed out/);
  });

  it('close 后 pending 调用失败', async () => {
    const client = makeClient(
      { behaviors: { noRespondInitialize: true } },
      { responseTimeoutMs: 10_000 },
    );
    const pending = client.initialize();
    const guarded = pending.catch((e: Error) => e);
    await client.close();
    const err = await guarded;
    expect(String(err)).toMatch(/closed/);
  });

  it('子进程崩溃后事件源收尾，迭代器结束', async () => {
    const client = makeClient({
      sessionNew: { sessionId: 'sess_crash' },
      prompts: [
        {
          notifications: [
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } },
          ],
        },
      ],
      behaviors: { crashDuringPrompt: true },
    });
    const sid = await client.newSession(ABS_CWD);
    const events = await collect(client, sid, 'go');
    // 崩溃前的 message 应收到，但没有 turn_end，且迭代器正常结束
    expect(
      events.some((e) => e.kind === 'message' && (e as { text: string }).text === 'partial'),
    ).toBe(true);
    expect(events.some((e) => e.kind === 'turn_end')).toBe(false);
  });
});
