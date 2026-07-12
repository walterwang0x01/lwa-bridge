/**
 * lwa-conduit 子进程封装
 *
 * 把 lwa-conduit CLI（多 agent 并行编排器）当成一个外部工具 spawn，和 bridge
 * 调 kiro-cli / lark-cli 是同一个模式：子进程 + 捕获输出。
 *
 * 串联前提：`lwa-conduit` 命令在 PATH 上（`uv tool install` / `pipx install`
 * lwa-conduit 即可）。bin 路径默认 `lwa-conduit`，可用环境变量
 * `LWA_CONDUIT_BIN` 覆盖（指向绝对路径）。
 *
 * 能力：
 *   - signal：被 AbortSignal 中止时给子进程发 SIGTERM，5s 后兜底 SIGKILL
 *   - onProgress：流式回调（人读日志尾部 + 可选结构化进度）
 *   - run 子命令自动追加 `--events ndjson`
 *   - notFound：lwa-conduit 不在 PATH 时返回友好标记，而不是抛 ENOENT
 */
import { execa } from 'execa';

import { CONDUIT_CLI_NAME, LEGACY_CONDUIT_CLI_NAME } from '../lib/branding.js';
import { consumeConduitEventLines } from './events.js';
import { applyConduitEvent, createEmptyProgress, type ConduitProgressState } from './progress.js';

/** conduit 可执行文件名（在 PATH 上）。LWA_CONDUIT_BIN 优先；回退 KIRO_CONDUIT_BIN。 */
export function conduitBin(): string {
  return process.env.LWA_CONDUIT_BIN || process.env.KIRO_CONDUIT_BIN || CONDUIT_CLI_NAME;
}

export interface ConduitProgressInfo {
  /** 过滤掉 NDJSON 事件后的人读日志尾部 */
  textTail: string;
  progress: ConduitProgressState;
}

export interface ConduitResult {
  /** 退出码为 0 视为成功 */
  ok: boolean;
  exitCode: number;
  /** stdout + stderr 合并后的人读日志尾部（已截断；不含 NDJSON 事件行） */
  output: string;
  /** 是否因超时被终止 */
  timedOut: boolean;
  /** 是否被 signal 主动中止 */
  aborted: boolean;
  /** lwa-conduit 不在 PATH 上（未安装） */
  notFound: boolean;
  /** 结构化进度终态（若启用了 --events） */
  progress?: ConduitProgressState;
}

export interface RunConduitOptions {
  cwd: string;
  /** 超时（默认 30 分钟）。超时会 SIGTERM → 5s 后兜底 SIGKILL。 */
  timeoutMs?: number;
  /** 中止信号；abort 时终止子进程。 */
  signal?: AbortSignal;
  /** 流式输出回调；每次有新输出时带上日志尾部 + 进度状态。 */
  onProgress?: (info: ConduitProgressInfo) => void;
  /**
   * 是否为 `run` 自动追加 `--events ndjson`（默认 true）。
   * 仅当 args[0]==='run' 且尚未带 `--events` 时生效。
   */
  autoEvents?: boolean;
}

/** 输出尾部保留的字符数（飞书单 element 30KB 上限，保守取 2500） */
const MAX_OUTPUT_TAIL = 2500;

function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `…（前文省略）\n${s.slice(-max)}`;
}

/** 给 `run` 子命令补上 `--events ndjson`（已有 `--events` 则不动）。 */
export function withAutoEvents(args: string[], enabled = true): string[] {
  if (!enabled) return args;
  if (args[0] !== 'run') return args;
  if (args.includes('--events')) return args;
  return [...args, '--events', 'ndjson'];
}

/**
 * 跑一次 lwa-conduit 子命令。
 *
 * @param args  传给 lwa-conduit 的参数，如 ['run', '--workspace', '/path']
 * @param opts  cwd / 超时 / 中止信号 / 流式回调
 *
 * 设计取舍：`reject: false` 让非 0 退出码不抛异常，由调用方据 ok 渲染卡片；
 * 编排器"部分任务失败"也会非 0 退出，这属于正常业务结果，不该当成崩溃。
 *
 * 已知限制：SIGTERM 只直达 conduit 进程本身；它已 spawn 的 kiro-cli 子进程可能
 * 短暂残留（conduit 自身负责回收）。比"完全不杀"是实质改进。
 */
export async function runConduit(args: string[], opts: RunConduitOptions): Promise<ConduitResult> {
  const { cwd, timeoutMs = 30 * 60 * 1000, signal, onProgress, autoEvents = true } = opts;
  const finalArgs = withAutoEvents(args, autoEvents);

  const sub = execa(conduitBin(), finalArgs, {
    cwd,
    reject: false,
    timeout: timeoutMs,
    all: true, // 合并 stdout + stderr，保留时序
    stripFinalNewline: true,
    cancelSignal: signal,
    forceKillAfterDelay: 5000, // SIGTERM 后 5s 仍活着就 SIGKILL
  });

  let humanBuf = '';
  let lineCarry = '';
  let progress = createEmptyProgress();

  const ingest = (chunk: string): void => {
    const { events, carry, humanLines } = consumeConduitEventLines(chunk, lineCarry);
    lineCarry = carry;
    for (const ev of events) {
      progress = applyConduitEvent(progress, ev);
    }
    if (humanLines.length) {
      humanBuf += `${humanLines.join('\n')}\n`;
    }
    if (onProgress) {
      onProgress({
        textTail: tail(humanBuf, MAX_OUTPUT_TAIL),
        progress,
      });
    }
  };

  if (sub.all) {
    sub.all.on('data', (chunk: Buffer | string) => {
      ingest(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
  }

  const result = await sub;

  // ENOENT：lwa-conduit 不在 PATH
  if ((result as { code?: string }).code === 'ENOENT') {
    return notFoundResult(result);
  }

  // 收尾：处理未以换行结束的残留，以及未走 data 事件时的整段输出
  const combined = result.all ?? '';
  if (combined && !humanBuf && progress.eventCount === 0) {
    ingest(`${combined}\n`);
  } else if (lineCarry) {
    ingest('\n');
  }

  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
  const aborted = signal?.aborted === true || result.isCanceled === true;
  return {
    ok: exitCode === 0 && !aborted,
    exitCode,
    output: tail(humanBuf || '', MAX_OUTPUT_TAIL),
    timedOut: result.timedOut === true,
    aborted,
    notFound: false,
    progress: progress.eventCount > 0 ? progress : undefined,
  };
}

function notFoundResult(detail: unknown): ConduitResult {
  return {
    ok: false,
    exitCode: -1,
    output: `未找到 \`${conduitBin()}\` 命令。请先安装：\n  uv tool install ${CONDUIT_CLI_NAME}\n（或 pipx install ${CONDUIT_CLI_NAME} / 从源码 uv tool install --editable <path>）\n\n旧包名 \`${LEGACY_CONDUIT_CLI_NAME}\` 仍可用作兼容入口。\n\n${String(detail).slice(0, 300)}`,
    timedOut: false,
    aborted: false,
    notFound: true,
  };
}
