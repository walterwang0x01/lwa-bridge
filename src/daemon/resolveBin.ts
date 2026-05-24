/**
 * 跨平台定位 lark-kiro-bridge 可执行入口
 *
 * 三种来源（按优先级）：
 *   1. PATH 中的 lark-kiro-bridge（全局 npm 安装）
 *   2. 当前 node + 包内 bin/lark-kiro-bridge.mjs（开发或本地 link 模式）
 *
 * 守护进程的 plist / unit / scheduled task 都需要绝对路径，所以这里输出
 * { program, args } 让各 adapter 拼成自己的格式。
 */
import { execa } from 'execa';

export interface BridgeBin {
  program: string;
  args: string[];
}

export async function resolveBridgeBin(): Promise<BridgeBin> {
  // 优先 PATH 里的 lark-kiro-bridge
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = await execa(lookup, ['lark-kiro-bridge'], { reject: false });
    if (r.exitCode === 0 && r.stdout.trim()) {
      // Windows where 可能输出多行；取第一行
      const path = r.stdout.split(/\r?\n/)[0]?.trim();
      if (path) return { program: path, args: ['run'] };
    }
  } catch {
    // ignore
  }
  // 回退到当前进程：node + 本包 bin
  const node = process.execPath;
  const fileUrl = new URL(import.meta.url).pathname;
  const guess = fileUrl.replace(
    /\/(dist|src)\/daemon\/resolveBin\.[mc]?js$/,
    '/bin/lark-kiro-bridge.mjs',
  );
  return { program: node, args: [guess, 'run'] };
}
