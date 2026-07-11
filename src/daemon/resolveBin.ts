/**
 * 跨平台定位 LWA CLI 可执行入口
 *
 * 三种来源（按优先级）：
 *   1. PATH 中的 lwa / lwa-bridge / lark-kiro-bridge
 *   2. 当前 node + 包内 bin/lwa.mjs（开发或本地 link 模式）
 */
import { execa } from 'execa';
import { CLI_BIN_NAMES } from '../lib/branding.js';

export interface BridgeBin {
  program: string;
  args: string[];
}

export async function resolveBridgeBin(): Promise<BridgeBin> {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  for (const bin of CLI_BIN_NAMES) {
    try {
      const r = await execa(lookup, [bin], { reject: false });
      if (r.exitCode === 0 && r.stdout.trim()) {
        const path = r.stdout.split(/\r?\n/)[0]?.trim();
        if (path) return { program: path, args: ['serve'] };
      }
    } catch {
      // try next alias
    }
  }
  const node = process.execPath;
  const fileUrl = new URL(import.meta.url).pathname;
  const guess = fileUrl.replace(/\/(dist|src)\/daemon\/resolveBin\.[mc]?js$/, '/bin/lwa.mjs');
  return { program: node, args: [guess, 'serve'] };
}
