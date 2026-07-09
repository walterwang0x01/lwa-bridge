/**
 * 启动函数：加载配置 → 装配各模块 → 启动事件循环。
 *
 * 调用方（CLI 的 run 命令、或者外部嵌入）只需要：
 *   await runBridge();
 * 然后等 SIGINT/SIGTERM 来收尾。
 */
import { loadConfig } from '../lib/config.js';
import { getLogger, pruneOldLogs } from '../lib/logger.js';
import { LarkClient } from '../lark/client.js';
import { pruneOldMedia } from '../lark/media.js';
import { SessionStore } from '../store/sessions.js';
import { WorkspaceStore } from '../store/workspaces.js';
import { ActiveCardsStore, type ActiveCard } from '../store/activeCards.js';
import { TaskHistoryStore } from '../store/taskHistory.js';
import { Dispatcher } from './dispatcher.js';
import { registerSelf, unregisterSelf, listProcesses } from '../daemon/registry.js';
import { CronStore } from '../cron/store.js';
import { CronScheduler } from '../cron/scheduler.js';
import { startDashboard, type DashboardHandle } from '../dashboard/server.js';
import { buildAckCard } from '../card/builders.js';

export interface RunBridgeHandle {
  /** 主动停止；返回 promise 在所有清理完成后 resolve */
  stop: () => Promise<void>;
}

export async function runBridge(): Promise<RunBridgeHandle> {
  const log = getLogger().child({ module: 'bridge' });
  const config = loadConfig();
  log.info(
    {
      appId: config.lark.appId,
      defaultCwd: config.workspace.defaultCwd,
      allowedRoots: config.workspace.allowedRoots,
      trustedTools: config.kiro.trustedTools,
      idleTimeoutMinutes: config.kiro.idleTimeoutMinutes,
    },
    'lark-kiro-bridge starting',
  );

  // 启动清理：日志（覆盖 logger 里的默认 7 天） + 24h 前的媒体
  pruneOldLogs(config.preferences.logRetentionDays);
  pruneOldMedia(24);

  // 同 app 多实例检测
  const others = (await listProcesses()).filter(
    (p) => p.appId === config.lark.appId && p.pid !== process.pid,
  );
  if (others.length > 0) {
    log.warn(
      { others: others.map((p) => ({ pid: p.pid, shortId: p.shortId })) },
      'another bridge process is running with the same appId; Lark events may be routed randomly between them',
    );
  }

  await registerSelf(config.lark.appId);

  const lark = new LarkClient({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
    logger: log,
  });

  // 启动时主动查一次 bot 的 open_id，后续群消息 @判定不再依赖名字字符串
  // 失败也不阻塞启动，dispatcher 会降级到"等第一次 @bot 学习"的旧路径
  void lark.getBotOpenId().catch((e) => {
    log.warn({ err: e }, 'initial bot open_id resolution failed (non-fatal)');
  });

  const sessions = new SessionStore();
  const workspaces = new WorkspaceStore();
  const cronStore = new CronStore();
  const activeCards = new ActiveCardsStore();
  const taskHistory = new TaskHistoryStore();

  // 启动时扫描遗留的"进行中卡片"——上次 bridge 被杀时还没 finalize 的任务。
  // 把它们 patch 成"已中断"卡片，避免飞书侧永远显示 loading。
  // 失败不阻塞启动；遗留太多时控制并发避免压垮飞书 API。
  void recoverOrphanCards(activeCards, lark, log);

  // 当前实现里 lark 实例不会被替换（reconnect 复用同一实例），所以是 const。
  // 如果未来需要在 reconnect 时换新实例（比如换 appId），把这里改成 let 即可。
  const larkRef = lark;

  const startEventLoop = async (): Promise<void> => {
    await larkRef.startEventLoop({
      onMessage: (msg) => dispatcher.handle(msg),
      onCardAction: (evt) => dispatcher.handleCardAction(evt),
      onReady: () => log.info('🚀 lark-kiro-bridge ready, waiting for messages'),
    });
  };

  // cron 调度器先创建（onFire 用 lazy 引用 dispatcher）
  let dispatcherRef: Dispatcher | undefined;
  const cronScheduler = new CronScheduler({
    store: cronStore,
    logger: log,
    onFire: ({ task }) => {
      if (!dispatcherRef) {
        log.warn({ id: task.id }, 'cron fired before dispatcher ready, skip');
        return;
      }
      return dispatcherRef.fireCronTask(task);
    },
  });

  const dispatcher = new Dispatcher({
    config,
    lark,
    sessions,
    workspaces,
    logger: log,
    cronStore,
    cronScheduler,
    activeCards,
    taskHistory,
    onReconnect: async () => {
      log.info('reconnect requested via /reconnect');
      try {
        larkRef.close();
      } catch (e) {
        log.warn({ err: e }, 'close before reconnect failed (ignored)');
      }
      // 等一拍再起，避免 SDK 内部状态没清干净
      await new Promise((r) => setTimeout(r, 500));
      await startEventLoop();
    },
  });
  dispatcherRef = dispatcher;

  // 加载持久化的 cron 任务，注册到调度器
  await cronScheduler.start();

  // 启动只读 Web Dashboard（默认开，绑 127.0.0.1）。失败不阻塞主流程。
  let dashboard: DashboardHandle | undefined;
  if (config.dashboard.enabled) {
    try {
      dashboard = startDashboard({
        port: config.dashboard.port,
        appId: config.lark.appId,
        startedAt: Date.now(),
        config,
        sessions,
        cronStore,
        taskHistory,
        logger: log,
      });
    } catch (e) {
      log.warn({ err: e }, 'dashboard failed to start (non-fatal)');
    }
  }

  await startEventLoop();

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    log.info('shutting down');
    try {
      cronScheduler.stop();
    } catch {
      // ignore
    }
    if (dashboard) {
      await dashboard.close().catch(() => undefined);
    }
    try {
      larkRef.close();
    } catch {
      // ignore
    }
    await unregisterSelf().catch(() => undefined);
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

/**
 * 启动时把上次未完成的卡片处理掉。
 *
 * 触发场景：
 *   - 上次 daemon 被 SIGTERM 强杀（这次启动时进程刚 launchd 拉起）
 *   - 上次进程崩溃没正常 finalize
 *
 * 行为：
 *   - 逐条把卡片 patch 成"已中断（daemon 重启）"
 *   - 一条失败不影响后续（可能消息已被撤回 / chat 被踢）
 *   - 全部处理完后 clear() 清空注册表
 *   - 串行处理，避免一次性打满飞书 API；超过 50 条时 warn
 */
async function recoverOrphanCards(
  store: ActiveCardsStore,
  lark: LarkClient,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  let orphans: ActiveCard[];
  try {
    orphans = await store.list();
  } catch (e) {
    log.warn({ err: e }, 'orphan cards list failed (non-fatal)');
    return;
  }
  if (orphans.length === 0) return;
  log.info({ count: orphans.length }, 'recovering orphan cards from previous run');
  if (orphans.length > 50) {
    log.warn(
      { count: orphans.length },
      'too many orphan cards; consider checking for a runaway loop',
    );
  }
  let recovered = 0;
  let failed = 0;
  for (const card of orphans) {
    const ageSec = Math.round((Date.now() - card.startedAt) / 1000);
    try {
      await lark.patchCard(
        card.messageId,
        buildAckCard({
          state: 'aborted',
          title: '⏹ 任务被中断',
          body: `bridge 进程在任务执行期间退出（运行时长 ${ageSec}s）。\n\n如需继续，请重新发送消息。`,
        }),
      );
      recovered++;
    } catch (e) {
      // 消息可能已撤回 / chat 已踢 / token 失效，单条失败不影响其他
      failed++;
      log.debug({ err: e, messageId: card.messageId }, 'orphan card patch failed');
    }
  }
  try {
    await store.clear();
  } catch (e) {
    log.warn({ err: e }, 'orphan cards clear failed (non-fatal)');
  }
  log.info({ recovered, failed, total: orphans.length }, 'orphan cards recovery done');
}
