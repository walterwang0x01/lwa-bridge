/**
 * 全局日志器
 * - 开发模式（TTY）用 pino-pretty 输出彩色易读日志
 * - 生产模式输出 NDJSON，写入 ~/.lark-kiro-bridge/logs/YYYY-MM-DD.log
 */
import pino, { type Logger } from 'pino';
import { join } from 'node:path';
import { LOGS_DIR, ensureDataDirs } from './paths.js';

function todayLogFile(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return join(LOGS_DIR, `${yyyy}-${mm}-${dd}.log`);
}

let cachedLogger: Logger | null = null;

export function getLogger(): Logger {
  if (cachedLogger) return cachedLogger;

  ensureDataDirs();

  const isTty = process.stdout.isTTY;
  const level = process.env['LARK_KIRO_LOG_LEVEL'] ?? (isTty ? 'info' : 'info');

  if (isTty) {
    // 开发：终端友好输出
    cachedLogger = pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });
  } else {
    // 生产：NDJSON 落盘
    cachedLogger = pino(
      { level, base: { pid: process.pid } },
      pino.destination({ dest: todayLogFile(), append: true, sync: false }),
    );
  }

  return cachedLogger;
}
