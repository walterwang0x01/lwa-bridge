#!/usr/bin/env node
/**
 * Fake ACP server：扮演 `kiro-cli acp`，让单元测试不依赖真 Kiro。
 *
 * 真子进程，通过 stdin/stdout 跑 JSON-RPC 2.0，按环境变量 ACP_FAKE_SCRIPT
 * 里的 JSON 剧本回响应。零 LLM 调用。
 *
 * 剧本结构（JSON）：
 * {
 *   "initialize": { ... },                   // initialize 的 result
 *   "sessionNew": { "sessionId": "sess_1" }, // session/new 的 result
 *   "prompts": [                              // 每次 session/prompt 取一条
 *     {
 *       "reverseRequests": [ { "method": "...", "params": {...} } ],
 *       "notifications": [ { "sessionUpdate": "agent_message_chunk", ... } ],
 *       "result": { "stopReason": "end_turn" }
 *     }
 *   ],
 *   "behaviors": {
 *     "noRespondInitialize": false,  // 收到 initialize 不回（测超时）
 *     "exitOnRequestCount": 0,       // 收到第 N 个请求即退出
 *     "crashDuringPrompt": false,    // prompt 时发完 notifications 就崩
 *     "stderr": []                   // 启动时先写 stderr 的内容
 *   }
 * }
 *
 * 收到反向请求的响应（无 method、有 id）时，把响应内容回显成一个
 * agent_message_chunk，方便测试断言客户端的自动应答。
 */
import process from 'node:process';

const script = JSON.parse(process.env.ACP_FAKE_SCRIPT || '{}');
const behaviors = script.behaviors || {};
let promptIdx = 0;
let requestCount = 0;
const sessionId = script.sessionNew?.sessionId || 'sess_fake';

for (const line of behaviors.stderr || []) {
  process.stderr.write(`${String(line)}\n`);
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendNotification(update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
}

function finishTurn(scenario, msgId) {
  for (const notif of scenario.notifications || []) {
    sendNotification(notif);
  }
  send({ jsonrpc: '2.0', id: msgId, result: scenario.result || { stopReason: 'end_turn' } });
}

// 等待中的反向请求：id -> true；全部收到响应后跑 afterReverse 收尾本轮
const reverseEcho = new Map();
let pendingReverse = 0;
let afterReverse = null;

let buffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf('\n');
    if (line) handleLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function handleLine(line) {
  requestCount += 1;
  const exitOn = behaviors.exitOnRequestCount || 0;
  if (exitOn && requestCount >= exitOn) {
    process.exit(0);
  }

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const method = msg.method;
  const id = msg.id;

  // 反向请求的响应（无 method、有 id）：回显成 message chunk
  if (method === undefined && id !== undefined) {
    if (reverseEcho.has(id)) {
      const echo = msg.error ? { error: msg.error } : { result: msg.result };
      sendNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(echo) },
      });
      reverseEcho.delete(id);
      pendingReverse -= 1;
      if (pendingReverse === 0 && afterReverse) {
        const fn = afterReverse;
        afterReverse = null;
        fn();
      }
    }
    return;
  }

  if (method === 'initialize') {
    if (!behaviors.noRespondInitialize) {
      send({ jsonrpc: '2.0', id, result: script.initialize || { protocolVersion: 1 } });
    }
    return;
  }

  if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { ...(script.sessionNew || {}), sessionId } });
    return;
  }

  if (method === 'session/load') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'session/prompt') {
    const prompts = script.prompts || [];
    const scenario = prompts[promptIdx] || { result: { stopReason: 'end_turn' } };
    promptIdx += 1;

    // prompt 直接返回 JSON-RPC error（模拟 Kiro 报错：quota/登录过期等）
    if (scenario.error) {
      send({ jsonrpc: '2.0', id, error: scenario.error });
      return;
    }

    if (behaviors.crashDuringPrompt) {
      for (const notif of scenario.notifications || []) sendNotification(notif);
      setTimeout(() => process.exit(1), 20);
      return;
    }

    const reverse = scenario.reverseRequests || [];
    if (reverse.length > 0) {
      pendingReverse = reverse.length;
      afterReverse = () => finishTurn(scenario, id);
      let rid = 1000;
      for (const rr of reverse) {
        const reverseId = `rev_${rid++}`;
        reverseEcho.set(reverseId, true);
        send({ jsonrpc: '2.0', id: reverseId, method: rr.method, params: rr.params || {} });
      }
    } else {
      finishTurn(scenario, id);
    }
    return;
  }

  if (method === 'session/cancel') {
    send({ jsonrpc: '2.0', id, result: null });
    return;
  }

  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
}
