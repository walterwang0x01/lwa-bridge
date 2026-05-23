/**
 * 启动函数：加载配置 → 装配各模块 → 启动事件循环。
 *
 * 调用方（CLI 的 run 命令、或者外部嵌入）只需要：
 *   await runBridge();
 * 然后等 SIGINT/SIGTERM 来收尾。
 */
import { loadConfig } from '../lib/config.js';
import { getLogger } from '../lib/logger.js';
import { LarkClient } from '../lark/client.js';
import { SessionStore } from '../store/sessions.js';
import { WorkspaceStore } from '../store/workspaces.js';
import { Dispatcher } from './dispatcher.js';

export interface RunBridgeHandle {
  /** 主动停止；返回 promise 在所有清理完成后 resolve */
  stop: () => Promise<void>;
}

export async function runBridge(): Promise<RunBridgeHandle> {
  const log = getLogger();
  const config = loadConfig();
  log.info(
    {
      appId: config.lark.appId,
      defaultCwd: config.workspace.defaultCwd,
      allowedRoots: config.workspace.allowedRoots,
      trustedTools: config.kiro.trustedTools,
    },
    'lark-kiro-bridge starting',
  );

  const lark = new LarkClient({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
    logger: log,
  });
  const sessions = new SessionStore();
  const workspaces = new WorkspaceStore();
  const dispatcher = new Dispatcher({ config, lark, sessions, workspaces, logger: log });

  await lark.startEventLoop({
    onMessage: (msg) => dispatcher.handle(msg),
    onReady: () => log.info('🚀 lark-kiro-bridge ready, waiting for messages'),
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    log.info('shutting down');
    lark.close();
  };

  // 注册信号处理（CLI 入口也会注册，这里冗余一次保险）
  const signalHandler = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'received signal');
    await stop();
    process.exit(0);
  };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);

  return { stop };
}
