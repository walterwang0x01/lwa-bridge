/**
 * Kiro CLI 子进程封装
 *
 * 职责：
 *   - 用 execa spawn `kiro-cli chat --no-interactive ...`
 *   - 流式收 stdout，去 ANSI 转义后通过 onChunk 回调推给上层（卡片渲染器）
 *   - 跑完后用 `kiro-cli chat --list-sessions` 取最新 sessionId 返回
 *   - 支持超时（kill SIGTERM，2 秒后 SIGKILL）
 *   - 支持外部主动中止（同样 SIGTERM/SIGKILL 流程）
 *
 * 注意：kiro-cli 没有原生 JSON 流式协议，stdout 是 ANSI 着色的纯文本。
 *       工具调用/思考过程在 --no-interactive 下被隐藏，输出的就是最终回复文本。
 */
import { execa, type ResultPromise } from 'execa';
import { getLogger } from '../lib/logger.js';

const log = () => getLogger().child({ module: 'kiro-runner' });

/** ANSI 转义序列剥离正则；覆盖 CSI、OSC 和常见控制序列。 */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[ -/]*[0-9?])/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '');
}

export interface RunOptions {
  /** 用户消息（即喂给 kiro-cli 的 INPUT 参数） */
  prompt: string;
  /** 工作目录 */
  cwd: string;
  /** 续接的 session id；不传则新建会话 */
  resumeId?: string | undefined;
  /** kiro-cli 可执行文件，默认 'kiro-cli' */
  binPath?: string;
  /** 信任的工具集合 */
  trustedTools?: string[];
  /** 模型名（可选） */
  model?: string | undefined;
  /** Agent 名（可选） */
  agent?: string | undefined;
  /** 总超时毫秒 */
  timeoutMs?: number;
  /** 流式文本回调；text 是已剥离 ANSI 的纯文本片段 */
  onChunk?: (text: string) => void;
  /** AbortSignal 用于外部打断 */
  signal?: AbortSignal;
}

export interface RunResult {
  /** 完整回复（已剥离 ANSI） */
  text: string;
  /** kiro-cli 退出码 */
  exitCode: number | null;
  /** 跑完之后从 list-sessions 拿到的最新 session id（可能为 undefined） */
  newSessionId?: string;
  /** 是否被外部信号中止 */
  aborted: boolean;
  /** 是否因总超时被强杀 */
  timedOut: boolean;
}

/** stdout 输出里 kiro-cli 的提示符前缀，剥掉。 */
const PROMPT_PREFIX_REGEX = /^>\s*/;

/**
 * 跑一次 kiro-cli。流式回调和超时/打断都安全终止。
 */
export async function runKiro(opts: RunOptions): Promise<RunResult> {
  const {
    prompt,
    cwd,
    resumeId,
    binPath = 'kiro-cli',
    trustedTools = ['fs_read', 'fs_write', 'grep', 'glob', 'code'],
    model,
    agent,
    timeoutMs = 10 * 60 * 1000,
    onChunk,
    signal,
  } = opts;

  const args: string[] = ['chat', '--no-interactive'];
  if (resumeId) args.push('--resume-id', resumeId);
  if (model) args.push('--model', model);
  if (agent) args.push('--agent', agent);
  if (trustedTools.length > 0) {
    args.push(`--trust-tools=${trustedTools.join(',')}`);
  } else {
    args.push('--trust-tools=');
  }
  args.push(prompt);

  log().info({ cwd, resumeId, args: args.slice(0, 5) }, 'spawning kiro-cli');

  let timedOut = false;
  let aborted = false;
  let textBuf = '';

  // 用 execa 9 spawn；stdin 关闭，stdout/stderr 流式
  const child: ResultPromise = execa(binPath, args, {
    cwd,
    reject: false,
    stripFinalNewline: false,
    buffer: false,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0' }, // 尽量减少 ANSI（虽然没完全消除）
  });

  // 总超时
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    log().warn({ pid: child.pid, timeoutMs }, 'kiro-cli timed out, sending SIGTERM');
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 2000);
  }, timeoutMs);

  // 外部 abort
  const onAbort = () => {
    aborted = true;
    log().info({ pid: child.pid }, 'kiro-cli abort requested');
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 2000);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  // 流式收 stdout
  if (child.stdout) {
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      const clean = stripAnsi(chunk).replace(PROMPT_PREFIX_REGEX, '');
      if (clean) {
        textBuf += clean;
        try {
          onChunk?.(clean);
        } catch (e) {
          log().error({ err: e }, 'onChunk callback threw');
        }
      }
    });
  }

  // stderr 默认忽略，只在 verbose 时记录
  if (child.stderr) {
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      log().debug({ stderr: chunk.slice(0, 200) }, 'kiro stderr');
    });
  }

  const result = await child;
  clearTimeout(timeoutHandle);
  if (signal) signal.removeEventListener('abort', onAbort);

  log().info(
    { exitCode: result.exitCode, textLen: textBuf.length, aborted, timedOut },
    'kiro-cli finished',
  );

  // 跑完后取最新 session id（resume 用的话用同一个，否则取最新创建的）
  let newSessionId: string | undefined;
  if (!aborted && !timedOut && result.exitCode === 0) {
    try {
      newSessionId = await getLatestSessionId(cwd, binPath);
    } catch (e) {
      log().warn({ err: e }, 'failed to fetch latest session id');
    }
  }

  return {
    text: textBuf.trim(),
    exitCode: result.exitCode ?? null,
    newSessionId: newSessionId ?? resumeId,
    aborted,
    timedOut,
  };
}

/**
 * 从 `kiro-cli chat --list-sessions` 输出里抓最新一条 SessionId。
 * 输出格式（去 ANSI 后）大致：
 *   Chat sessions for /path:
 *
 *   Chat SessionId: 124aaf58-...
 *     19 seconds ago | xxx | 2 msgs | v1
 *
 * 列表是按时间倒序，第一条就是最新。
 */
async function getLatestSessionId(cwd: string, binPath: string): Promise<string | undefined> {
  const result = await execa(binPath, ['chat', '--list-sessions'], {
    cwd,
    reject: false,
    timeout: 10_000,
  });
  if (result.exitCode !== 0) return undefined;
  const text = stripAnsi(result.stdout || '');
  const m = text.match(/Chat SessionId:\s*([0-9a-f-]{36})/i);
  return m?.[1];
}
