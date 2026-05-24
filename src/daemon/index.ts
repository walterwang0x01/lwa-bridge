/**
 * 守护进程平台路由
 *
 * 按 process.platform 选择对应 adapter：
 *   - darwin → launchd
 *   - linux  → systemd --user
 *   - win32  → schtasks ONLOGON
 *
 * CLI 通过 `getDaemonAdapter()` 拿到当前平台的实现，外部调用方不需要关心
 * 底层是 launchd/systemd 还是 schtasks。
 */
import type { DaemonAdapter } from './types.js';
import { launchdAdapter } from './launchd.js';
import { systemdAdapter } from './systemd.js';
import { taskSchedulerAdapter } from './taskScheduler.js';
import { DaemonError } from './types.js';

export type { DaemonAdapter } from './types.js';
export { DaemonError } from './types.js';

/**
 * 拿到当前平台的 daemon adapter。
 * 不支持的平台抛 DaemonError，调用方应该 catch 后给用户友好提示。
 */
export function getDaemonAdapter(): DaemonAdapter {
  switch (process.platform) {
    case 'darwin':
      return launchdAdapter;
    case 'linux':
      return systemdAdapter;
    case 'win32':
      return taskSchedulerAdapter;
    default:
      throw new DaemonError(
        `Unsupported platform: ${process.platform}. Daemon support requires macOS, Linux, or Windows.`,
      );
  }
}
