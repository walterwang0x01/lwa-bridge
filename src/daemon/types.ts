/**
 * 跨平台守护进程适配器接口
 *
 * 三个实现：
 *   - launchd.ts        macOS（~/Library/LaunchAgents/*.plist + launchctl）
 *   - systemd.ts        Linux（~/.config/systemd/user/*.service + systemctl --user）
 *   - taskScheduler.ts  Windows（schtasks ONLOGON 任务 + .cmd 启动器）
 *
 * 设计原则：
 *   - 用户感知的命令统一（`lwa start/stop/status/restart/unregister`；兼容 `lark-kiro-bridge`）
 *   - 平台细节封装在 adapter 内部
 *   - install + start / stop + uninstall 是基本 4 个操作；status 用于诊断
 *
 * 平台路由由 src/daemon/index.ts 按 process.platform 决定。
 */

export interface DaemonAdapter {
  /** 平台名（用于日志/状态展示） */
  readonly platform: 'darwin' | 'linux' | 'win32';

  /** 写入服务定义文件（macOS plist / Linux unit / Windows .cmd + schtasks 模板） */
  install(): Promise<void>;

  /** 删除服务定义文件 */
  uninstall(): Promise<void>;

  /** 启动守护进程（先 install 过才行） */
  start(): Promise<void>;

  /** 停止守护进程 */
  stop(): Promise<void>;

  /** 打印状态（pid / 上次退出码 / 日志路径） */
  status(): Promise<void>;
}

export class DaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonError';
  }
}
