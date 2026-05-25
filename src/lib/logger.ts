/**
 * 全局日志器
 * - 开发模式（TTY）用 pino-pretty 输出彩色易读日志（单行紧凑）
 * - 生产模式输出 NDJSON，写入 ~/.lark-kiro-bridge/logs/YYYY-MM-DD.log
 * - 启动时按 logRetentionDays（默认 7 天）清理旧日志
 *   ENV LARK_KIRO_LOG_DAYS 可覆盖，便于不读 config 的场景
 *
 * 飞书 SDK 适配：通过 createSdkLoggerAdapter() 把 pino logger 包成 SDK 期望的
 * Logger 接口，统一终端输出格式（不再混杂 [info]: [ '...' ] 这种原生噪声）。
 */
import pino, { type Logger } from 'pino';
import { join } from 'node:path';
import { readdirSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { LOGS_DIR, ensureDataDirs } from './paths.js';

function todayLogFile(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return join(LOGS_DIR, `${yyyy}-${mm}-${dd}.log`);
}

/**
 * 清理 LOGS_DIR 下早于 retainDays 天的 *.log 文件。
 * 异常静默吞掉——日志清理不应该挡启动。
 */
export function pruneOldLogs(retainDays: number): void {
  if (!Number.isFinite(retainDays) || retainDays <= 0) return;
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  try {
    const files = readdirSync(LOGS_DIR);
    for (const f of files) {
      if (!f.endsWith('.log')) continue;
      const full = join(LOGS_DIR, f);
      try {
        const st = statSync(full);
        if (st.mtimeMs < cutoff) unlinkSync(full);
      } catch {
        // 单个文件失败忽略
      }
    }
  } catch {
    // 目录不存在等
  }
}

/**
 * 默认 redact 路径：把可能包含敏感凭证的字段替换成 `[REDACTED]`
 *
 * pino 内置支持：只要日志对象里某个 key 的路径匹配上这里的任意一项，
 * 序列化时就会自动替换。配置一次即可，业务代码无须做任何改动。
 *
 * 设计原则：宁可错杀（多打一个 [REDACTED] 没坏处），不可漏过。
 */
const REDACT_PATHS = [
  // App 凭证
  '*.appSecret',
  '*.app_secret',
  'config.lark.appSecret',
  'lark.appSecret',
  // Tokens（access / tenant / app / refresh）
  '*.accessToken',
  '*.access_token',
  '*.tenantAccessToken',
  '*.tenant_access_token',
  '*.appAccessToken',
  '*.app_access_token',
  '*.refreshToken',
  '*.refresh_token',
  // 通用 Auth header
  '*.authorization',
  '*.Authorization',
  // 飞书卡片回调里的临时 token（30 分钟有效，泄露能伪造卡片更新）
  'event.token',
  '*.cardToken',
];

let cachedLogger: Logger | null = null;

export function getLogger(): Logger {
  if (cachedLogger) return cachedLogger;

  ensureDataDirs();

  const isTty = process.stdout.isTTY;
  const level = process.env['LARK_KIRO_LOG_LEVEL'] ?? (isTty ? 'info' : 'info');

  if (isTty) {
    // 开发：终端友好输出（单行紧凑 + 模块名前缀）
    cachedLogger = pino({
      level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          // module 提到 messageFormat 里展示，不再作为 context 重复打印
          ignore: 'pid,hostname,module',
          // 单行：消息在前，剩余字段以 key=value 形式跟在后面
          singleLine: true,
          // 给模块名留固定列宽，扫日志时更整齐；没 module 的退化成纯 msg
          messageFormat: '{if module}[{module}] {end}{msg}',
        },
      },
    });
  } else {
    // 生产：NDJSON 落盘
    cachedLogger = pino(
      {
        level,
        base: { pid: process.pid },
        redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      },
      pino.destination({ dest: todayLogFile(), append: true, sync: false }),
    );
  }

  // 启动清理（用 env 兜底；bootstrap 后续会用 config 再调一次也没关系）
  const envDays = Number(process.env['LARK_KIRO_LOG_DAYS']);
  if (Number.isFinite(envDays) && envDays > 0) {
    pruneOldLogs(envDays);
  } else {
    pruneOldLogs(7);
  }

  return cachedLogger;
}

/**
 * 读最近 N 行结构化日志，供 /doctor 命令使用。
 * 简单实现：按文件 mtime 倒序取最新若干文件，整体读完后按行切，取最后 N 行。
 * 单条 NDJSON 可能很长，做一道字段截短，避免把 axios 错误的整个 request dump 都喂给 LLM。
 */
export function readRecentLogLines(maxLines = 200): string[] {
  try {
    const files = readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith('.log') && !f.startsWith('daemon-'))
      .map((f) => ({ f, t: statSync(join(LOGS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 3) // 最多翻 3 个文件
      .map((x) => x.f);
    const allLines: string[] = [];
    for (const f of files) {
      const full = join(LOGS_DIR, f);
      const raw = readFileSync(full, 'utf-8');
      // pino 会出现一行很长的情况，截短到 1KB
      for (const line of raw.split('\n')) {
        if (!line) continue;
        allLines.push(line.length > 1024 ? line.slice(0, 1024) + '…[truncated]' : line);
      }
      if (allLines.length >= maxLines * 3) break;
    }
    return allLines.slice(-maxLines);
  } catch {
    return [];
  }
}

/**
 * 飞书 SDK 期望的 Logger 接口形状。
 *
 * SDK 内部用 `logger.info(...args)` 这种可变参的写法（args 经常是 `[ 'event-dispatch is ready' ]`
 * 这种数组形式）。我们包一层适配器把 args 拼成 message string，再走 pino，
 * 让终端日志格式统一、不再裸喷 `[info]: [ 'xxx' ]`。
 *
 * 已知噪声会在适配器里降级到 trace（默认不显示），便于减干扰。
 */
export interface SdkLogger {
  error: (...msg: unknown[]) => void;
  warn: (...msg: unknown[]) => void;
  info: (...msg: unknown[]) => void;
  debug: (...msg: unknown[]) => void;
  trace: (...msg: unknown[]) => void;
}

/**
 * 已知 SDK 噪声匹配规则；命中则降级到 trace（默认不显示）。
 * 来源：观察 daemon-stderr 长期堆积的 warn / SDK 自身打的事件 ack 日志。
 */
const SDK_NOISE_PATTERNS: RegExp[] = [
  /no im\.message\.message_read_v1 handle/i,
  /no im\.message\.recalled_v1 handle/i,
];

/**
 * 把任意 args 拼成一行可读 message，给 pino 用。
 * SDK 常传 `[ 'xxx' ]` 这种单元素数组，我们解出来；其他情况用 JSON.stringify。
 */
function formatSdkArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  if (args.length === 1) {
    const a = args[0];
    if (typeof a === 'string') return a;
    if (Array.isArray(a)) {
      // SDK 经常传单元素数组，里面是字符串
      if (a.length === 1 && typeof a[0] === 'string') return a[0];
      return a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    }
    if (a instanceof Error) return a.message;
    return safeStringify(a);
  }
  return args.map((x) => (typeof x === 'string' ? x : safeStringify(x))).join(' ');
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 创建一个 SDK 用的 Logger 适配器，所有日志带 `module: 'lark-sdk'` 子字段。
 * 噪声会降级到 trace（默认看不到，需要 LARK_KIRO_LOG_LEVEL=trace 才显示）。
 */
export function createSdkLoggerAdapter(parent?: Logger): SdkLogger {
  const sdkLog = (parent ?? getLogger()).child({ module: 'lark-sdk' });
  const route = (level: 'error' | 'warn' | 'info' | 'debug' | 'trace', args: unknown[]) => {
    const msg = formatSdkArgs(args);
    if (!msg) return;
    // 噪声降级
    if (SDK_NOISE_PATTERNS.some((re) => re.test(msg))) {
      sdkLog.trace(msg);
      return;
    }
    sdkLog[level](msg);
  };
  return {
    error: (...args) => route('error', args),
    warn: (...args) => route('warn', args),
    info: (...args) => route('info', args),
    debug: (...args) => route('debug', args),
    trace: (...args) => route('trace', args),
  };
}
