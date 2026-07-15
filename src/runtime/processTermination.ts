/**
 * 子进程宽限终止：SIGTERM 后等待有限时间，仍未退出则 SIGKILL。
 * 用于 CLI runtime 适配器（cursor-agent-cli / gemini-cli），
 * 防止子进程忽略 SIGTERM 时 turn 无限期挂起（无总超时兜底）。
 */
import type { ResultPromise } from 'execa';

const DEFAULT_GRACE_MS = 3_000;

/**
 * 等待子进程自然退出；超过 graceMs 仍未退出则发 SIGKILL 强制终止。
 * 调用方应已发送 SIGTERM（或等价取消信号）；本函数只负责“等待 + 兜底强杀”。
 */
export async function waitForExitOrKill(
  proc: ResultPromise,
  graceMs = DEFAULT_GRACE_MS,
): Promise<void> {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    try {
      proc.kill('SIGKILL');
    } catch {
      // 进程可能已经退出，忽略
    }
  }, graceMs);
  try {
    await proc;
  } catch {
    // 进程以非零退出码或信号结束都算“已终止”，不向上抛
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}
