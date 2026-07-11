/**
 * 启动函数：加载配置 → 装配各模块 → 启动事件循环。
 *
 *   await runBridge({ cliOnly: true });  // 本地 REPL
 *   await runBridge();                   // Gateway（按 ingress.channels）
 */
import { loadConfig, type Config } from '../lib/config.js';
import { getLogger, pruneOldLogs } from '../lib/logger.js';
import { LarkClient } from '../lark/client.js';
import { createLarkIngressChannel } from '../ingress/lark/channel.js';
import { createSlackIngressChannel } from '../ingress/slack/channel.js';
import { CliIngressChannel } from '../ingress/cli/channel.js';
import { ConversationIngressRouter } from '../ingress/multiplex/port.js';
import { registerIngressChannel } from '../ingress/registry.js';
import type { ChannelId, IngressChannel, IngressPort } from '../ingress/types.js';
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
import { resolveCliLaunchCwd } from '../ingress/cli/workspace.js';
import { resolveRuntimeProfile } from '../runtime/config.js';
import { cliCommand } from '../lib/branding.js';

export interface RunBridgeHandle {
  /** 主动停止；返回 promise 在所有清理完成后 resolve */
  stop: () => Promise<void>;
}

export interface RunBridgeOptions {
  /** 与飞书/Slack 并行挂载本地终端（需 TTY） */
  attachCliChat?: boolean;
  /** 仅本地 CLI 入口，不连飞书 WebSocket */
  cliOnly?: boolean;
  /** CLI 模式：code（默认）| chat */
  cliMode?: 'code' | 'chat';
  /** 续上最近一个 CLI 会话 */
  cliContinue?: boolean;
  /** 恢复指定 CLI 会话 id */
  cliResumeId?: string;
}

function resolveGatewayChannels(config: Config): ChannelId[] {
  const raw = config.ingress?.channels?.length
    ? config.ingress.channels
    : config.ingress?.channel
      ? [config.ingress.channel]
      : (['lark'] as ChannelId[]);
  return [...new Set(raw)];
}

export async function runBridge(opts?: RunBridgeOptions): Promise<RunBridgeHandle> {
  const log = getLogger().child({ module: 'bridge' });
  const config = loadConfig();
  const cliOnly = Boolean(opts?.cliOnly);
  const cliMode = opts?.cliMode ?? 'code';
  const sessions = new SessionStore();
  let initialCliId = cliMode === 'chat' ? 'cli-chat' : 'cli-code';
  if (cliOnly && opts?.cliResumeId) {
    initialCliId = opts.cliResumeId;
  } else if (cliOnly && opts?.cliContinue) {
    const prefix = cliMode === 'chat' ? 'cli-chat' : 'cli-code';
    const latest = await sessions.latestCliSessionId(prefix);
    if (latest) initialCliId = latest;
  }
  const cliConversationIdRef = {
    current: initialCliId,
  };
  log.info(
    {
      appId: config.lark.appId,
      defaultCwd: config.workspace.defaultCwd,
      allowedRoots: config.workspace.allowedRoots,
      trustedTools: config.kiro.trustedTools,
      idleTimeoutMinutes: config.kiro.idleTimeoutMinutes,
      mode: cliOnly ? `cli:${cliMode}` : 'gateway',
      plan: config.runtime?.plan ?? 'kiro-unlimited+cursor-lite',
    },
    'lwa starting',
  );

  pruneOldLogs(config.preferences.logRetentionDays);
  pruneOldMedia(24);

  if (!cliOnly) {
    const others = (await listProcesses()).filter(
      (p) => p.appId === config.lark.appId && p.pid !== process.pid,
    );
    if (others.length > 0) {
      log.warn(
        { others: others.map((p) => ({ pid: p.pid, shortId: p.shortId })) },
        'another bridge process is running with the same appId; Lark events may be routed randomly between them',
      );
    }
  }

  await registerSelf(config.lark.appId);

  const lark = new LarkClient({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
    logger: log,
  });

  const larkIngressChannel = createLarkIngressChannel(lark);
  const slackIngressChannel = createSlackIngressChannel({
    botToken: config.ingress?.slack?.botToken,
    appToken: config.ingress?.slack?.appToken,
    signingSecret: config.ingress?.slack?.signingSecret,
    logger: log,
  });
  registerIngressChannel(larkIngressChannel);
  registerIngressChannel(slackIngressChannel);

  const cliIngressChannel = new CliIngressChannel();
  registerIngressChannel(cliIngressChannel);

  const gatewayChannels = cliOnly ? (['cli'] as ChannelId[]) : resolveGatewayChannels(config);
  if (!cliOnly && gatewayChannels.length === 0) {
    throw new Error(
      `No ingress channels enabled. Set ingress.channels in config (e.g. ["lark"]) or run \`${cliCommand('chat')}\`.`,
    );
  }

  const enableLark = !cliOnly && gatewayChannels.includes('lark');
  const enableSlack = !cliOnly && gatewayChannels.includes('slack');
  const enableCliInGateway = !cliOnly && gatewayChannels.includes('cli');
  const slackReady = Boolean(config.ingress?.slack?.botToken && config.ingress?.slack?.appToken);

  if (enableSlack && !slackReady) {
    log.warn('ingress.channels includes slack but tokens missing; slack disabled');
  }
  const slackActive = enableSlack && slackReady;

  // 主入站：cliOnly → CLI；否则优先 lark，其次 slack
  let primaryChannel: IngressChannel = larkIngressChannel;
  if (cliOnly) {
    primaryChannel = cliIngressChannel;
  } else if (!enableLark && slackActive) {
    primaryChannel = slackIngressChannel;
  } else if (!enableLark && !slackActive) {
    if (enableCliInGateway) {
      primaryChannel = cliIngressChannel;
    } else {
      throw new Error(
        `No usable ingress channel. Enabled=${gatewayChannels.join(',')} but Lark/Slack not ready.`,
      );
    }
  }

  const attachCli = Boolean(
    (opts?.attachCliChat || enableCliInGateway) && process.stdin.isTTY && !cliOnly,
  );
  const needRouter = attachCli && primaryChannel.id !== 'cli';
  const ingressRouter = needRouter ? new ConversationIngressRouter(primaryChannel.port) : undefined;
  const ingressPort: IngressPort = ingressRouter ?? primaryChannel.port;

  log.info(
    {
      channels: gatewayChannels,
      primary: primaryChannel.id,
      attachCli,
      cliOnly,
    },
    'ingress configured',
  );

  if (enableLark) {
    void lark.getBotOpenId().catch((e) => {
      log.warn({ err: e }, 'initial bot open_id resolution failed (non-fatal)');
    });
  }

  const workspaces = new WorkspaceStore();
  const cronStore = new CronStore();
  const activeCards = new ActiveCardsStore();
  const taskHistory = new TaskHistoryStore();

  if (enableLark || slackActive) {
    void recoverOrphanCards(activeCards, ingressPort, log);
  }

  const larkRef = lark;
  const startedChannels: IngressChannel[] = [];

  const startEventLoop = async (): Promise<void> => {
    if (cliOnly) {
      await cliIngressChannel.startInbound({
        onMessage: (msg) => dispatcher.handleNormalized(msg),
        onCardAction: (evt) => dispatcher.handleNormalizedCardAction(evt),
        onReady: () => log.info({ channel: 'cli' }, 'CLI REPL ready'),
      });
      startedChannels.push(cliIngressChannel);
      return;
    }

    if (enableLark) {
      await larkIngressChannel.startInbound({
        onMessage: (msg) => {
          ingressRouter?.bind(msg.conversationId, larkIngressChannel.port);
          return dispatcher.handleNormalized(msg);
        },
        onCardAction: (evt) => dispatcher.handleNormalizedCardAction(evt),
        onReady: () => log.info({ channel: 'lark' }, 'Lark channel ready'),
      });
      startedChannels.push(larkIngressChannel);
    }

    if (slackActive) {
      await slackIngressChannel.startInbound({
        onMessage: (msg) => {
          ingressRouter?.bind(msg.conversationId, slackIngressChannel.port);
          return dispatcher.handleNormalized(msg);
        },
        onCardAction: (evt) => dispatcher.handleNormalizedCardAction(evt),
        onReady: () => log.info({ channel: 'slack' }, 'Slack channel ready'),
      });
      startedChannels.push(slackIngressChannel);
    }

    if (attachCli && !startedChannels.includes(cliIngressChannel)) {
      await cliIngressChannel.startInbound({
        onMessage: (msg) => {
          ingressRouter?.bind(msg.conversationId, cliIngressChannel.port);
          return dispatcher.handleNormalized(msg);
        },
        onCardAction: (evt) => dispatcher.handleNormalizedCardAction(evt),
        onReady: () => log.info({ channel: 'cli' }, 'CLI channel attached to gateway'),
      });
      startedChannels.push(cliIngressChannel);
    }

    log.info({ channels: startedChannels.map((c) => c.id) }, 'LWA gateway ready');
  };

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
    ingress: ingressPort,
    sessions,
    workspaces,
    logger: log,
    cronStore,
    cronScheduler,
    activeCards,
    taskHistory,
    cliMode: cliOnly ? cliMode : undefined,
    getCliConversationId: cliOnly ? () => cliConversationIdRef.current : undefined,
    onCliConversationSwitch: cliOnly
      ? (id) => {
          cliConversationIdRef.current = id;
        }
      : undefined,
    onReconnect: async () => {
      log.info('reconnect requested via /reconnect');
      try {
        if (enableLark) {
          larkRef.close();
        }
        for (const ch of startedChannels) {
          if (ch.id !== 'lark') ch.close();
        }
      } catch (e) {
        log.warn({ err: e }, 'close before reconnect failed (ignored)');
      }
      startedChannels.length = 0;
      await new Promise((r) => setTimeout(r, 500));
      await startEventLoop();
    },
  });
  dispatcherRef = dispatcher;

  await cronScheduler.start();

  let dashboard: DashboardHandle | undefined;
  if (config.dashboard.enabled && !cliOnly) {
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
  } else if (cliOnly && config.dashboard.enabled) {
    log.debug(
      { port: config.dashboard.port },
      'dashboard skipped in CLI REPL (use lwa serve for http://127.0.0.1:5180)',
    );
  }

  await startEventLoop();

  const cliChannelRef = attachCli || cliOnly ? cliIngressChannel : undefined;

  if (cliOnly || attachCli) {
    const launchCwd = resolveCliLaunchCwd(config);
    await sessions.setConversationCwd(
      cliConversationIdRef.current,
      launchCwd,
      config.workspace.defaultCwd,
    );
    // 兼容旧会话键
    if (cliMode === 'code') {
      await sessions.setConversationCwd('cli-local', launchCwd, config.workspace.defaultCwd);
    }
    log.info(
      { launchCwd, cliMode, cliConversationId: cliConversationIdRef.current },
      'CLI workspace cwd',
    );
  }

  const cliPromptCtx = {
    mode: cliMode,
    getConversationId: () => cliConversationIdRef.current,
    setConversationId: (id: string) => {
      cliConversationIdRef.current = id;
    },
    getCwd: async () =>
      (await sessions.getConversation(cliConversationIdRef.current, resolveCliLaunchCwd(config)))
        .currentCwd,
    getProfile: async () => {
      try {
        const stored = await sessions.getConversationRuntimeProfile(cliConversationIdRef.current);
        const profileName =
          stored ?? (typeof config.runtime?.default === 'string' ? config.runtime.default : 'auto');
        if (profileName === 'auto') return { profileName: 'auto→(smart)' };
        try {
          const p = resolveRuntimeProfile(config, profileName);
          return { profileName, model: p.model };
        } catch {
          return { profileName };
        }
      } catch {
        return undefined;
      }
    },
    getStatusExtras: async () => {
      try {
        const { estimateSessionContext } = await import('../runtime/contextEstimate.js');
        const { loadProjectMemory } = await import('../ingress/cli/projectMemory.js');
        const { loadGlobalMemory } = await import('../ingress/cli/globalMemory.js');
        const conversationId = cliConversationIdRef.current;
        const session = await sessions.getConversation(conversationId, resolveCliLaunchCwd(config));
        const { profile } = (() => {
          try {
            const name =
              session.runtimeProfile ??
              (typeof config.runtime?.default === 'string' ? config.runtime.default : 'kiro');
            if (name === 'auto') {
              return { profile: resolveRuntimeProfile(config, 'kiro') };
            }
            return { profile: resolveRuntimeProfile(config, name) };
          } catch {
            return { profile: resolveRuntimeProfile(config, 'kiro') };
          }
        })();
        const ctx = await estimateSessionContext({
          config,
          sessions,
          conversationId,
          cwd: session.currentCwd,
          profile,
        });
        const memHits = [
          ...loadProjectMemory(session.currentCwd).map((f) => f.name),
          ...loadGlobalMemory().map((f) => f.name),
        ];
        return {
          ctxPct: ctx.pct,
          memLabel: memHits.length ? memHits.slice(0, 3).join('+') : undefined,
        };
      } catch {
        return undefined;
      }
    },
  };

  if (attachCli) {
    void cliIngressChannel
      .promptLoop(cliConversationIdRef.current, 'cli-user', cliPromptCtx)
      .catch((e) => log.warn({ err: e }, 'cli chat attach failed'));
  } else if (cliOnly) {
    await cliIngressChannel.promptLoop(cliConversationIdRef.current, 'cli-user', cliPromptCtx);
  }

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
    if (cliChannelRef) {
      try {
        cliChannelRef.close();
      } catch {
        // ignore
      }
    }
    if (!cliOnly) {
      try {
        if (enableLark) larkRef.close();
        for (const ch of startedChannels) {
          if (ch.id !== 'cli' && ch.id !== 'lark') ch.close();
        }
      } catch {
        // ignore
      }
    }
    await unregisterSelf().catch(() => undefined);
  };

  const signalHandler = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'received signal');
    await stop();
    process.exit(0);
  };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);

  return { stop };
}

async function recoverOrphanCards(
  store: ActiveCardsStore,
  ingress: IngressPort,
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
      await ingress.patchCard(
        card.messageId,
        buildAckCard({
          state: 'aborted',
          title: '⏹ 任务被中断',
          body: `bridge 进程在任务执行期间退出（运行时长 ${ageSec}s）。\n\n如需继续，请重新发送消息。`,
        }),
      );
      recovered++;
    } catch (e) {
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
