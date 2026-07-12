/**
 * 消息总分发器
 *
 * 把一条入站消息变成一个动作：
 *   1. 访问控制校验（用户/群白名单、@bot 检测）
 *   2. 下载图片/文件资源（如果有）
 *   3. 解析斜杠命令
 *   4. 路由到 commandHandler 或 kiroHandler
 *   5. 更新卡片
 *
 * 跨会话并发不限（每个会话自己内部串行）。
 */
import type { Logger } from 'pino';
import type { Config } from '../lib/config.js';
import { patchAndSaveConfig } from '../lib/config.js';
import type { IngressPort } from '../ingress/types.js';
import { fromLarkMessage } from '../ingress/lark/normalize.js';
import type { NormalizedCardAction, NormalizedMessage } from '../ingress/types.js';
import { toCardActionEvent, toIncomingMessage } from '../ingress/lark/normalize.js';
import type { IncomingMessage, CardActionEvent } from '../lark/types.js';
import { stripMentions, larkItemToText } from '../lark/parse.js';
import { parseCommand, type ParsedCommand } from '../commands/parse.js';
import { readRecentLogLines } from '../lib/logger.js';
import { SessionStore } from '../store/sessions.js';
import { WorkspaceStore } from '../store/workspaces.js';
import type { ActiveCardsStore } from '../store/activeCards.js';
import type { TaskHistoryStore } from '../store/taskHistory.js';
import { evaluateApplySafeGates } from '../runtime/adaptive.js';
import { FilePlanSource, planDirFor, planFilePathFor } from '../plan/source.js';
import { mkdirSync, rmSync } from 'node:fs';
import { runAgentTurn } from '../runtime/runner.js';
import {
  listRuntimeProfileNames,
  profileNameForRuntimeKind,
  resolveRuntimeProfile,
} from '../runtime/config.js';
import {
  chooseModelForProfile,
  chooseRuntimeProfile,
  classifyTaskBucket,
} from '../runtime/router.js';
import { resolveModeRouteTable } from '../runtime/planProfiles.js';
import { sharedGatewayHealth } from '../runtime/gatewayHealth.js';
import { cliCommand, configPathTilde } from '../lib/branding.js';
import { discoverRuntimeRegistry } from '../runtime/registry.js';
import { formatModelTierSummary, suggestFastStrongModels } from '../runtime/openaiModels.js';
import { cardToPlainText, formatCliHelp } from '../ingress/cli/textPresenter.js';
import { probeRuntimeQuota } from '../runtime/quota.js';
import { decodeSessionId } from '../runtime/sessionId.js';
import type { RuntimeProfile } from '../runtime/types.js';
import { AcpPool } from '../kiro/acpPool.js';
import { listModels, clearModelCache } from '../kiro/models.js';
import { CardRenderer } from '../card/renderer.js';
import { RunCardController } from '../card/runCardController.js';
import {
  buildModelPickerCard,
  buildHelpCard,
  buildWorkspaceListCard,
  buildStatusCard,
  buildAckCard,
  buildLoadingCard,
  buildConfigViewCard,
  buildConfigFormCard,
  buildPsCard,
  buildMemoryListCard,
  buildMemoryViewCard,
  buildMemoryEditFormCard,
  buildMemoryNewFormCard,
  buildCronListCard,
  buildCronTranslateConfirmCard,
  buildCronTranslatedConfirmCard,
  buildConduitMergeConfirmCard,
} from '../card/builders.js';
import { ChatPipeline } from './pipeline.js';
import { runConduit, type ConduitResult } from '../conduit/runner.js';
import { formatProgressText } from '../conduit/progress.js';
import { formatRunSummary, summarizeRunState } from '../conduit/summary.js';
import { listProcesses, findProcess } from '../daemon/registry.js';
import {
  MemoryStore,
  MemoryError,
  validateFilename,
  normalizeFilename,
  extractInclusion,
} from '../memory/store.js';
import type { CronStore } from '../cron/store.js';
import type { CronScheduler } from '../cron/scheduler.js';
import type { CronTask } from '../cron/store.js';
import { parseExpression, nextRun, formatNextRun } from '../cron/expression.js';
import { formToCron, type ScheduleForm } from '../cron/scheduleForm.js';
import { buildScheduleFormCard, type ScheduleFormState } from '../card/scheduleCard.js';
import { runSelfChecks } from '../lib/selftest.js';
import { buildSelftestCard } from '../card/selftestCard.js';
import {
  isUserAllowed,
  isAdmin,
  validateCwd,
  validateAccessChange,
  SecurityError,
} from '../lib/security.js';
import { listGlobalAgents } from '../kiro/agents.js';
import { addSource, listSources, removeSource, getSource } from '../assets/store.js';
import { syncSource, installAsset } from '../assets/gitSource.js';
import { listPersonaLibrary } from '../kiro/personaLibrary/index.js';

export interface DispatcherOptions {
  config: Config;
  ingress: IngressPort;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  logger: Logger;
  /** 当 /reconnect 命令触发时调用，由 bootstrap 注入 */
  onReconnect?: () => Promise<void>;
  /** Cron 持久化与调度（v0.6+ 注入；不注入则 /cron 命令报"未启用"）*/
  cronStore?: CronStore;
  cronScheduler?: CronScheduler;
  /** 进行中卡片注册表；由 bootstrap 注入。不传时所有 add/remove 都是 no-op（兼容老调用方）*/
  activeCards?: ActiveCardsStore;
  /** 任务历史记录；由 bootstrap 注入。不传时不记录历史（兼容老调用方）*/
  taskHistory?: TaskHistoryStore;
  /** CLI 模式：影响路由表与 system prompt */
  cliMode?: 'code' | 'chat';
  /** CLI 切换会话时回调（/resume） */
  onCliConversationSwitch?: (conversationId: string) => void;
  /** 读取当前 CLI conversation id */
  getCliConversationId?: () => string;
}

export class Dispatcher {
  private config: Config;
  private readonly ingress: IngressPort;
  private readonly sessions: SessionStore;
  private readonly workspaces: WorkspaceStore;
  private readonly log: Logger;
  private readonly pipelines = new Map<string, ChatPipeline>();
  private readonly onReconnect?: () => Promise<void>;
  private readonly memory = new MemoryStore();
  /** Kiro 当前 agent 可用 skill 缓存（per conversationId，每次 turn 成功后更新）。 */
  private readonly chatSkills = new Map<string, Array<{ name: string; description: string }>>();
  /** per-profile ACP 进程池（仅 kiro-cli-acp runtime 使用）。 */
  private readonly acpPools = new Map<string, AcpPool>();
  private readonly cronStore?: CronStore;
  private readonly cronScheduler?: CronScheduler;
  private readonly activeCards?: ActiveCardsStore;
  private readonly taskHistory?: TaskHistoryStore;
  private readonly cliMode?: 'code' | 'chat';
  private readonly onCliConversationSwitch?: (conversationId: string) => void;
  private readonly getCliConversationId?: () => string;

  constructor(opts: DispatcherOptions) {
    this.config = opts.config;
    this.ingress = opts.ingress;
    this.sessions = opts.sessions;
    this.workspaces = opts.workspaces;
    this.log = opts.logger.child({ module: 'dispatcher' });
    if (opts.onReconnect) this.onReconnect = opts.onReconnect;
    if (opts.cronStore) this.cronStore = opts.cronStore;
    if (opts.cronScheduler) this.cronScheduler = opts.cronScheduler;
    if (opts.activeCards) this.activeCards = opts.activeCards;
    if (opts.taskHistory) this.taskHistory = opts.taskHistory;
    if (opts.cliMode) this.cliMode = opts.cliMode;
    if (opts.onCliConversationSwitch) this.onCliConversationSwitch = opts.onCliConversationSwitch;
    if (opts.getCliConversationId) this.getCliConversationId = opts.getCliConversationId;
  }

  private harnessModeOf(conversationId: string): 'code' | 'chat' | 'lark' {
    if (this.cliMode === 'chat' || conversationId === 'cli-chat') return 'chat';
    if (
      this.cliMode === 'code' ||
      conversationId === 'cli-code' ||
      conversationId === 'cli-local'
    ) {
      return 'code';
    }
    return 'lark';
  }

  private acpPoolKey(profile: RuntimeProfile): string {
    return `${profile.bin}:${profile.model ?? ''}:${profile.agent ?? ''}`;
  }

  private getAcpPool(profile: RuntimeProfile): AcpPool {
    const key = this.acpPoolKey(profile);
    let pool = this.acpPools.get(key);
    if (!pool) {
      pool = new AcpPool({
        clientConfig: {
          binPath: profile.bin,
          model: profile.model,
          agent: profile.agent,
        },
        idleMs: 10 * 60 * 1000,
      });
      this.acpPools.set(key, pool);
    }
    return pool;
  }

  private async evictChatFromAllPools(conversationId: string): Promise<void> {
    await Promise.all([...this.acpPools.values()].map((p) => p.evict(conversationId)));
  }

  private async resolveChatRuntime(
    conversationId: string,
  ): Promise<{ profileName: string; profile: RuntimeProfile }> {
    const stored = await this.sessions.getRuntimeProfile(conversationId);
    if (!stored && (this.config.runtime?.default ?? 'kiro') === 'auto') {
      const picked = await chooseRuntimeProfile(this.config, { prompt: '' });
      return { profileName: `auto→${picked.profileName}`, profile: picked.profile };
    }
    const profileName = stored ?? this.config.runtime?.default ?? 'kiro';
    const profile = resolveRuntimeProfile(
      this.config,
      profileName === 'auto' ? 'kiro' : profileName,
    );
    return { profileName, profile };
  }

  private async selectRuntimeForTask(
    conversationId: string,
    prompt: string,
    mediaCount: number,
    commandName?: string,
  ): Promise<{
    profileName: string;
    profile: RuntimeProfile;
    reason: string;
    complexityScore?: number;
    modelDecision?: Awaited<ReturnType<typeof chooseModelForProfile>>;
  }> {
    const taskBucket = classifyTaskBucket({ prompt, mediaCount, commandName });
    const explicitProfileName = await this.sessions.getRuntimeProfile(conversationId);
    const harnessMode = this.harnessModeOf(conversationId);
    const monthUsageByKind = this.taskHistory
      ? await this.taskHistory.countMonthUsageByKind().catch(() => undefined)
      : undefined;
    let picked = await chooseRuntimeProfile(
      this.config,
      { prompt, mediaCount, commandName },
      explicitProfileName,
      { taskBucket, monthUsageByKind, harnessMode, health: sharedGatewayHealth },
    );

    // sticky：真实任务后锁定；纯闲聊不粘，避免 "hi" 锁死 cursor
    if (!explicitProfileName) {
      const table = resolveModeRouteTable(this.config, harnessMode);
      const score = picked.complexityScore ?? 0;
      const threshold = this.config.runtime?.router?.rules?.complexityThreshold ?? 4;
      const shouldStick =
        table.sticky &&
        (taskBucket !== 'chat' || score >= threshold) &&
        picked.profileName &&
        !picked.profileName.startsWith('auto→');
      if (shouldStick) {
        await this.sessions.setConversationRuntimeProfile(
          conversationId,
          picked.profileName,
          this.config.workspace.defaultCwd,
        );
        picked = {
          ...picked,
          reason: `${picked.reason};sticky`,
        };
      }
    }
    if (!explicitProfileName && this.taskHistory) {
      const adaptive = await this.taskHistory
        .recommendAdaptiveStrategy(200, taskBucket)
        .catch(() => undefined);
      if (!adaptive) {
        const modelDecision = await chooseModelForProfile(this.config, picked.profile, {
          prompt,
          mediaCount,
          commandName,
        });
        const profile =
          modelDecision.selectedModel !== undefined
            ? { ...picked.profile, model: modelDecision.selectedModel }
            : picked.profile;
        return {
          profileName: picked.profileName,
          profile,
          reason: `${picked.reason};adaptive-unavailable(bucket=${taskBucket})`,
          complexityScore: picked.complexityScore ?? modelDecision.complexityScore,
          modelDecision,
        };
      }
      const adaptiveMode = this.config.modelRouting.kiro.adaptiveMode;
      const applyGates = evaluateApplySafeGates({
        sampleSize: adaptive.sampleSize,
        runtimeSuccessRate: adaptive.runtimeSuccessRate,
        modelSuccessRate: adaptive.modelSuccessRate,
      });
      const canApplyRuntime =
        adaptiveMode === 'apply-aggressive' ||
        (adaptiveMode === 'apply-safe' && applyGates.canApplyRuntime);
      const canApplyModel =
        adaptiveMode === 'apply-aggressive' ||
        (adaptiveMode === 'apply-safe' && applyGates.canApplyModel);
      if (adaptiveMode !== 'off' && adaptive?.preferredRuntimeKind && canApplyRuntime) {
        const adaptiveProfileName = profileNameForRuntimeKind(adaptive.preferredRuntimeKind);
        picked = {
          profileName: adaptiveProfileName,
          profile: resolveRuntimeProfile(this.config, adaptiveProfileName),
          reason: `${picked.reason};adaptive-runtime(bucket=${taskBucket};${adaptive.reason})`,
          complexityScore: picked.complexityScore,
        };
      }
      if (
        adaptiveMode !== 'off' &&
        adaptive?.preferredModel &&
        picked.profile.kind === 'kiro-cli-acp' &&
        canApplyModel
      ) {
        picked = {
          ...picked,
          profile: { ...picked.profile, model: adaptive.preferredModel },
          reason: `${picked.reason};adaptive-model(bucket=${taskBucket};${adaptive.reason})`,
        };
      }
    }
    const modelDecision = await chooseModelForProfile(this.config, picked.profile, {
      prompt,
      mediaCount,
      commandName,
    });
    const profile =
      modelDecision.selectedModel !== undefined
        ? { ...picked.profile, model: modelDecision.selectedModel }
        : picked.profile;
    return {
      profileName: picked.profileName,
      profile,
      reason: `${picked.reason};${modelDecision.reason}`,
      complexityScore: picked.complexityScore ?? modelDecision.complexityScore,
      modelDecision,
    };
  }

  private getPipeline(conversationId: string): ChatPipeline {
    let p = this.pipelines.get(conversationId);
    if (!p) {
      p = new ChatPipeline(conversationId, this.log);
      this.pipelines.set(conversationId, p);
    }
    return p;
  }

  private conversationIdOfMessage(msg: IncomingMessage): string {
    return msg.chatId;
  }

  private conversationIdOfAction(evt: CardActionEvent): string {
    return evt.chatId;
  }

  private senderPrincipalIdOfMessage(msg: IncomingMessage): string {
    return msg.senderOpenId;
  }

  private senderPrincipalIdOfAction(evt: CardActionEvent): string {
    return evt.senderOpenId;
  }

  /** eventId 去重缓存：飞书 at-least-once 投递保险 */
  private readonly seenEventIds = new Map<string, number>();
  private readonly EVENT_TTL_MS = 5 * 60 * 1000;

  /**
   * rapid-fire 消息合并：同 chat 短时间连发时把多条消息拼成一次 Kiro 调用。
   *
   * 价值：用户在飞书 IM 里习惯连发短消息（"等等"、"还有"、"刚才那个改一下"），
   * 不合并的话每条都跑一次 Kiro，浪费 token 还会被前面的 abort 打断；合并后
   * 一次性给 Kiro 完整意图。
   *
   * 实现：每条消息进来先放 buffer，200ms 内有新消息就追加；到时一次性 submit。
   *   - 第一条触发计时器、注册 buffer
   *   - 后续消息往 buffer 里追加文本（+ 媒体路径）
   *   - 200ms 静默期到 → flush，用第一条的 msg/eventId 作为 reply 锚点
   */
  private readonly mergeBuffers = new Map<
    string,
    {
      anchor: IncomingMessage;
      texts: string[];
      mediaPaths: string[];
      /**
       * 待拉取的"引用/转发"来源消息 id 集合（合并转发自身 id 或引用回复的 parentId）。
       * 用 Set 去重：用户"转发 + 引用提问"时两条消息往往指向同一条源消息，只需拉一次。
       * 真正的网络拉取推迟到 flush 时进行，避免阻塞 200ms 合并窗口。
       */
      quoteSourceIds: Set<string>;
      cwd: string;
      perChatIdleMin: number | undefined;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly MERGE_WINDOW_MS = 200;
  /**
   * 合并转发消息的专属首窗，比普通消息长得多。
   * 用户「转发一段记录 → 切到输入框打字提问」的间隔通常 0.3–3 秒，远超 200ms。
   * 给 merge_forward 一个更长的等待窗，让后续追问能合并进同一次 Kiro 调用，
   * 避免"转发触发一次、提问又触发一次"的双任务抢占（一个被中止、一个回答）。
   * 续窗（已有 buffer 后再来消息）仍回落到 200ms——此时用户已在连发，不必久等。
   */
  private readonly MERGE_WINDOW_FORWARD_MS = 2500;

  /**
   * 引用/转发上下文的长度护栏。合并转发可能含几十条消息、大段文本，
   * 不限制会撑爆 Kiro 的 context window、烧 token、甚至触发模型长度上限错误。
   *   - QUOTE_MAX_SUBS：最多渲染多少条子消息（超出截断并提示"还有 N 条"）
   *   - QUOTE_MAX_LINE_CHARS：单条消息最多保留多少字符
   *   - QUOTE_MAX_TOTAL_CHARS：整段引用上下文的总字符上限
   */
  private readonly QUOTE_MAX_SUBS = 40;
  private readonly QUOTE_MAX_LINE_CHARS = 800;
  private readonly QUOTE_MAX_TOTAL_CHARS = 6000;

  private isDuplicate(eventId: string): boolean {
    if (!eventId) return false;
    const now = Date.now();
    // 顺手清理过期
    for (const [k, t] of this.seenEventIds) {
      if (now - t > this.EVENT_TTL_MS) this.seenEventIds.delete(k);
    }
    if (this.seenEventIds.has(eventId)) return true;
    this.seenEventIds.set(eventId, now);
    return false;
  }

  /**
   * 主入口：处理一条归一化入站消息（推荐）。
   */
  async handleNormalized(msg: NormalizedMessage): Promise<void> {
    return this.handle(toIncomingMessage(msg));
  }

  /**
   * 主入口：处理一条飞书消息（兼容；等价于 handleNormalized(fromLarkMessage(msg))）。
   */
  async handle(msg: IncomingMessage): Promise<void> {
    // 0) 去重（飞书 at-least-once 可能重推同一 eventId）
    if (this.isDuplicate(msg.eventId)) {
      this.log.info({ eventId: msg.eventId }, 'duplicate event, skip');
      return;
    }

    // 1) 学习 botOpenId（兜底：bootstrap 启动时已经调过 /open-apis/bot/v3/info 主动获取，
    //    极少数情况下接口没返回，就按"第一次有人 @ 任意 bot"的方式学习）
    if (!this.ingress.getCachedBotPrincipalId()) {
      // 飞书 mention.id_type 在 mentions[].key="@_user_X" 体系里区分不出"是不是机器人"，
      // 但群里被 @ 的人有 open_id；如果只有一个 mention，多半就是 @ 了 bot 自己。
      // 名字带 kiro / bot 的优先级最高（兼容老用户），其次回退到第一个 mention。
      const byName = msg.mentions.find((m) =>
        ['kiro', 'bot'].some((kw) => (m.name ?? '').toLowerCase().includes(kw)),
      )?.openId;
      const fallback = msg.mentions[0]?.openId;
      const guess = byName ?? fallback;
      if (guess) {
        this.ingress.setBotPrincipalId(guess);
        this.log.info(
          { openId: guess, source: byName ? 'name-match' : 'first-mention-fallback' },
          'bot open_id learned from mention',
        );
      }
    }

    // 2) 访问控制
    const conversationId = this.conversationIdOfMessage(msg);
    const senderPrincipalId = this.senderPrincipalIdOfMessage(msg);
    if (!isUserAllowed(senderPrincipalId, conversationId, msg.chatType, this.config)) {
      this.log.debug(
        { user: senderPrincipalId, chat: conversationId, chatType: msg.chatType },
        'message dropped by access control',
      );
      return;
    }

    // 3) 群里要 @bot 才回复（除非 preferences.requireMentionInGroup=false）
    if (msg.chatType === 'group' || msg.chatType === 'topic_group') {
      if (this.config.preferences.requireMentionInGroup) {
        const botOpenId = this.ingress.getCachedBotPrincipalId();
        if (botOpenId) {
          // 标准路径：用 open_id 精确判定，不依赖 bot 起的名字
          const botMentioned = msg.mentions.some((m) => m.openId === botOpenId);
          if (!botMentioned) {
            this.log.debug(
              { mentions: msg.mentions.length },
              'group message without @bot, ignored',
            );
            return;
          }
        } else {
          // 启动初期 botOpenId 还没 ready 的兜底：放过有 mention 的消息（可能就是 @bot），
          // 丢弃没有 mention 的消息。学习路径会在上一步生效，下一条消息起恢复正常。
          if (msg.mentions.length === 0) {
            this.log.debug('group message has no mentions and botOpenId unknown, ignored');
            return;
          }
        }
      }
    }

    // 4) 仅支持 text/post 消息；image/file/audio 走媒体下载；merge_forward 走转发内容拉取
    const supportedMedia =
      msg.messageType === 'image' || msg.messageType === 'file' || msg.messageType === 'audio';
    const isMergeForward = msg.messageType === 'merge_forward';
    if (
      msg.messageType !== 'text' &&
      msg.messageType !== 'post' &&
      !supportedMedia &&
      !isMergeForward
    ) {
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'error',
          title: '⚠️ 不支持的消息类型',
          body: `当前版本不支持 \`${msg.messageType}\` 类型，已忽略。`,
        }),
      );
      return;
    }

    // 提取纯净文本（去掉 @bot mention key）
    const botOpenIdForStrip =
      this.ingress.getCachedBotPrincipalId() ||
      msg.mentions.find((m) => (m.name ?? '').toLowerCase().includes('kiro'))?.openId ||
      '';
    const cleanText = stripMentions(msg, botOpenIdForStrip).trim();

    // 4.5) 媒体下载（在文本之前完成，下面 prompt 拼接时把路径塞前面）
    let mediaPaths: string[] = [];
    let asrText = ''; // 语音转写出来的文本，会被拼到 cleanText 前面
    if (supportedMedia) {
      try {
        mediaPaths = await this.ingress.downloadInboundMedia(fromLarkMessage(msg));
      } catch (e) {
        this.log.warn({ err: e }, 'media download error, will skip');
      }
      // 音频消息：尝试调飞书 ASR 转写。成功就把 .opus 路径从 mediaPaths 移除（kiro-cli 看不懂音频），
      // 失败则把音频当成普通"文件附件"留给 Kiro，Kiro 起码能告诉用户"这是个音频文件"。
      if (msg.messageType === 'audio' && mediaPaths.length > 0) {
        const audioPath = mediaPaths[0]!;
        const r = await this.ingress.transcribeInboundAudio(audioPath);
        if (r.ok) {
          asrText = r.text;
          mediaPaths = mediaPaths.filter((p) => p !== audioPath);
          this.log.info({ textLen: r.text.length }, 'audio transcribed');
        } else {
          this.log.warn({ reason: r.reason, detail: r.detail }, 'audio transcription failed');
          // 给用户一个明确的提示卡片，告诉他/她语音没识别成功。不阻塞继续
          // 走 runKiro（mediaPaths 还在，Kiro 至少能识别这是音频文件）。
          const hint = (() => {
            switch (r.reason) {
              case 'ffmpeg-missing':
                return '⚠️ 未检测到 `ffmpeg`，无法把语音转成文字。\n请安装：`brew install ffmpeg`（macOS）或包管理器对应命令。';
              case 'too-long':
                return `⚠️ 语音太长（${r.detail ?? '> 60s'}），飞书 ASR 仅支持 60 秒以内。请分段重发。`;
              case 'api-failed':
                return `⚠️ 语音识别失败：${r.detail ?? '请稍后重试'}`;
              case 'ffmpeg-failed':
                return '⚠️ 语音转码失败，可能音频文件损坏。';
              case 'empty':
                return '⚠️ 语音中没识别到有效内容。';
              default:
                return '⚠️ 语音识别失败。';
            }
          })();
          await this.sendInteractiveCard(
            msg,
            buildAckCard({ state: 'error', title: '🎙️ 语音转写失败', body: hint }),
          );
          // 如果用户没附带文字，就到此为止；附带了文字才继续走 Kiro
          if (!cleanText) return;
        }
      }
      if (mediaPaths.length === 0 && !cleanText && !asrText) {
        // 媒体下载失败、又没文字 → 报错给用户
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: 'error',
            title: '❌ 资源下载失败',
            body: `\`${msg.messageType}\` 资源下载失败，请重发或检查机器人权限。`,
          }),
        );
        return;
      }
    }

    // 4.6) 引用回复 / 合并转发：标记需要拉取的"源消息 id"，真正拉取推迟到合并 flush 时。
    //   - 引用回复：msg.parentId 指向被引用消息
    //   - 合并转发：messageType==merge_forward，用本条消息 id 拉出子消息
    // 关键：这里**不做网络请求**。之前在主路径 await 拉取，~250ms 的延迟会把
    // "转发 + 紧跟引用提问"这两条消息推过 200ms 合并窗口，导致它们变成两个互相
    // 抢占的独立任务（一个"已中止"一个正常回答）。推迟到 flush 拉取即可解决。
    const quoteSourceId = isMergeForward ? msg.messageId : (msg.parentId ?? '');

    if (!cleanText && !asrText && mediaPaths.length === 0 && !quoteSourceId) {
      this.log.debug('empty text after strip and no media/quote, ignored');
      return;
    }

    // 把 ASR 转写出的文本拼到用户文本前。
    //
    // 设计取舍：
    //   - 保留 [语音] 前缀，便于 /doctor 排查 ASR 链路
    //   - 后面加一段简短 system 提示，告诉 LLM 这是日常对话，不要变成 "ASR 系统状态汇报员"
    //     （之前 LLM 看到 [语音] 会把它当成调试场景，回复一大段 ASR 工作机制说明）
    //   - 转写可能有错别字，LLM 应自然按口语意图回应
    const ASR_SYSTEM_HINT =
      '（以上由语音转写得到，可能有错别字。请按用户日常对话的口语意图回答，简短自然，不要谈论"语音"或转写本身。）';
    const effectiveText = asrText
      ? cleanText
        ? `[语音] ${asrText}\n\n${cleanText}\n\n${ASR_SYSTEM_HINT}`
        : `[语音] ${asrText}\n\n${ASR_SYSTEM_HINT}`
      : cleanText;

    // 5) 解析命令
    const cmd = parseCommand(cleanText);
    const session = await this.sessions.getConversation(
      conversationId,
      this.config.workspace.defaultCwd,
    );

    // 命令需要管理员权限的判断
    const needAdmin = (() => {
      if (!cmd) return false;
      switch (cmd.kind) {
        case 'cd':
        case 'ws-save':
        case 'ws-use':
        case 'ws-remove':
        case 'reconnect':
        case 'config':
        case 'exit':
          return true;
        case 'memory':
          // list / view 只读，不要 admin；edit/new/rm 要
          return cmd.mode === 'edit' || cmd.mode === 'new' || cmd.mode === 'rm';
        case 'cron':
          // list 只读，不要 admin；其他全要
          return cmd.mode !== 'list' && cmd.mode !== 'next';
        case 'conduit':
          // run/plan 会建 worktree、跑 git、调多个 Kiro，要 admin；help 只读
          return cmd.mode !== 'help';
        case 'skill':
          // list / source-list 只读不要 admin；source-add/remove/sync 写操作要
          return cmd.mode !== 'list' && cmd.mode !== 'source-list';
        case 'agent':
          // show 只读不要 admin；其他全要
          return cmd.mode !== 'show';
        default:
          return false;
      }
    })();
    if (needAdmin && !isAdmin(senderPrincipalId, this.config)) {
      // 本地 REPL = 本机操作者，视为管理员（否则 /cd 等 coding 命令全被挡）
      if (!this.isTextChannel(conversationId)) {
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: 'error',
            title: '🚫 权限不足',
            body: '此命令仅管理员可用。',
          }),
        );
        return;
      }
    }

    // 6) 路由
    if (cmd) {
      switch (cmd.kind) {
        case 'help':
          if (this.isTextChannel(conversationId)) {
            await this.respondText(msg, formatCliHelp(this.cliMode ?? 'code'));
          } else {
            await this.sendInteractiveCard(
              msg,
              buildHelpCard({ skills: this.chatSkills.get(conversationId) }),
            );
          }
          return;
        case 'pwd': {
          const wsName = await this.workspaceNameOf(session.currentCwd);
          const body = wsName
            ? `📁 \`${session.currentCwd}\`\n🗂️ 工作区：\`${wsName}\``
            : `📁 \`${session.currentCwd}\``;
          await this.sendInteractiveCard(
            msg,
            buildAckCard({ state: 'done', title: '📁 当前目录', body }),
          );
          return;
        }
        case 'status': {
          const { profileName, profile } = await this.resolveChatRuntime(conversationId);
          const agentSid = await this.sessions.getConversationAgentSession(
            conversationId,
            session.currentCwd,
          );
          const wsName = await this.workspaceNameOf(session.currentCwd);
          if (this.isTextChannel(conversationId)) {
            const { formatCliStatusLine, gitBranch, shortenHomePath } = await import(
              '../ingress/cli/workspace.js'
            );
            const { estimateSessionContext } = await import('../runtime/contextEstimate.js');
            const branch = gitBranch(session.currentCwd);
            const phase = await this.sessions.getConversationPhase(conversationId);
            const planId = this.config.runtime?.plan ?? 'kiro-unlimited+cursor-lite';
            const circuits = sharedGatewayHealth.snapshot();
            const ctx = await estimateSessionContext({
              config: this.config,
              sessions: this.sessions,
              conversationId,
              cwd: session.currentCwd,
              profile,
            });
            const lines = [
              formatCliStatusLine({
                cwd: session.currentCwd,
                profileName,
                model: profile.model,
              }),
              `conversation: ${conversationId}`,
              `cwd: ${shortenHomePath(session.currentCwd)}`,
              branch ? `branch: ${branch}` : undefined,
              wsName ? `workspace: ${wsName}` : undefined,
              `runtime: ${profileName} (${profile.kind})`,
              profile.model ? `model: ${profile.model}` : undefined,
              `plan: ${planId}`,
              `harness: ${this.harnessModeOf(conversationId)}`,
              phase ? `phase: ${phase}` : undefined,
              agentSid ? `agentSession: ${agentSid.slice(0, 12)}…` : 'agentSession: (new)',
              `ctx: ~${ctx.pct}% (~${Math.round(ctx.tokens / 1000)}k / ${Math.round(ctx.thresholdTokens / 1000)}k tok)${ctx.hasSummary ? ' · compacted' : ''}`,
              session.filesTouched?.length
                ? `filesTouched: ${session.filesTouched.length}`
                : undefined,
              `task: ${this.getPipeline(conversationId).hasActiveTask() ? 'running' : 'idle'}`,
              circuits.length
                ? `gateway: ${circuits.map((c) => `${c.state}`).join(',')}`
                : 'gateway: ok',
            ].filter(Boolean);
            await this.respondText(msg, lines.join('\n'));
            return;
          }
          const idleMin = this.effectiveIdleMinutes(session.idleTimeoutMinutes);
          const cardOpts: Parameters<typeof buildStatusCard>[0] = {
            cwd: session.currentCwd,
            hasActiveTask: this.getPipeline(conversationId).hasActiveTask(),
            idleMinutes: idleMin,
            isPerChatOverride: session.idleTimeoutMinutes !== undefined,
            runtimeProfile: profileName,
            runtimeKind: profile.kind,
          };
          if (wsName !== undefined) cardOpts.workspaceName = wsName;
          if (agentSid !== undefined) cardOpts.kiroSessionId = agentSid;
          if (profile.agent !== undefined) cardOpts.currentAgent = profile.agent;
          else if (this.config.kiro.agent !== undefined)
            cardOpts.currentAgent = this.config.kiro.agent;
          await this.sendInteractiveCard(msg, buildStatusCard(cardOpts));
          return;
        }
        case 'runtime': {
          await this.handleRuntimeCmd(msg, cmd, session.currentCwd);
          return;
        }
        case 'new': {
          if (this.isTextChannel(conversationId) && this.onCliConversationSwitch) {
            const prefix = this.cliMode === 'chat' ? 'cli-chat' : 'cli-code';
            const nextId = `${prefix}-${Date.now().toString(36).slice(-6)}`;
            await this.sessions.setConversationCwd(
              nextId,
              session.currentCwd,
              this.config.workspace.defaultCwd,
            );
            await this.sessions.setConversationMeta(
              nextId,
              { title: `session ${nextId}`, phase: null, compactionSummary: null },
              this.config.workspace.defaultCwd,
            );
            this.onCliConversationSwitch(nextId);
            await this.respondText(
              msg,
              `🔄 New session: \`${nextId}\`\nNext message starts fresh in \`${session.currentCwd}\`.`,
            );
            return;
          }
          await this.sessions.clearConversationKiroSession(conversationId, session.currentCwd);
          await this.sessions.setConversationMeta(
            conversationId,
            { compactionSummary: null, phase: null },
            this.config.workspace.defaultCwd,
          );
          await this.evictChatFromAllPools(conversationId);
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'done',
              title: '🔄 会话已重置',
              body: `下次提问会在 \`${session.currentCwd}\` 下新建 agent session。`,
            }),
          );
          return;
        }
        case 'clear': {
          await this.sessions.setConversationMeta(
            conversationId,
            {
              compactionSummary: null,
              phase: null,
              filesTouched: null,
              lastCompactAt: null,
            },
            this.config.workspace.defaultCwd,
          );
          await this.sessions.clearConversationKiroSession(conversationId, session.currentCwd);
          await this.evictChatFromAllPools(conversationId);
          await this.respondText(
            msg,
            `🧹 Cleared transcript/summary for \`${conversationId}\` (same session id).`,
          );
          return;
        }
        case 'sessions': {
          const list = await this.sessions.listCliSessions();
          if (list.length === 0) {
            await this.respondText(msg, 'No CLI sessions yet. Chat once or /new.');
            return;
          }
          const active = this.getCliConversationId?.() ?? conversationId;
          const { shortenHomePath } = await import('../ingress/cli/workspace.js');
          const lines = list.slice(0, 30).map((s) => {
            const mark = s.id === active ? ' ←' : '';
            const when = new Date(s.lastActiveAt).toISOString().slice(0, 16).replace('T', ' ');
            const title = s.title ? ` "${s.title}"` : '';
            return `• \`${s.id}\`${mark}${title}  ${shortenHomePath(s.cwd)}  ${s.runtimeProfile ?? '-'}  ${s.phase ?? '-'}  ${when}${s.hasSummary ? '  [compact]' : ''}`;
          });
          await this.respondText(
            msg,
            ['CLI sessions:', ...lines, '', 'Switch: /resume <id> · Rename: /rename <title>'].join(
              '\n',
            ),
          );
          return;
        }
        case 'resume': {
          if (!this.isTextChannel(conversationId) || !this.onCliConversationSwitch) {
            await this.respondText(msg, '/resume is CLI-only.');
            return;
          }
          const list = await this.sessions.listCliSessions();
          const target = cmd.id
            ? list.find((s) => s.id === cmd.id || s.id.endsWith(cmd.id!))
            : list[0];
          if (!target) {
            await this.respondText(
              msg,
              cmd.id
                ? `Session not found: \`${cmd.id}\`. Use /sessions.`
                : 'No sessions to resume. Use /sessions.',
            );
            return;
          }
          this.onCliConversationSwitch(target.id);
          await this.respondText(
            msg,
            `✅ Resumed \`${target.id}\`\ncwd: ${target.cwd}\nruntime: ${target.runtimeProfile ?? '(auto)'}`,
          );
          return;
        }
        case 'rename': {
          await this.sessions.setConversationMeta(
            conversationId,
            { title: cmd.title },
            this.config.workspace.defaultCwd,
          );
          await this.respondText(msg, `✅ Renamed session → ${cmd.title}`);
          return;
        }
        case 'compact': {
          await this.handleCompactCmd(msg, cmd.focus);
          return;
        }
        case 'phase-plan': {
          await this.handlePhaseCmd(msg, 'plan', cmd.prompt);
          return;
        }
        case 'phase-review': {
          await this.handlePhaseCmd(msg, 'review', cmd.prompt);
          return;
        }
        case 'phase-apply': {
          await this.handlePhaseCmd(msg, 'apply');
          return;
        }
        case 'explore': {
          await this.handleSubagentCmd(msg, 'explore', cmd.query);
          return;
        }
        case 'subtest': {
          await this.handleSubagentCmd(msg, 'test', cmd.query);
          return;
        }
        case 'worktree': {
          await this.handleWorktreeCmd(msg, cmd);
          return;
        }
        case 'parallel': {
          await this.handleParallelCmd(msg, cmd.worktree, cmd.prompt);
          return;
        }
        case 'jobs': {
          await this.handleJobsCmd(msg, cmd.id);
          return;
        }
        case 'stop': {
          const ok = this.getPipeline(conversationId).abortCurrent();
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: ok ? 'aborted' : 'done',
              title: ok ? '⏹ 已发出中止信号' : 'ℹ️ 没有进行中的任务',
              body: ok
                ? '当前任务正在收尾，最多 2 秒后切到中止态。'
                : '当前 chat 没有正在跑的 Kiro 任务。',
            }),
          );
          return;
        }
        case 'cd': {
          try {
            const abs = validateCwd(cmd.path, this.config, session.currentCwd);
            await this.sessions.setConversationCwd(
              conversationId,
              abs,
              this.config.workspace.defaultCwd,
            );
            const wsName = await this.workspaceNameOf(abs);
            await this.sendInteractiveCard(
              msg,
              buildAckCard({
                state: 'done',
                title: '📁 目录已切换',
                body: wsName ? `\`${abs}\`\n🗂️ 工作区：\`${wsName}\`` : `\`${abs}\``,
              }),
            );
          } catch (e) {
            const m = e instanceof SecurityError ? e.message : String((e as Error).message);
            await this.sendInteractiveCard(
              msg,
              buildAckCard({ state: 'error', title: '❌ 切换失败', body: m }),
            );
          }
          return;
        }
        case 'ws-list': {
          const all = await this.workspaces.list();
          await this.sendInteractiveCard(
            msg,
            buildWorkspaceListCard({ workspaces: all, currentCwd: session.currentCwd }),
          );
          return;
        }
        case 'ws-save': {
          await this.workspaces.save(cmd.name, session.currentCwd);
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'done',
              title: '🗂️ 工作区已保存',
              body: `\`${cmd.name}\` → \`${session.currentCwd}\``,
            }),
          );
          return;
        }
        case 'ws-use': {
          const target = await this.workspaces.get(cmd.name);
          if (!target) {
            await this.sendInteractiveCard(
              msg,
              buildAckCard({
                state: 'error',
                title: '❌ 工作区不存在',
                body: `没有名为 \`${cmd.name}\` 的工作区。用 \`/ws list\` 查看全部。`,
              }),
            );
            return;
          }
          try {
            const abs = validateCwd(target, this.config, session.currentCwd);
            await this.sessions.setConversationCwd(
              conversationId,
              abs,
              this.config.workspace.defaultCwd,
            );
            await this.sendInteractiveCard(
              msg,
              buildAckCard({
                state: 'done',
                title: '🗂️ 工作区已切换',
                body: `\`${cmd.name}\` → \`${abs}\``,
              }),
            );
          } catch (e) {
            const m = e instanceof SecurityError ? e.message : String((e as Error).message);
            await this.sendInteractiveCard(
              msg,
              buildAckCard({ state: 'error', title: '❌ 切换失败', body: m }),
            );
          }
          return;
        }
        case 'ws-remove': {
          const ok = await this.workspaces.remove(cmd.name);
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: ok ? 'done' : 'error',
              title: ok ? '🗑️ 工作区已删除' : '❌ 工作区不存在',
              body: ok ? `已删除 \`${cmd.name}\`` : `没有名为 \`${cmd.name}\` 的工作区`,
            }),
          );
          return;
        }
        case 'timeout': {
          await this.handleTimeoutCmd(msg, session, cmd);
          return;
        }
        case 'reconnect': {
          if (this.isTextChannel(conversationId)) {
            await this.respondText(
              msg,
              'Gateway-only: /reconnect is unavailable in local REPL.\nUse: lwa serve',
            );
            return;
          }
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'done',
              title: '🔄 正在重连',
              body: '正在重新建立飞书 WebSocket 连接…',
            }),
          );
          if (this.onReconnect) {
            try {
              await this.onReconnect();
            } catch (e) {
              this.log.warn({ err: e }, 'reconnect failed');
            }
          }
          return;
        }
        case 'doctor': {
          await this.handleDoctorCmd(msg, cmd.description, session.currentCwd);
          return;
        }
        case 'selftest': {
          await this.handleSelftestCmd(msg);
          return;
        }
        case 'model': {
          await this.handleModelCmd(msg, cmd, session.currentCwd);
          return;
        }
        case 'config': {
          await this.handleConfigCmd(msg);
          return;
        }
        case 'ps': {
          await this.handlePsCmd(msg);
          return;
        }
        case 'exit': {
          await this.handleExitCmd(msg, cmd.target);
          return;
        }
        case 'memory': {
          await this.handleMemoryCmd(msg, cmd, session.currentCwd);
          return;
        }
        case 'cron': {
          await this.handleCronCmd(msg, cmd, session.currentCwd);
          return;
        }
        case 'schedule': {
          await this.handleScheduleCmd(msg);
          return;
        }
        case 'conduit': {
          await this.handleConduitCmd(msg, cmd, session.currentCwd);
          return;
        }
        case 'skill': {
          await this.handleSkillCmd(msg, cmd);
          return;
        }
        case 'agent': {
          await this.handleAgentCmd(msg, cmd);
          return;
        }
        case 'kiro-internal': {
          const body = [
            `❓ \`/${cmd.name}\` 是 kiro-cli 的**交互式 TUI** 命令，桥接器通过 ACP 程序化驱动 kiro-cli，无法执行交互式命令。`,
            '',
            '**怎么办**',
            cmd.name === 'model' || cmd.name === 'agent'
              ? `要切换 ${cmd.name === 'model' ? '模型' : 'agent'}，请编辑 \`${configPathTilde()}\` 里的 \`kiro.${cmd.name}\` 字段，然后 \`/reconnect\` 生效。`
              : `这条命令只在终端跑 \`kiro-cli\` 时可用，桥接器无法代理。`,
            '',
            '**桥接器自身的命令** 用 `/help` 查看。',
          ].join('\n');
          await this.replyErrorCard(msg, body, session.currentCwd);
          return;
        }
        case 'unknown':
          // 不识别的 /xxx 命令：原样转发给 Kiro
          break;
      }
    }

    // 7) 普通消息 / 未知命令 → 跑 Kiro
    await this.runKiroTask(
      msg,
      effectiveText,
      session.currentCwd,
      mediaPaths,
      session.idleTimeoutMinutes,
      quoteSourceId,
    );
  }

  /**
   * 拉取一条「源消息」的内容，渲染成给 Kiro 的上下文文本。
   *
   * 源消息可能是：
   *   - 合并转发消息本身（用户直接转发）
   *   - 被引用回复的消息（用户引用提问），它本身又可能是一条合并转发
   *
   * 渲染策略（关键）：不再假设"引用回复一定是单条正文"。拉回 items 后：
   *   - 若存在带 upperMessageId 的子消息（说明源是合并转发）→ 渲染全部子消息为聊天记录。
   *     这修了之前的 bug：引用回复指向一条合并转发时，旧代码只取首项（父占位符
   *     [合并转发消息]），拿不到真正的子消息内容，导致 Kiro 收到空上下文乱答。
   *   - 否则（普通单条消息）→ 取首项正文。
   *
   * 拉取失败 / 无可读内容时返回空字符串，调用方据此降级。
   */
  private async fetchQuoteContent(sourceMessageId: string): Promise<string> {
    const clip = (s: string, max: number): string =>
      s.length > max ? `${s.slice(0, max)}…[已截断]` : s;
    try {
      const items = await this.ingress.getMessageContent(sourceMessageId);
      if (items.length === 0) return '';

      const subs = items.filter((it) => it.upperMessageId);
      if (subs.length > 0) {
        // 合并转发：渲染子消息为「发送者：内容」，带长度/条数护栏
        const total = subs.length;
        const shown = subs.slice(0, this.QUOTE_MAX_SUBS);
        const lines: string[] = [];
        for (const it of shown) {
          const text = larkItemToText(it);
          if (!text) continue;
          const clipped = clip(text, this.QUOTE_MAX_LINE_CHARS);
          lines.push(it.senderName ? `${it.senderName}：${clipped}` : clipped);
        }
        if (lines.length === 0) {
          this.log.info({ sourceMessageId }, 'forward fetched but no readable sub-message');
          return '';
        }
        if (total > shown.length) {
          lines.push(`…（还有 ${total - shown.length} 条消息未展示）`);
        }
        let body = lines.join('\n');
        body = clip(body, this.QUOTE_MAX_TOTAL_CHARS);
        this.log.info(
          { sourceMessageId, total, shown: lines.length, chars: body.length },
          'forward context fetched',
        );
        return `【以下是用户转发的聊天记录】\n${body}`;
      }

      // 普通单条消息：取首项正文
      const first = items[0];
      if (!first) return '';
      const text = larkItemToText(first);
      // interactive 卡片由 getMessageContent 带 card_msg_content_type=user_card_content
      // 拉到原始卡片 JSON，larkItemToText 会抽出其正文 markdown。
      // 仍为空则放弃（纯按钮卡片、被撤回等），调用方降级。
      if (!text) {
        this.log.info(
          { sourceMessageId, msgType: first.msgType },
          'quoted message has no extractable text',
        );
        return '';
      }
      this.log.info(
        { sourceMessageId, senderType: first.senderType },
        'quoted message context fetched',
      );
      const clipped = clip(text, this.QUOTE_MAX_TOTAL_CHARS);
      // 引用 bot 自己的回复（sender_type==app 或 interactive 卡片）：语义是「针对你刚才那段展开/追问」，
      // 配合 FOCUS_HINT 让 Kiro 锁定这一条而不是反问「你想说哪个」。
      const isFromBot = first.senderType === 'app' || first.msgType === 'interactive';
      if (isFromBot) {
        return `【用户引用了你（助手）之前的这条回复，希望你针对它继续展开或追问】\n${clipped}`;
      }
      const who = first.senderName ? `（来自 ${first.senderName}）` : '';
      return `【用户引用了以下消息${who}】\n${clipped}`;
    } catch (e) {
      this.log.warn({ err: (e as Error).message, sourceMessageId }, 'fetchQuoteContent failed');
      return '';
    }
  }

  private async workspaceNameOf(cwd: string): Promise<string | undefined> {
    const all = await this.workspaces.list();
    for (const [name, p] of Object.entries(all)) {
      if (p === cwd) return name;
    }
    return undefined;
  }

  /**
   * 计算某个 chat 实际生效的 idle watchdog 分钟数。
   *   - per-chat override 存在（包括 0）→ 优先用它
   *   - 否则用 config.kiro.idleTimeoutMinutes
   */
  private effectiveIdleMinutes(perChatOverride: number | undefined): number {
    if (perChatOverride !== undefined) return perChatOverride;
    return this.config.kiro.idleTimeoutMinutes;
  }

  private async handleTimeoutCmd(
    msg: IncomingMessage,
    session: { idleTimeoutMinutes?: number; currentCwd: string },
    cmd: Extract<ParsedCommand, { kind: 'timeout' }>,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    if (cmd.mode === 'show') {
      const eff = this.effectiveIdleMinutes(session.idleTimeoutMinutes);
      const body = [
        `当前阈值：**${eff > 0 ? `${eff} 分钟` : '关闭'}**${
          session.idleTimeoutMinutes !== undefined ? '（per-chat 覆盖）' : '（全局默认）'
        }`,
        '',
        "<font color='grey'>用法</font>",
        '`/timeout 10` — 改成 10 分钟',
        '`/timeout off` — 关闭',
        '`/timeout default` — 回归全局默认',
      ].join('\n');
      await this.sendInteractiveCard(
        msg,
        buildAckCard({ state: 'done', title: '⏱ Idle Watchdog', body }),
      );
      return;
    }
    if (cmd.mode === 'set') {
      await this.sessions.setConversationIdleTimeout(
        conversationId,
        cmd.minutes,
        this.config.workspace.defaultCwd,
      );
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'done',
          title: '⏱ 已设置',
          body: `idle watchdog → \`${cmd.minutes}\` 分钟`,
        }),
      );
      return;
    }
    if (cmd.mode === 'off') {
      await this.sessions.setConversationIdleTimeout(
        conversationId,
        0,
        this.config.workspace.defaultCwd,
      );
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'done',
          title: '⏱ 已关闭',
          body: '当前 chat 不会因为长时间无输出而被自动终止。',
        }),
      );
      return;
    }
    // default
    await this.sessions.setConversationIdleTimeout(
      conversationId,
      undefined,
      this.config.workspace.defaultCwd,
    );
    const eff = this.effectiveIdleMinutes(undefined);
    await this.sendInteractiveCard(
      msg,
      buildAckCard({
        state: 'done',
        title: '⏱ 已恢复默认',
        body: `回归全局默认：${eff > 0 ? `${eff} 分钟` : '关闭'}`,
      }),
    );
  }

  /**
   * /doctor [描述]
   * CLI 无描述：本地体检（plan/runtime/gateway/memory/git），不调 LLM。
   * 有描述或飞书：把最近日志 + 描述喂给 Kiro 自诊断。
   */
  private async handleDoctorCmd(
    msg: IncomingMessage,
    description: string,
    cwd: string,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    const desc = description.trim();
    if (this.isTextChannel(conversationId) && !desc) {
      const { runCliDoctor } = await import('../runtime/cliDoctor.js');
      const report = await runCliDoctor({
        config: this.config,
        cwd,
        harnessMode: this.harnessModeOf(conversationId),
        conversationId,
      });
      await this.respondText(msg, report.text);
      return;
    }
    const lines = readRecentLogLines(200);
    const userDesc = desc || '（无）';
    const prompt = [
      '你是 LWA gateway 的运维助手。下面是这个网关最近的结构化日志（NDJSON），',
      '以及用户描述的问题。请基于日志找出可能的故障点，给出诊断结论和修复建议。',
      '只看日志，不要假设其他状态。',
      '',
      '**用户描述**',
      userDesc,
      '',
      '**最近日志（最多 200 行，已截短长行）**',
      '```',
      lines.length > 0 ? lines.join('\n') : '（无日志）',
      '```',
    ].join('\n');
    const session = await this.sessions.getConversation(
      conversationId,
      this.config.workspace.defaultCwd,
    );
    await this.runKiroTask(msg, prompt, cwd, [], session.idleTimeoutMinutes);
  }

  /**
   * /selftest 命令：跑结构化健康检查并回一张报告卡片。
   *
   * 检查项见 `src/lib/selftest.ts`。这里负责把运行时上下文（WS 状态、token 缓存）
   * 注入给 runSelfChecks，结果交给 buildSelftestCard 渲染。
   *
   * 注意：hasTokenCache 在当前 SDK 没有公开 API 查询，用 isWsConnected() 近似——
   * WS 连上就意味着 token 至少拿过一次。
   */
  private async handleSelftestCmd(msg: IncomingMessage): Promise<void> {
    const wsConnected = this.ingress.isConnected();
    const report = await runSelfChecks({
      config: this.config,
      senderOpenId: msg.senderOpenId,
      wsConnected,
      hasTokenCache: wsConnected,
      kiroBinPath: this.config.kiro.binPath,
    });
    await this.sendInteractiveCard(msg, buildSelftestCard(report));
  }

  private async maybeAutoCompact(
    conversationId: string,
    cwd: string,
    nextPrompt: string,
  ): Promise<void> {
    const compactCfg = this.config.runtime?.compact;
    const enabled = compactCfg?.auto ?? true;
    const threshold = compactCfg?.thresholdChars ?? 80_000;
    const cooldown = compactCfg?.cooldownMs ?? 60_000;

    const { estimateContextChars, shouldAutoCompact } = await import('../runtime/autoCompact.js');
    const { microCompactMessages } = await import('../runtime/microCompact.js');
    const { readOpenAISessionMessages } = await import('../runtime/openaiCompatibleRuntime.js');
    const session = await this.sessions.getConversation(
      conversationId,
      this.config.workspace.defaultCwd,
    );
    const { profile } = await this.resolveChatRuntime(conversationId);
    const agentSid = await this.sessions.getConversationAgentSession(conversationId, cwd);

    const summary = session.compactionSummary ?? '';
    let messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    if (profile.kind === 'openai-compatible' && agentSid) {
      const nativeId = decodeSessionId(agentSid, profile.kind);
      if (nativeId) messages = await readOpenAISessionMessages(nativeId);
    }
    if (messages.length === 0 && summary) {
      messages = [{ role: 'user', content: summary }];
    }
    messages = microCompactMessages(messages);
    const chars = estimateContextChars(messages, [summary, nextPrompt]);
    if (
      !shouldAutoCompact({
        chars,
        thresholdChars: threshold,
        enabled,
        lastCompactAt: session.lastCompactAt,
        cooldownMs: cooldown,
      })
    ) {
      return;
    }

    process.stdout.write(
      `(auto-compact: ~${Math.round(chars / 1000)}k chars ≥ ${Math.round(threshold / 1000)}k)\n`,
    );
    await this.performCompact(conversationId, 'auto: keep goals, files, decisions, todos');
  }

  private async handleCompactCmd(msg: IncomingMessage, focus?: string): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    const result = await this.performCompact(conversationId, focus);
    await this.respondText(
      msg,
      [
        `✅ Compacted via ${result.via} (${result.profileName})`,
        focus ? `focus: ${focus}` : undefined,
        result.rereadCount ? `re-read: ${result.rereadCount} file(s)` : undefined,
        '',
        result.summary.slice(0, 1200),
        result.summary.length > 1200 ? '\n…' : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  /** 执行 compact；返回摘要，不直接回复用户。 */
  private async performCompact(
    conversationId: string,
    focus?: string,
  ): Promise<{ summary: string; via: string; profileName: string; rereadCount: number }> {
    const session = await this.sessions.getConversation(
      conversationId,
      this.config.workspace.defaultCwd,
    );
    const { compactMessages } = await import('../runtime/compact.js');
    const { microCompactMessages } = await import('../runtime/microCompact.js');
    const { buildFilesRereadBlock } = await import('../runtime/artifacts.js');
    const { readOpenAISessionMessages, replaceOpenAISessionWithSummary } = await import(
      '../runtime/openaiCompatibleRuntime.js'
    );

    const { profileName, profile } = await this.resolveChatRuntime(conversationId);
    const agentSid = await this.sessions.getConversationAgentSession(
      conversationId,
      session.currentCwd,
    );

    let messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    if (profile.kind === 'openai-compatible' && agentSid) {
      const nativeId = decodeSessionId(agentSid, profile.kind);
      if (nativeId) messages = await readOpenAISessionMessages(nativeId);
    }
    messages = microCompactMessages(messages);

    const filesTouched = session.filesTouched ?? [];
    const focusWithFiles =
      filesTouched.length > 0
        ? [focus, `files touched: ${filesTouched.slice(-12).join(', ')}`].filter(Boolean).join('\n')
        : focus;

    const { summary, via } = await compactMessages(this.config, messages, focusWithFiles);
    const reread = buildFilesRereadBlock(session.currentCwd, filesTouched);
    const fullSummary = reread ? `${summary}\n\n${reread}` : summary;

    await this.sessions.setConversationMeta(
      conversationId,
      { compactionSummary: fullSummary, lastCompactAt: Date.now() },
      this.config.workspace.defaultCwd,
    );

    if (profile.kind === 'openai-compatible' && agentSid) {
      const nativeId = decodeSessionId(agentSid, profile.kind);
      if (nativeId) {
        await replaceOpenAISessionWithSummary(nativeId, session.currentCwd, fullSummary);
      }
    } else {
      await this.sessions.clearConversationKiroSession(conversationId, session.currentCwd);
      await this.evictChatFromAllPools(conversationId);
    }

    return {
      summary: fullSummary,
      via,
      profileName,
      rereadCount: Math.min(6, filesTouched.length),
    };
  }

  private async handlePhaseCmd(
    msg: IncomingMessage,
    phase: 'plan' | 'apply' | 'review',
    prompt?: string,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    await this.sessions.setConversationMeta(
      conversationId,
      { phase },
      this.config.workspace.defaultCwd,
    );

    // 阶段默认引擎：plan/review → kiro；apply 保持 sticky/auto
    if (phase === 'plan' || phase === 'review') {
      try {
        resolveRuntimeProfile(this.config, 'kiro');
        await this.sessions.setConversationRuntimeProfile(
          conversationId,
          'kiro',
          this.config.workspace.defaultCwd,
        );
      } catch {
        // kiro 不可用则不强制
      }
    }

    if (!prompt) {
      const hints: Record<typeof phase, string> = {
        plan: 'Plan phase on. Next message: design only — no file edits. Or: /plan <your goal>',
        apply: 'Apply phase on. Next message: implement the plan.',
        review: 'Review phase on (read-only). Next message: review target. Or: /review <scope>',
      };
      await this.respondText(
        msg,
        `✅ ${hints[phase]}\nruntime sticky → prefer kiro for plan/review`,
      );
      return;
    }

    // 带 prompt：直接当一轮用户消息跑
    const prefixed =
      phase === 'plan'
        ? `[PLAN ONLY — do not edit files]\n${prompt}`
        : phase === 'review'
          ? `[REVIEW ONLY — read-only; list findings, risks, suggestions; do not edit]\n${prompt}`
          : prompt;
    const session = await this.sessions.getConversation(
      conversationId,
      this.config.workspace.defaultCwd,
    );
    const idleMin = this.effectiveIdleMinutes(session.idleTimeoutMinutes);
    const taskId = `phase-${phase}-${Date.now()}`;
    if (this.isTextChannel(conversationId)) {
      await this.executeCliTurn(
        msg,
        prefixed,
        session.currentCwd,
        idleMin * 60_000,
        taskId,
        Date.now(),
      );
      return;
    }
    await this.executeKiroTask(msg, prefixed, session.currentCwd, [], idleMin);
  }

  private async handleSubagentCmd(
    msg: IncomingMessage,
    role: 'explore' | 'test' | 'review',
    query?: string,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    if (!this.isTextChannel(conversationId)) {
      await this.respondText(msg, `/${role} is CLI-oriented; use Feishu chat for normal turns.`);
      return;
    }
    const { buildSubagentPrompt, subagentDefaultRuntime } = await import('../runtime/subagents.js');
    const parent = await this.sessions.getConversation(
      conversationId,
      this.config.workspace.defaultCwd,
    );
    const childId = `cli-sub-${role}-${Date.now().toString(36).slice(-5)}`;
    await this.sessions.setConversationCwd(
      childId,
      parent.currentCwd,
      this.config.workspace.defaultCwd,
    );
    const runtimeName = subagentDefaultRuntime(role);
    try {
      resolveRuntimeProfile(this.config, runtimeName);
      await this.sessions.setConversationRuntimeProfile(
        childId,
        runtimeName,
        this.config.workspace.defaultCwd,
      );
    } catch {
      // keep auto
    }
    await this.sessions.setConversationMeta(
      childId,
      { title: `sub:${role}`, phase: role === 'review' ? 'review' : null },
      this.config.workspace.defaultCwd,
    );

    const prompt = buildSubagentPrompt(role, query ?? '');
    process.stdout.write(`\n(subagent ${role} → ${runtimeName} · ${childId})\n`);

    // 临时把消息 conversation 指到 child：构造浅拷贝
    const childMsg = { ...msg, conversationId: childId, chatId: childId };
    const idleMin = this.effectiveIdleMinutes(parent.idleTimeoutMinutes);
    await this.executeCliTurn(
      childMsg as IncomingMessage,
      prompt,
      parent.currentCwd,
      idleMin * 60_000,
      `sub-${role}-${Date.now()}`,
      Date.now(),
    );

    // 把子会话摘要挂到父会话（不自动切换过去）
    const childSummary = await this.sessions.getCompactionSummary(childId);
    if (childSummary) {
      const prev = (await this.sessions.getCompactionSummary(conversationId)) ?? '';
      await this.sessions.setConversationMeta(
        conversationId,
        {
          compactionSummary: `${prev}\n\n[subagent:${role}]\n${childSummary}`.trim(),
        },
        this.config.workspace.defaultCwd,
      );
    }
    await this.respondText(
      msg,
      `\n(subagent ${role} done · child \`${childId}\` kept for /resume; you are still on \`${conversationId}\`)`,
    );
  }

  private async handleWorktreeCmd(
    msg: IncomingMessage,
    cmd: Extract<ParsedCommand, { kind: 'worktree' }>,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    const session = await this.sessions.getConversation(
      conversationId,
      this.config.workspace.defaultCwd,
    );
    const { findGitRoot, listWorktrees, addWorktree, removeWorktree, WorktreeError } = await import(
      '../ingress/cli/worktree.js'
    );
    const { validateCwd } = await import('../lib/security.js');

    const root = findGitRoot(session.currentCwd);
    if (cmd.mode === 'help') {
      await this.respondText(
        msg,
        [
          'Git worktree (parallel agents)',
          '  /worktree list',
          '  /worktree add <name>   create <repo>/.lwa-worktrees/<name>',
          '  /worktree use <name>   /cd into that worktree',
          '  /worktree rm <name>',
          '  /parallel <name> <prompt>  run agent in that worktree (background)',
          '  /jobs                  list background jobs',
          '',
          'Optional: install BrowserSkill (`bsk`) for logged-in browser automation — not bundled.',
        ].join('\n'),
      );
      return;
    }
    if (!root) {
      await this.respondText(msg, 'Not inside a git repo.');
      return;
    }
    try {
      if (cmd.mode === 'list') {
        const list = listWorktrees(root);
        const lines = list.map(
          (w) =>
            `• ${w.path}${w.branch ? ` (${w.branch})` : ''}${w.path === root ? ' ← main' : ''}`,
        );
        await this.respondText(msg, ['Worktrees:', ...lines].join('\n'));
        return;
      }
      if (cmd.mode === 'add') {
        const { path, branch } = addWorktree(root, cmd.name);
        await this.respondText(
          msg,
          `✅ worktree added\npath: \`${path}\`\nbranch: \`${branch}\`\nUse: /worktree use ${cmd.name}`,
        );
        return;
      }
      if (cmd.mode === 'use') {
        const list = listWorktrees(root);
        const hit =
          list.find((w) => w.path.endsWith(`/${cmd.name}`) || w.path.endsWith(`\\${cmd.name}`)) ??
          list.find((w) => w.branch === `lwa/${cmd.name}`);
        if (!hit) {
          await this.respondText(msg, `Worktree not found: ${cmd.name}. /worktree list`);
          return;
        }
        const abs = validateCwd(hit.path, this.config, session.currentCwd);
        await this.sessions.setConversationCwd(
          conversationId,
          abs,
          this.config.workspace.defaultCwd,
        );
        await this.respondText(msg, `✅ cwd → \`${abs}\``);
        return;
      }
      if (cmd.mode === 'rm') {
        const removed = removeWorktree(root, cmd.name);
        await this.respondText(msg, `✅ removed \`${removed}\``);
        return;
      }
    } catch (e) {
      const message = e instanceof WorktreeError ? e.message : (e as Error).message;
      await this.respondText(msg, `❌ worktree: ${message}`);
    }
  }

  /**
   * /parallel <worktree> <prompt>
   * 在隔离 worktree 里后台跑 agent；主会话可继续输入。用 /jobs 查看。
   */
  private async handleParallelCmd(
    msg: IncomingMessage,
    worktreeName: string,
    prompt: string,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    if (!this.isTextChannel(conversationId)) {
      await this.respondText(msg, '/parallel is CLI-only.');
      return;
    }
    const session = await this.sessions.getConversation(
      conversationId,
      this.config.workspace.defaultCwd,
    );
    const { findGitRoot, listWorktrees, addWorktree, defaultWorktreeParent, WorktreeError } =
      await import('../ingress/cli/worktree.js');
    const { validateCwd } = await import('../lib/security.js');
    const { createParallelJob, updateParallelJob } = await import('../runtime/parallelJobs.js');
    const { join } = await import('node:path');
    const { existsSync } = await import('node:fs');

    const root = findGitRoot(session.currentCwd);
    if (!root) {
      await this.respondText(msg, 'Not inside a git repo. /parallel needs a worktree.');
      return;
    }

    let wtPath: string;
    try {
      const parent = defaultWorktreeParent(root);
      const expected = join(parent, worktreeName);
      const existing = listWorktrees(root).find(
        (w) =>
          w.path === expected ||
          w.path.endsWith(`/${worktreeName}`) ||
          w.branch === `lwa/${worktreeName}`,
      );
      if (existing) {
        wtPath = existing.path;
      } else if (existsSync(expected)) {
        wtPath = expected;
      } else {
        wtPath = addWorktree(root, worktreeName).path;
      }
      wtPath = validateCwd(wtPath, this.config, session.currentCwd);
    } catch (e) {
      const message = e instanceof WorktreeError ? e.message : (e as Error).message;
      await this.respondText(msg, `❌ parallel: ${message}`);
      return;
    }

    const childId = `cli-par-${worktreeName}-${Date.now().toString(36).slice(-5)}`;
    await this.sessions.setConversationCwd(childId, wtPath, this.config.workspace.defaultCwd);
    try {
      resolveRuntimeProfile(this.config, 'kiro');
      await this.sessions.setConversationRuntimeProfile(
        childId,
        'kiro',
        this.config.workspace.defaultCwd,
      );
    } catch {
      // auto
    }
    await this.sessions.setConversationMeta(
      childId,
      { title: `parallel:${worktreeName}` },
      this.config.workspace.defaultCwd,
    );

    const job = createParallelJob({
      parentConversationId: conversationId,
      childConversationId: childId,
      worktreeName,
      cwd: wtPath,
      promptPreview: prompt.slice(0, 120),
    });

    await this.respondText(
      msg,
      [
        `🚀 parallel job \`${job.id}\` started`,
        `worktree: ${worktreeName}`,
        `cwd: ${wtPath}`,
        `child: ${childId}`,
        '',
        'You can keep chatting here. Check: /jobs',
      ].join('\n'),
    );

    const childMsg = { ...msg, conversationId: childId, chatId: childId };
    const idleMin = this.effectiveIdleMinutes(session.idleTimeoutMinutes);
    const tag = `[${job.id}]`;

    void (async () => {
      try {
        process.stdout.write(`\n${tag} running in ${worktreeName}…\n`);
        await this.executeCliTurn(
          childMsg as IncomingMessage,
          `[PARALLEL worktree=${worktreeName} — isolated checkout; summarize result for parent]\n${prompt}`,
          wtPath,
          idleMin * 60_000,
          `par-${job.id}`,
          Date.now(),
        );
        let summary = await this.sessions.getCompactionSummary(childId);
        if (!summary) {
          try {
            const r = await this.performCompact(
              childId,
              'parallel result: goals done, files changed, remaining todos',
            );
            summary = r.summary;
          } catch {
            summary = `(parallel ${worktreeName} finished; no summary)`;
          }
        }
        const prev = (await this.sessions.getCompactionSummary(conversationId)) ?? '';
        await this.sessions.setConversationMeta(
          conversationId,
          {
            compactionSummary:
              `${prev}\n\n[parallel:${worktreeName} job=${job.id}]\n${summary}`.trim(),
          },
          this.config.workspace.defaultCwd,
        );
        updateParallelJob(job.id, {
          status: 'done',
          finishedAt: Date.now(),
          summaryPreview: summary.slice(0, 240),
        });
        process.stdout.write(`\n${tag} ✅ done · summary attached to parent · /jobs ${job.id}\n`);
      } catch (e) {
        const err = (e as Error).message;
        updateParallelJob(job.id, {
          status: 'error',
          finishedAt: Date.now(),
          error: err,
        });
        process.stdout.write(`\n${tag} ❌ ${err}\n`);
      }
    })();
  }

  private async handleJobsCmd(msg: IncomingMessage, id?: string): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    const { listParallelJobs, getParallelJob } = await import('../runtime/parallelJobs.js');
    if (id) {
      const job = getParallelJob(id);
      if (!job) {
        await this.respondText(msg, `Job not found: ${id}`);
        return;
      }
      await this.respondText(
        msg,
        [
          `job ${job.id} · ${job.status}`,
          `worktree: ${job.worktreeName}`,
          `cwd: ${job.cwd}`,
          `child: ${job.childConversationId}`,
          `started: ${new Date(job.startedAt).toISOString()}`,
          job.finishedAt ? `finished: ${new Date(job.finishedAt).toISOString()}` : undefined,
          job.error ? `error: ${job.error}` : undefined,
          job.summaryPreview ? `summary: ${job.summaryPreview}` : undefined,
          `prompt: ${job.promptPreview}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return;
    }
    const list = listParallelJobs(conversationId);
    if (list.length === 0) {
      await this.respondText(
        msg,
        'No parallel jobs yet. Try:\n  /parallel feat-a implement X\n  /jobs',
      );
      return;
    }
    const lines = list.slice(0, 20).map((j) => {
      const when = new Date(j.startedAt).toISOString().slice(11, 19);
      return `• \`${j.id}\` ${j.status}  ${j.worktreeName}  ${when}  ${j.promptPreview.slice(0, 40)}`;
    });
    await this.respondText(msg, ['Parallel jobs:', ...lines, '', 'Detail: /jobs <id>'].join('\n'));
  }

  /**
   * /model         → 列出所有模型 + 当前选中（漂亮按钮卡片）
   * /model <name>  → 切换模型，写入 config.json，立即生效
   * /model auto    → 清除模型覆盖，回归 kiro-cli 默认（auto）
   *
   * 短名容错：/model sonnet-4.6 → 自动补 claude- 前缀
   *
   * 设计取舍：
   *   - 切模型只改全局 config.json，不做 per-chat 覆盖（先做最少必要）
   *   - 切完不需要 reconnect，下一条消息直接生效（spawn kiro-cli 时读最新 config）
   */
  private async handleRuntimeCmd(
    msg: IncomingMessage,
    cmd: Extract<ParsedCommand, { kind: 'runtime' }>,
    _cwd: string,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    if (cmd.mode === 'show') {
      const { profileName, profile } = await this.resolveChatRuntime(conversationId);
      const names = listRuntimeProfileNames(this.config);
      const lines = names.map((n) => {
        const p = resolveRuntimeProfile(this.config, n);
        const cur = n === profileName ? ' ← 当前' : '';
        return `• \`${n}\` — ${p.kind} (\`${p.bin}\`)${cur}`;
      });
      const hint = names.map((n) => `\`/runtime ${n}\``).join(' · ');
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'done',
          title: '⚙️ Agent 引擎',
          body: [
            `当前：**${profileName}** (${profile.kind})`,
            '',
            '可用 profile：',
            ...lines,
            '',
            `切换：${hint}`,
            '诊断：`/runtime check`',
          ].join('\n'),
        }),
      );
      return;
    }

    if (cmd.mode === 'check') {
      const registry = await discoverRuntimeRegistry(this.config);
      const currentProfileName = (await this.resolveChatRuntime(conversationId)).profileName;
      const monthUsageByKind = this.taskHistory
        ? await this.taskHistory.countMonthUsageByKind().catch(() => ({}) as Record<string, number>)
        : ({} as Record<string, number>);
      const lines: string[] = [];
      for (const entry of registry) {
        const curMark = currentProfileName === entry.profileName ? ' ← 当前' : '';
        const base = `• \`${entry.profileName}\` — ${entry.profile.kind}${curMark}`;
        if (!entry.available) {
          lines.push(`${base}\n  - 状态：不可用\n  - 原因：${entry.detail ?? '未通过可用性检查'}`);
          continue;
        }
        const quota = await probeRuntimeQuota(entry.profile, entry.profileName, this.config, {
          monthUsage: monthUsageByKind[entry.profile.kind],
        });
        const modelLines: string[] = [];
        if (entry.profile.kind === 'openai-compatible' && entry.models.length > 0) {
          const { fast, strong } = suggestFastStrongModels(entry.models);
          modelLines.push(
            `  - 网关模型：${entry.models.length} 个（配置 model: \`${entry.profile.model ?? '-'}\`）`,
            `  - 启发式建议：fast=\`${fast ?? '-'}\` strong=\`${strong ?? '-'}\``,
            formatModelTierSummary(entry.models, 6)
              .split('\n')
              .map((l) => `    ${l}`)
              .join('\n'),
          );
        } else if (entry.profile.kind === 'kiro-cli-acp' && entry.models.length > 0) {
          modelLines.push(
            `  - 模型：${entry.models.slice(0, 6).join(', ')}${
              entry.models.length > 6 ? ` …共 ${entry.models.length} 个` : ''
            }`,
          );
        } else if (entry.detail?.includes('models:')) {
          modelLines.push(`  - 模型列表：${entry.detail}`);
        }
        lines.push(
          `${base}\n  - 状态：可用\n  - 探测：${entry.detail ?? 'ok'}\n  - Quota：${quota.state}${
            quota.detail ? ` · ${quota.detail}` : ''
          }${modelLines.length > 0 ? `\n${modelLines.join('\n')}` : ''}`,
        );
      }
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'done',
          title: '🩺 Runtime 检查',
          body: [
            '用于检查当前 bridge 上所有 runtime profile 的可用性与配额状态。',
            '',
            ...lines,
            '',
            '提示：OpenAI 兼容网关用 `GET /models` 发现模型；fast/strong 是 bridge 根据模型 id 的启发式分层，最终以 config 里各 profile 的 `model` 为准。',
            `套餐 plan：\`${this.config.runtime?.plan ?? 'kiro-unlimited+cursor-lite'}\` · harness：\`${this.harnessModeOf(conversationId)}\``,
            ...sharedGatewayHealth
              .snapshot()
              .map(
                (c) =>
                  `网关熔断：\`${c.key}\` state=${c.state} failures=${c.failures}${c.lastError ? ` (${c.lastError})` : ''}`,
              ),
            `终端也可运行：\`${cliCommand('models')}\``,
          ].join('\n'),
        }),
      );
      return;
    }

    const name = cmd.name;
    if (name === 'auto' || name === 'clear') {
      await this.sessions.clearConversationRuntimeProfile(conversationId);
      await this.evictChatFromAllPools(conversationId);
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'done',
          title: '✅ 已恢复智能路由',
          body: '已清除会话粘性引擎。下一条消息按当前 mode/plan 重新选择 runtime。',
        }),
      );
      return;
    }
    try {
      resolveRuntimeProfile(this.config, name);
    } catch {
      const valid = listRuntimeProfileNames(this.config)
        .map((n) => `\`${n}\``)
        .join('、');
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'error',
          title: '❌ 未知引擎',
          body: `没有 profile \`${name}\`。\n\n可用：${valid}\n或 \`/runtime auto\` 清除粘性。`,
        }),
      );
      return;
    }

    await this.sessions.setConversationRuntimeProfile(
      conversationId,
      name,
      this.config.workspace.defaultCwd,
    );
    // 换引擎：可选自动 compact 摘要交接，然后清底层 session（不跨引擎续接）
    const session = await this.sessions.getConversation(
      conversationId,
      this.config.workspace.defaultCwd,
    );
    let handoffNote = '旧底层 session 已断开；下一轮用新引擎。';
    if (session.compactionSummary) {
      handoffNote = '已保留 compact 摘要交接；旧底层 session 已断开。';
    } else if (this.isTextChannel(conversationId)) {
      try {
        await this.performCompact(
          conversationId,
          `runtime handoff → ${name}: keep goals, files, decisions, todos`,
        );
        handoffNote = '已自动 compact 并交接摘要；旧底层 session 已断开。';
      } catch {
        handoffNote = '摘要交接失败，已切换引擎；建议手动 /compact。';
      }
    }
    await this.sessions.clearConversationKiroSession(conversationId, session.currentCwd);
    await this.evictChatFromAllPools(conversationId);
    const profile = resolveRuntimeProfile(this.config, name);
    await this.sendInteractiveCard(
      msg,
      buildAckCard({
        state: 'done',
        title: '✅ 引擎已切换',
        body: `已切换到 \`${name}\`（${profile.kind} / \`${profile.bin}\`）。\n${handoffNote}`,
      }),
    );
  }

  private async handleModelCmd(
    msg: IncomingMessage,
    cmd: Extract<ParsedCommand, { kind: 'model' }>,
    _cwd: string, // 当前未使用；保留参数签名一致性，后续可能用于 per-chat 模型覆盖
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    if (this.isTextChannel(conversationId)) {
      await this.handleModelCmdCli(msg, cmd);
      return;
    }
    if (cmd.mode === 'show') {
      // 先发占位，再异步取列表 + patch
      await this.sendInteractiveCardAsync(
        msg,
        buildLoadingCard('查询可用模型…', '🎛️ 加载模型列表'),
        async () => {
          const list = await listModels(this.config.kiro.binPath);
          if (!list) {
            return buildAckCard({
              state: 'error',
              body: '无法获取模型列表，可能是 kiro-cli 没登录或不在 PATH。\n用 `/doctor` 让 Kiro 自己看日志。',
            });
          }
          const current = this.config.kiro.model ?? list.defaultModel ?? 'auto';
          return buildModelPickerCard({ current, list });
        },
      );
      return;
    }

    if (cmd.mode === 'reset') {
      this.config = patchAndSaveConfig(this.config, (draft) => {
        delete draft.kiro.model;
      });
      clearModelCache();
      const list = await listModels(this.config.kiro.binPath);
      const fallback = list?.defaultModel ?? 'auto';
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'done',
          title: '✅ 模型已恢复默认',
          body: `已清除模型覆盖，回归 kiro-cli 默认（\`${fallback}\`）`,
        }),
      );
      return;
    }

    // mode === 'set'
    await this.sendInteractiveCardAsync(
      msg,
      buildLoadingCard(`切换到 \`${cmd.name}\` …`, '🎛️ 切换模型'),
      async () => {
        const list = await listModels(this.config.kiro.binPath);
        const target = this.resolveModelName(cmd.name, list);
        if (list && target === undefined) {
          const valid = list.models.map((m) => `\`${m.name}\``).join('、');
          return buildAckCard({
            state: 'error',
            title: '❌ 模型不存在',
            body: `没有名为 \`${cmd.name}\` 的模型。\n\n可用：${valid}\n\n用 \`/model\` 查看完整列表。`,
          });
        }
        const finalName = target ?? cmd.name;
        this.config = patchAndSaveConfig(this.config, (draft) => {
          draft.kiro.model = finalName;
        });
        return buildAckCard({
          state: 'done',
          title: '✅ 模型已切换',
          body: `已切换到 \`${finalName}\`（下一条消息生效）`,
        });
      },
    );
  }

  /** CLI 纯文本 /model：展示当前 runtime+model，kiro 可列模型并切换。 */
  private async handleModelCmdCli(
    msg: IncomingMessage,
    cmd: Extract<ParsedCommand, { kind: 'model' }>,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    const { profileName, profile } = await this.resolveChatRuntime(conversationId);
    const profiles = listRuntimeProfileNames(this.config).join(' | ');

    if (cmd.mode === 'show') {
      const lines = [
        `current: ${profileName} (${profile.kind})`,
        `model: ${profile.model ?? this.config.kiro.model ?? '-'}`,
        `runtimes: ${profiles}`,
        '',
        'switch engine: /runtime <name>',
        'diagnose: /runtime check',
      ];
      if (profile.kind === 'kiro-cli-acp') {
        const list = await listModels(profile.bin || this.config.kiro.binPath);
        if (list?.models.length) {
          lines.push('', 'kiro models:');
          for (const m of list.models.slice(0, 20)) {
            const mark = m.name === (this.config.kiro.model ?? list.defaultModel) ? ' *' : '';
            lines.push(`  ${m.name}${mark}`);
          }
          if (list.models.length > 20) lines.push(`  … +${list.models.length - 20} more`);
          lines.push('', 'set: /model <name>   reset: /model auto');
        }
      } else if (profile.kind === 'openai-compatible') {
        const registry = await discoverRuntimeRegistry(this.config);
        const entry = registry.find((e) => e.profileName === profileName);
        if (entry?.models.length) {
          lines.push('', `gateway models (${entry.models.length}):`);
          lines.push(formatModelTierSummary(entry.models, 15));
          lines.push('', 'switch profile: /runtime openai-fast|openai-strong');
        } else {
          lines.push(
            '',
            `openai models: ${entry?.detail ?? 'unavailable'}`,
            'switch profile: /runtime openai-fast|openai-strong',
            `or: ${cliCommand('models')}`,
          );
        }
      }
      await this.respondText(msg, lines.join('\n'));
      return;
    }

    if (profile.kind !== 'kiro-cli-acp') {
      await this.respondText(
        msg,
        `current engine ${profileName} does not support /model switch.\nUse /runtime <profile> instead.`,
      );
      return;
    }

    if (cmd.mode === 'reset') {
      this.config = patchAndSaveConfig(this.config, (draft) => {
        delete draft.kiro.model;
      });
      clearModelCache();
      await this.respondText(msg, 'ok — model reset to kiro default (auto)');
      return;
    }

    const list = await listModels(profile.bin || this.config.kiro.binPath);
    const target = this.resolveModelName(cmd.name, list);
    if (list && target === undefined) {
      await this.respondText(msg, `unknown model: ${cmd.name}\nUse /model to list.`);
      return;
    }
    const finalName = target ?? cmd.name;
    this.config = patchAndSaveConfig(this.config, (draft) => {
      draft.kiro.model = finalName;
    });
    await this.respondText(msg, `ok — model set to ${finalName}`);
  }

  /**
   * 模型名解析：
   *   - 列表里精确匹配 → 直接返回
   *   - 列表里有 "claude-<name>" → 返回带前缀的全名（短名容错）
   *   - 都不匹配 → 返回 undefined（让上层报错）
   * 列表为空（fetch 失败）时直接返回原名，不阻塞。
   */
  private resolveModelName(
    name: string,
    list: Awaited<ReturnType<typeof listModels>>,
  ): string | undefined {
    if (!list) return name;
    if (list.models.some((m) => m.name === name)) return name;
    const prefixed = `claude-${name}`;
    if (list.models.some((m) => m.name === prefixed)) return prefixed;
    return undefined;
  }

  /**
   * 发送一张飞书 v2 交互卡片（带按钮的那种）作为对原消息的回复。
   * CLI 通道改为纯文本，避免终端无法点击的卡片 UI。
   */
  private isTextChannel(conversationId?: string): boolean {
    if (this.ingress.channel === 'cli') return true;
    if (conversationId?.startsWith('cli-')) return true;
    return false;
  }

  private async respondText(msg: IncomingMessage, text: string): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    try {
      await this.ingress.sendText(conversationId, text);
    } catch (e) {
      this.log.error({ err: e }, 'respondText failed');
    }
  }

  private async sendInteractiveCard(msg: IncomingMessage, card: object): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    if (this.isTextChannel(conversationId)) {
      await this.respondText(msg, cardToPlainText(card));
      return;
    }
    try {
      await this.ingress.replyCard(msg.messageId, card);
    } catch (e) {
      this.log.error({ err: e }, 'sendInteractiveCard failed; falling back to text');
      try {
        await this.ingress.sendText(conversationId, '❌ 卡片发送失败，请检查日志');
      } catch {
        // ignore
      }
    }
  }

  /**
   * 命令型卡片的"先占位再 patch"模式。
   *
   * 用于命令本身需要做异步工作（spawn kiro-cli 等）才能算出最终卡片内容的场景：
   *   1. 先用 placeholderCard 立刻 reply 出去，让用户看到反馈
   *   2. 异步跑 buildFinalCard()
   *   3. 用 patchCard 替换成最终卡片
   *
   * 失败时直接发 fallback 错误卡片，不让用户卡在 placeholder。
   */
  private async sendInteractiveCardAsync(
    msg: IncomingMessage,
    placeholderCard: object,
    buildFinalCard: () => Promise<object>,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    if (this.isTextChannel(conversationId)) {
      try {
        const finalCard = await buildFinalCard();
        await this.respondText(msg, cardToPlainText(finalCard));
      } catch (e) {
        await this.respondText(msg, `❌ ${(e as Error).message}`);
      }
      return;
    }
    let placeholderMessageId: string | undefined;
    try {
      placeholderMessageId = await this.ingress.replyCard(msg.messageId, placeholderCard);
    } catch (e) {
      this.log.error({ err: e }, 'placeholder card send failed');
      // placeholder 都发不出去，直接尝试拿最终结果再发一次
    }

    let finalCard: object;
    try {
      finalCard = await buildFinalCard();
    } catch (e) {
      this.log.error({ err: e }, 'buildFinalCard threw');
      finalCard = buildAckCard({
        state: 'error',
        body: `❌ 命令执行失败：${(e as Error).message}`,
      });
    }

    if (placeholderMessageId) {
      try {
        await this.ingress.patchCard(placeholderMessageId, finalCard);
      } catch (e) {
        this.log.error({ err: e }, 'patch final card failed; sending fresh');
        await this.sendInteractiveCard(msg, finalCard);
      }
    } else {
      // placeholder 没发出去，直接发最终卡片
      await this.sendInteractiveCard(msg, finalCard);
    }
  }

  /**
   * 直接发卡片到 chatId（不 reply 任何特定消息）。
   * cardAction handler 用这个——按钮触发时不 reply 那条卡片本身（嵌套体验差），
   * 而是发新消息。
   */
  private async sendCardToConversation(conversationId: string, card: object): Promise<void> {
    try {
      if (this.isTextChannel(conversationId)) {
        await this.ingress.sendText(conversationId, cardToPlainText(card));
        return;
      }
      await this.ingress.sendCard(conversationId, card);
    } catch (e) {
      this.log.error({ err: e }, 'sendCardToConversation failed; falling back to text');
      try {
        await this.ingress.sendText(conversationId, '❌ 卡片发送失败，请检查日志');
      } catch {
        // ignore
      }
    }
  }

  async handleNormalizedCardAction(evt: NormalizedCardAction): Promise<void> {
    return this.handleCardAction(toCardActionEvent(evt));
  }

  /**
   * 处理用户点了卡片按钮的事件。
   * value 约定字段：{ action: 'xxx.yyy', ...payload }
   *
   * 安全：button 触发的命令也会经过 admin 校验（调用 needAdminForAction）。
   */
  async handleCardAction(evt: CardActionEvent): Promise<void> {
    const conversationId = this.conversationIdOfAction(evt);
    const senderPrincipalId = this.senderPrincipalIdOfAction(evt);
    // 访问控制：cardAction 没有 chatType 字段（飞书 SDK 不给），所以**只校验 senderOpenId**。
    // 这是合理的：卡片是 bridge 自己发出去的，飞书已经做了"消息可见性"的访问控制；
    // 我们再用 allowedChats 校验会误伤私聊（chatId 不在群白名单里 → 私聊按钮永远点不动）。
    // 安全性：senderOpenId 校验已经能挡住租户外用户；admin 写操作另有 isAdmin 校验。
    const { allowedUsers } = this.config.access;
    if (allowedUsers.length > 0 && !allowedUsers.includes(senderPrincipalId)) {
      this.log.warn(
        { user: senderPrincipalId, chat: conversationId },
        'card action dropped by access control (sender not in allowedUsers)',
      );
      return;
    }
    const action = String(evt.value['action'] ?? '');
    if (!action) {
      this.log.debug({ value: evt.value }, 'card action without "action" field, ignored');
      return;
    }

    // admin 校验：写操作要管理员
    if (this.actionNeedsAdmin(action) && !isAdmin(senderPrincipalId, this.config)) {
      await this.sendCardToConversation(
        conversationId,
        buildAckCard({ state: 'error', body: '此操作仅管理员可用' }),
      );
      return;
    }

    const session = await this.sessions.getConversation(
      conversationId,
      this.config.workspace.defaultCwd,
    );

    switch (action) {
      case 'model.show': {
        const list = await listModels(this.config.kiro.binPath);
        const current = this.config.kiro.model ?? list?.defaultModel ?? 'auto';
        if (!list) {
          await this.sendCardToConversation(
            conversationId,
            buildAckCard({ state: 'error', body: '无法获取模型列表' }),
          );
          return;
        }
        await this.sendCardToConversation(conversationId, buildModelPickerCard({ current, list }));
        return;
      }
      case 'model.refresh': {
        clearModelCache();
        const list = await listModels(this.config.kiro.binPath);
        const current = this.config.kiro.model ?? list?.defaultModel ?? 'auto';
        if (!list) {
          await this.sendCardToConversation(
            conversationId,
            buildAckCard({ state: 'error', body: '刷新失败' }),
          );
          return;
        }
        await this.sendCardToConversation(conversationId, buildModelPickerCard({ current, list }));
        return;
      }
      case 'model.set': {
        const name = String(evt.value['name'] ?? '').trim();
        if (!name) return;
        const list = await listModels(this.config.kiro.binPath);
        const target = this.resolveModelName(name, list);
        if (list && target === undefined) {
          await this.sendCardToConversation(
            conversationId,
            buildAckCard({ state: 'error', body: `没有名为 \`${name}\` 的模型` }),
          );
          return;
        }
        const finalName = target ?? name;
        this.config = patchAndSaveConfig(this.config, (draft) => {
          draft.kiro.model = finalName;
        });
        await this.sendCardToConversation(
          conversationId,
          buildAckCard({
            state: 'done',
            body: `已切换模型：\`${finalName}\`（下一条消息生效）`,
          }),
        );
        return;
      }
      case 'model.reset': {
        this.config = patchAndSaveConfig(this.config, (draft) => {
          delete draft.kiro.model;
        });
        clearModelCache();
        const list = await listModels(this.config.kiro.binPath);
        const fallback = list?.defaultModel ?? 'auto';
        await this.sendCardToConversation(
          conversationId,
          buildAckCard({
            state: 'done',
            body: `已清除模型覆盖，回归 \`${fallback}\``,
          }),
        );
        return;
      }
      case 'session.new': {
        await this.sessions.clearConversationKiroSession(conversationId, session.currentCwd);
        await this.sendCardToConversation(
          conversationId,
          buildAckCard({
            state: 'done',
            body: `已重置 \`${session.currentCwd}\` 下的会话`,
          }),
        );
        return;
      }
      case 'session.stop': {
        const ok = this.getPipeline(conversationId).abortCurrent();
        await this.sendCardToConversation(
          conversationId,
          buildAckCard({
            state: ok ? 'aborted' : 'done',
            body: ok ? '已发出中止信号' : '当前没有进行中的任务',
          }),
        );
        return;
      }
      case 'session.continue': {
        // 用户在超时卡片上点了"继续未完成的部分"
        // 用同一 chat 的 sessionId 续接，给 kiro-cli 一条简短的"继续"指令
        // sessionId 在 storage 里，这里走 fireContinue 触发 executeKiroTask
        await this.fireContinue(conversationId);
        return;
      }
      case 'session.status': {
        const kiroSid = await this.sessions.getKiroSession(conversationId, session.currentCwd);
        const wsName = await this.workspaceNameOf(session.currentCwd);
        const idleMin = this.effectiveIdleMinutes(session.idleTimeoutMinutes);
        const cardOpts: Parameters<typeof buildStatusCard>[0] = {
          cwd: session.currentCwd,
          hasActiveTask: this.getPipeline(conversationId).hasActiveTask(),
          idleMinutes: idleMin,
          isPerChatOverride: session.idleTimeoutMinutes !== undefined,
        };
        if (wsName !== undefined) cardOpts.workspaceName = wsName;
        if (kiroSid !== undefined) cardOpts.kiroSessionId = kiroSid;
        await this.sendCardToConversation(conversationId, buildStatusCard(cardOpts));
        return;
      }
      case 'ws.list': {
        const all = await this.workspaces.list();
        await this.sendCardToConversation(
          conversationId,
          buildWorkspaceListCard({
            workspaces: all,
            currentCwd: session.currentCwd,
          }),
        );
        return;
      }
      case 'ws.use': {
        const name = String(evt.value['name'] ?? '').trim();
        if (!name) return;
        const target = await this.workspaces.get(name);
        if (!target) {
          await this.sendCardToConversation(
            conversationId,
            buildAckCard({ state: 'error', body: `没有名为 \`${name}\` 的工作区` }),
          );
          return;
        }
        try {
          const abs = validateCwd(target, this.config, session.currentCwd);
          await this.sessions.setConversationCwd(
            conversationId,
            abs,
            this.config.workspace.defaultCwd,
          );
          await this.sendCardToConversation(
            conversationId,
            buildAckCard({
              state: 'done',
              body: `已切换到工作区 \`${name}\` → \`${abs}\``,
            }),
          );
        } catch (e) {
          const m = e instanceof SecurityError ? e.message : String((e as Error).message);
          await this.sendCardToConversation(
            conversationId,
            buildAckCard({ state: 'error', body: m }),
          );
        }
        return;
      }
      case 'config.show':
      case 'config.edit': {
        const isEditMode = action === 'config.edit';
        const card = isEditMode
          ? buildConfigFormCard({
              allowedUsers: this.config.access.allowedUsers,
              allowedChats: this.config.access.allowedChats,
              admins: this.config.access.admins,
              requireMentionInGroup: this.config.preferences.requireMentionInGroup,
              idleTimeoutMinutes: this.config.kiro.idleTimeoutMinutes,
            })
          : buildConfigViewCard({
              allowedUsers: this.config.access.allowedUsers,
              allowedChats: this.config.access.allowedChats,
              admins: this.config.access.admins,
              requireMentionInGroup: this.config.preferences.requireMentionInGroup,
              idleTimeoutMinutes: this.config.kiro.idleTimeoutMinutes,
              cardUpdateIntervalMs: this.config.preferences.cardUpdateIntervalMs,
              isAdmin: isAdmin(senderPrincipalId, this.config),
            });
        await this.sendCardToConversation(conversationId, card);
        return;
      }
      case 'config.submit': {
        await this.handleConfigSubmit(evt);
        return;
      }
      case 'process.stop': {
        const target = String(evt.value['target'] ?? '').trim();
        if (!target) return;
        const proc = await findProcess(target);
        if (!proc) {
          await this.sendCardToConversation(
            conversationId,
            buildAckCard({ state: 'error', body: `没找到进程 \`${target}\`` }),
          );
          return;
        }
        try {
          process.kill(proc.pid, 'SIGTERM');
          await this.sendCardToConversation(
            conversationId,
            buildAckCard({
              state: 'done',
              body:
                proc.pid === process.pid
                  ? `当前进程（pid \`${proc.pid}\`）即将退出。daemon 会自动重启；前台 run 模式需手动再起。`
                  : `已向 pid \`${proc.pid}\` 发 SIGTERM`,
            }),
          );
        } catch (e) {
          await this.sendCardToConversation(
            conversationId,
            buildAckCard({
              state: 'error',
              body: `无法停止 pid \`${proc.pid}\`：${(e as Error).message}`,
            }),
          );
        }
        return;
      }
      case 'steering.list': {
        const scope = (evt.value['scope'] === 'global' ? 'global' : 'project') as
          | 'global'
          | 'project';
        await this.sendCardToConversation(
          conversationId,
          this.buildSteeringListCard(scope, session.currentCwd, senderPrincipalId),
        );
        return;
      }
      case 'steering.view': {
        const scope = (evt.value['scope'] === 'global' ? 'global' : 'project') as
          | 'global'
          | 'project';
        const name = String(evt.value['name'] ?? '');
        try {
          const content = this.memory.get(scope, session.currentCwd, name);
          await this.sendCardToConversation(
            conversationId,
            buildMemoryViewCard({
              scope,
              name,
              content,
              isAdmin: isAdmin(senderPrincipalId, this.config),
            }),
          );
        } catch (e) {
          const m = e instanceof MemoryError ? e.message : (e as Error).message;
          await this.sendCardToConversation(
            conversationId,
            buildAckCard({ state: 'error', body: m }),
          );
        }
        return;
      }
      case 'steering.edit': {
        const scope = (evt.value['scope'] === 'global' ? 'global' : 'project') as
          | 'global'
          | 'project';
        const name = String(evt.value['name'] ?? '');
        try {
          const content = this.memory.get(scope, session.currentCwd, name);
          if (content.length > 5000) {
            await this.sendCardToConversation(
              conversationId,
              buildAckCard({
                state: 'error',
                title: '⚠️ 文件过大',
                body: `\`${name}\` 超过 5000 字符，飞书表单不支持。请用本地编辑器打开：\n\`${scope === 'global' ? '~/.kiro/steering/' : '.kiro/steering/'}${name}\``,
              }),
            );
            return;
          }
          await this.sendCardToConversation(
            conversationId,
            buildMemoryEditFormCard({ scope, name, content, isNew: false }),
          );
        } catch (e) {
          const m = e instanceof MemoryError ? e.message : (e as Error).message;
          await this.sendCardToConversation(
            conversationId,
            buildAckCard({ state: 'error', body: m }),
          );
        }
        return;
      }
      case 'steering.newPrompt': {
        const scope = (evt.value['scope'] === 'global' ? 'global' : 'project') as
          | 'global'
          | 'project';
        await this.sendCardToConversation(conversationId, buildMemoryNewFormCard({ scope }));
        return;
      }
      case 'steering.rm': {
        const scope = (evt.value['scope'] === 'global' ? 'global' : 'project') as
          | 'global'
          | 'project';
        const name = String(evt.value['name'] ?? '');
        try {
          const ok = this.memory.delete(scope, session.currentCwd, name);
          await this.sendCardToConversation(
            conversationId,
            buildAckCard({
              state: ok ? 'done' : 'error',
              body: ok ? `已删除 \`${name}\`` : `\`${name}\` 不存在`,
            }),
          );
          // 删完顺便刷新列表
          if (ok) {
            await this.sendCardToConversation(
              conversationId,
              this.buildSteeringListCard(scope, session.currentCwd, senderPrincipalId),
            );
          }
        } catch (e) {
          const m = e instanceof MemoryError ? e.message : (e as Error).message;
          await this.sendCardToConversation(
            conversationId,
            buildAckCard({ state: 'error', body: m }),
          );
        }
        return;
      }
      case 'steering.submit': {
        await this.handleSteeringSubmit(evt, session.currentCwd);
        return;
      }
      case 'cron.list': {
        await this.sendCardToConversation(
          conversationId,
          await this.buildCronListCardForConversation(conversationId, senderPrincipalId),
        );
        return;
      }
      case 'cron.run': {
        await this.handleCronAction(evt, 'run');
        return;
      }
      case 'cron.pause': {
        await this.handleCronAction(evt, 'pause');
        return;
      }
      case 'cron.resume': {
        await this.handleCronAction(evt, 'resume');
        return;
      }
      case 'cron.rm': {
        await this.handleCronAction(evt, 'rm');
        return;
      }
      case 'cron.translateConfirm': {
        const raw = String(evt.value['raw'] ?? '');
        const prompt = String(evt.value['prompt'] ?? '');
        await this.handleCronTranslate(evt, raw, prompt);
        return;
      }
      case 'cron.createConfirmed': {
        const expression = String(evt.value['expression'] ?? '');
        const description = String(evt.value['description'] ?? '');
        const prompt = String(evt.value['prompt'] ?? '');
        await this.handleCronCreate(evt, session.currentCwd, expression, description, prompt);
        return;
      }
      case 'schedule.submit': {
        await this.handleScheduleSubmit(evt, session.currentCwd);
        return;
      }
      case 'schedule.cancel': {
        await this.handleScheduleCancel(evt);
        return;
      }
      case 'conduit.confirmMerge': {
        const cwd = String(evt.value['cwd'] ?? session.currentCwd);
        // 替换确认卡片为"运行中"，然后走 pipeline 异步跑
        const runningCard = buildLoadingCard(
          `编排 + 合并运行中：\`${cwd}\` …\n分钟级任务，完成后自动合并到 base branch`,
          '🚦 conduit run --merge',
        );
        try {
          await this.ingress.patchCard(evt.messageId, runningCard);
        } catch {
          await this.sendCardToConversation(conversationId, runningCard);
        }
        const pipeline = this.getPipeline(conversationId);
        await pipeline.submit({
          id: `conduit-merge-${Date.now()}`,
          run: async (signal) => {
            const r = await this.runConduitStreaming(
              ['run', '--workspace', cwd, '--merge'],
              cwd,
              signal,
              evt.messageId,
              '🚦 conduit run --merge',
            );
            const card = this.conduitRunCard(r, true, cwd);
            try {
              await this.ingress.patchCard(evt.messageId, card);
            } catch {
              await this.sendCardToConversation(conversationId, card);
            }
          },
        });
        return;
      }
      case 'conduit.cancel': {
        const card = buildAckCard({ state: 'aborted', title: '已取消', body: '不执行合并。' });
        try {
          await this.ingress.patchCard(evt.messageId, card);
        } catch {
          await this.sendCardToConversation(conversationId, card);
        }
        return;
      }
      default:
        // 用 warn 级别（默认日志可见），方便排查"按钮点了没反应"这类问题
        this.log.warn(
          { action, valueKeys: Object.keys(evt.value) },
          'unknown card action, ignored',
        );
    }
  }

  /** 哪些 action 是写操作，需要 admin */
  private actionNeedsAdmin(action: string): boolean {
    return (
      action === 'model.set' ||
      action === 'model.reset' ||
      action === 'ws.use' ||
      action === 'session.new' ||
      action === 'config.edit' ||
      action === 'config.submit' ||
      action === 'process.stop' ||
      action === 'steering.edit' ||
      action === 'steering.rm' ||
      action === 'steering.newPrompt' ||
      action === 'steering.submit' ||
      action === 'cron.run' ||
      action === 'cron.pause' ||
      action === 'cron.resume' ||
      action === 'cron.rm' ||
      action === 'cron.translateConfirm' ||
      action === 'cron.createConfirmed' ||
      action === 'schedule.submit' ||
      action === 'conduit.confirmMerge'
    );
  }

  /**
   * /config 命令：展示当前配置（只读卡片，admin 可见编辑按钮）
   */
  private async handleConfigCmd(msg: IncomingMessage): Promise<void> {
    const card = buildConfigViewCard({
      allowedUsers: this.config.access.allowedUsers,
      allowedChats: this.config.access.allowedChats,
      admins: this.config.access.admins,
      requireMentionInGroup: this.config.preferences.requireMentionInGroup,
      idleTimeoutMinutes: this.config.kiro.idleTimeoutMinutes,
      cardUpdateIntervalMs: this.config.preferences.cardUpdateIntervalMs,
      isAdmin: isAdmin(msg.senderOpenId, this.config),
    });
    await this.sendInteractiveCard(msg, card);
  }

  /**
   * 处理 config 表单提交。
   *
   * 流程：
   *   1. 解析 form_value（用户输入的逗号分隔列表 / 整数 / yes/no）
   *   2. 用 validateAccessChange 校验，防止把自己锁出去
   *   3. patchAndSaveConfig 落盘 + 立即生效
   *   4. 回一张确认卡片（同时显示新的 config view）
   */
  private async handleConfigSubmit(evt: CardActionEvent): Promise<void> {
    const conversationId = this.conversationIdOfAction(evt);
    const senderPrincipalId = this.senderPrincipalIdOfAction(evt);
    const fv = evt.formValue ?? {};
    const parseCsv = (raw: unknown): string[] =>
      String(raw ?? '')
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    const allowedUsers = parseCsv(fv['allowedUsers']);
    const allowedChats = parseCsv(fv['allowedChats']);
    const admins = parseCsv(fv['admins']);
    const requireMentionInGroup = String(fv['requireMentionInGroup'] ?? 'yes') === 'yes';
    const idleRaw = String(fv['idleTimeoutMinutes'] ?? '5').trim();
    const idleMin = Number(idleRaw);
    if (!Number.isFinite(idleMin) || idleMin < 0 || idleMin > 600) {
      await this.sendCardToConversation(
        conversationId,
        buildAckCard({
          state: 'error',
          body: `❌ Idle watchdog 必须是 0~600 之间的整数，收到 \`${idleRaw}\``,
        }),
      );
      return;
    }

    // 防自锁校验
    const accessErrors = validateAccessChange({
      submitterOpenId: senderPrincipalId,
      next: { allowedUsers, allowedChats, admins },
    });
    if (accessErrors.length > 0) {
      await this.sendCardToConversation(
        conversationId,
        buildAckCard({
          state: 'error',
          title: '⚠️ 配置不安全',
          body: accessErrors.join('\n\n'),
        }),
      );
      return;
    }

    // 落盘
    this.config = patchAndSaveConfig(this.config, (draft) => {
      draft.access.allowedUsers = allowedUsers;
      draft.access.allowedChats = allowedChats;
      draft.access.admins = admins;
      draft.preferences.requireMentionInGroup = requireMentionInGroup;
      draft.kiro.idleTimeoutMinutes = Math.floor(idleMin);
    });
    this.log.info(
      {
        allowedUsersN: allowedUsers.length,
        allowedChatsN: allowedChats.length,
        adminsN: admins.length,
        requireMentionInGroup,
        idleMin: Math.floor(idleMin),
        by: senderPrincipalId,
      },
      'config updated via card form',
    );

    // 回执 + 新的 view 卡片
    await this.sendCardToConversation(
      conversationId,
      buildAckCard({
        state: 'done',
        title: '✅ 配置已保存',
        body: '改动立即生效，无需重启。',
      }),
    );
    await this.sendCardToConversation(
      conversationId,
      buildConfigViewCard({
        allowedUsers: this.config.access.allowedUsers,
        allowedChats: this.config.access.allowedChats,
        admins: this.config.access.admins,
        requireMentionInGroup: this.config.preferences.requireMentionInGroup,
        idleTimeoutMinutes: this.config.kiro.idleTimeoutMinutes,
        cardUpdateIntervalMs: this.config.preferences.cardUpdateIntervalMs,
        isAdmin: isAdmin(senderPrincipalId, this.config),
      }),
    );
  }

  /**
   * /ps 命令：列出本机所有 bridge 进程，标记当前回复的进程。
   */
  private async handlePsCmd(msg: IncomingMessage): Promise<void> {
    const list = await listProcesses();
    await this.sendInteractiveCard(msg, buildPsCard({ processes: list, selfPid: process.pid }));
  }

  /**
   * /exit <id|#> 命令：SIGTERM 指定进程。
   *
   * 安全策略：
   *   - 自己 → 优雅停止（让 daemon 守护重启；如果是前台 run 则直接退）
   *   - 他人 → SIGTERM
   *   - 找不到目标 → 报错
   */
  private async handleExitCmd(msg: IncomingMessage, target: string): Promise<void> {
    const proc = await findProcess(target);
    if (!proc) {
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'error',
          title: '❌ 没找到进程',
          body: `没有匹配 \`${target}\` 的进程。\n用 \`/ps\` 查看当前列表。`,
        }),
      );
      return;
    }
    const isSelf = proc.pid === process.pid;
    try {
      process.kill(proc.pid, 'SIGTERM');
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'done',
          title: isSelf ? '⏹ 当前进程退出中' : '⏹ 已发出停止信号',
          body: isSelf
            ? `pid \`${proc.pid}\` 即将退出。${'daemon 守护下会自动重启；如果是前台 `run` 则需要你手动再起。'}`
            : `已向 pid \`${proc.pid}\`（\`${proc.shortId}\`）发 SIGTERM。`,
        }),
      );
    } catch (e) {
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'error',
          title: '❌ 信号失败',
          body: `无法向 pid \`${proc.pid}\` 发信号：${(e as Error).message}`,
        }),
      );
    }
  }

  /**
   * /steering（memory）命令统一入口。
   *
   * 子命令：
   *   - list / 无参数      → 列出当前 scope 的 steering 文件
   *   - view <name>        → 看具体内容
   *   - edit <name>        → 弹表单编辑（admin）
   *   - new <name>         → 新建（带初始名）（admin）
   *   - rm <name>          → 删除（admin）
   *
   * scope 通过 cmd.scope（global / project，默认 project）控制。
   */
  private async handleMemoryCmd(
    msg: IncomingMessage,
    cmd: Extract<ParsedCommand, { kind: 'memory' }>,
    cwd: string,
  ): Promise<void> {
    if (cmd.mode === 'list') {
      await this.sendInteractiveCard(
        msg,
        this.buildSteeringListCard(cmd.scope, cwd, msg.senderOpenId),
      );
      return;
    }
    const normName = normalizeFilename(cmd.name);
    if (cmd.mode === 'view') {
      const validErrors = validateFilename(normName);
      if (validErrors.length > 0) {
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: 'error',
            title: '❌ 文件名非法',
            body: validErrors.join('\n'),
          }),
        );
        return;
      }
      try {
        const content = this.memory.get(cmd.scope, cwd, normName);
        await this.sendInteractiveCard(
          msg,
          buildMemoryViewCard({
            scope: cmd.scope,
            name: normName,
            content,
            isAdmin: isAdmin(msg.senderOpenId, this.config),
          }),
        );
      } catch (e) {
        const m = e instanceof MemoryError ? e.message : (e as Error).message;
        await this.sendInteractiveCard(msg, buildAckCard({ state: 'error', body: m }));
      }
      return;
    }
    if (cmd.mode === 'edit') {
      const validErrors = validateFilename(normName);
      if (validErrors.length > 0) {
        await this.sendInteractiveCard(
          msg,
          buildAckCard({ state: 'error', body: validErrors.join('\n') }),
        );
        return;
      }
      try {
        const content = this.memory.get(cmd.scope, cwd, normName);
        if (content.length > 5000) {
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'error',
              title: '⚠️ 文件过大',
              body: `\`${normName}\` 超过 5000 字符，飞书表单不支持。请用本地编辑器编辑。`,
            }),
          );
          return;
        }
        await this.sendInteractiveCard(
          msg,
          buildMemoryEditFormCard({ scope: cmd.scope, name: normName, content, isNew: false }),
        );
      } catch (e) {
        const m = e instanceof MemoryError ? e.message : (e as Error).message;
        await this.sendInteractiveCard(msg, buildAckCard({ state: 'error', body: m }));
      }
      return;
    }
    if (cmd.mode === 'new') {
      const validErrors = validateFilename(normName);
      if (validErrors.length > 0) {
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: 'error',
            title: '❌ 文件名非法',
            body: validErrors.join('\n'),
          }),
        );
        return;
      }
      // 新建场景：name 已知，弹空白编辑表单
      await this.sendInteractiveCard(
        msg,
        buildMemoryEditFormCard({ scope: cmd.scope, name: normName, content: '', isNew: true }),
      );
      return;
    }
    if (cmd.mode === 'rm') {
      const validErrors = validateFilename(normName);
      if (validErrors.length > 0) {
        await this.sendInteractiveCard(
          msg,
          buildAckCard({ state: 'error', body: validErrors.join('\n') }),
        );
        return;
      }
      try {
        const ok = this.memory.delete(cmd.scope, cwd, normName);
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: ok ? 'done' : 'error',
            body: ok ? `已删除 \`${normName}\`` : `\`${normName}\` 不存在`,
          }),
        );
      } catch (e) {
        const m = e instanceof MemoryError ? e.message : (e as Error).message;
        await this.sendInteractiveCard(msg, buildAckCard({ state: 'error', body: m }));
      }
      return;
    }
  }

  /**
   * 构造 steering 列表卡片（带 inclusion frontmatter 解析）。
   * 抽出来给命令入口和按钮回调共用。
   */
  private buildSteeringListCard(
    scope: 'global' | 'project',
    cwd: string,
    senderOpenId: string,
  ): object {
    const files = this.memory.list(scope, cwd);
    const enriched = files.map((f) => {
      let inclusion = 'always';
      try {
        const c = this.memory.get(scope, cwd, f.name);
        inclusion = extractInclusion(c);
      } catch {
        // ignore
      }
      return { name: f.name, inclusion, size: f.size };
    });
    return buildMemoryListCard({
      scope,
      cwd,
      files: enriched,
      isAdmin: isAdmin(senderOpenId, this.config),
    });
  }

  /**
   * 处理 steering 表单提交。
   *
   * 三种来源：
   *   1. 编辑现有文件（value.name 有值，isNew=false）→ form_value 只有 content
   *   2. /steering new <name> 命令进入的编辑（value.name 有值，isNew=true）→ form_value 只有 content
   *   3. 点「📝 新建」按钮的入口表单（value.name 无值，isNew=true）→ form_value 含 name + content
   */
  private async handleSteeringSubmit(evt: CardActionEvent, cwd: string): Promise<void> {
    const conversationId = this.conversationIdOfAction(evt);
    const senderPrincipalId = this.senderPrincipalIdOfAction(evt);
    const fv = evt.formValue ?? {};
    const scope = (evt.value['scope'] === 'global' ? 'global' : 'project') as 'global' | 'project';
    const isNew = evt.value['isNew'] === true;

    // 决定文件名：value 里有就用 value，否则从表单 name 字段取
    let name = String(evt.value['name'] ?? '').trim();
    if (!name && typeof fv['name'] === 'string') {
      name = normalizeFilename(String(fv['name']));
    }
    if (!name) {
      await this.sendCardToConversation(
        conversationId,
        buildAckCard({ state: 'error', body: '❌ 缺少文件名' }),
      );
      return;
    }
    const validErrors = validateFilename(name);
    if (validErrors.length > 0) {
      await this.sendCardToConversation(
        conversationId,
        buildAckCard({
          state: 'error',
          title: '❌ 文件名非法',
          body: validErrors.join('\n'),
        }),
      );
      return;
    }

    const content = String(fv['content'] ?? '');
    try {
      this.memory.save(scope, cwd, name, content);
      this.log.info(
        {
          scope,
          name,
          size: content.length,
          isNew,
          by: senderPrincipalId,
        },
        'steering saved',
      );
      await this.sendCardToConversation(
        conversationId,
        buildAckCard({
          state: 'done',
          title: isNew ? '✅ 已创建' : '✅ 已保存',
          body: `\`${name}\`（${scope === 'global' ? '全局' : '项目'}），下次 Kiro 启动时生效。`,
        }),
      );
      // 刷新列表卡片
      await this.sendCardToConversation(
        conversationId,
        this.buildSteeringListCard(scope, cwd, senderPrincipalId),
      );
    } catch (e) {
      const m = e instanceof MemoryError ? e.message : (e as Error).message;
      await this.sendCardToConversation(conversationId, buildAckCard({ state: 'error', body: m }));
    }
  }

  // ===== /cron 实现 =====

  /**
   * /cron 命令统一入口。
   *
   * 子命令：list / add / rm / pause / resume / run / next / translate
   *
   * 大部分子命令需要 cronStore + cronScheduler；如果 dispatcher 没注入这两个，
   * 给一张"功能未启用"提示卡（防止 /cron 命令在无 cron 配置下崩）。
   */
  private async handleCronCmd(
    msg: IncomingMessage,
    cmd: Extract<ParsedCommand, { kind: 'cron' }>,
    cwd: string,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    const senderPrincipalId = this.senderPrincipalIdOfMessage(msg);
    if (!this.cronStore || !this.cronScheduler) {
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'error',
          title: '⚠️ 定时任务未启用',
          body: '当前 bridge 实例没启用 cron 模块。请升级到最新版后重启。',
        }),
      );
      return;
    }

    switch (cmd.mode) {
      case 'list': {
        await this.sendInteractiveCard(
          msg,
          await this.buildCronListCardForConversation(conversationId, senderPrincipalId),
        );
        return;
      }
      case 'add': {
        // 解析表达式
        const parsed = parseExpression(cmd.expression);
        if (parsed.kind === 'unknown') {
          // 弹翻译确认卡片
          await this.sendInteractiveCard(
            msg,
            buildCronTranslateConfirmCard({ raw: cmd.expression, prompt: cmd.prompt }),
          );
          return;
        }
        // 直接创建
        await this.handleCronCreateInner(
          msg,
          cwd,
          parsed.expression,
          parsed.description,
          cmd.prompt,
        );
        return;
      }
      case 'translate': {
        // 用户主动用 /cron translate 触发
        await this.sendInteractiveCard(
          msg,
          buildCronTranslateConfirmCard({ raw: cmd.raw, prompt: '' }),
        );
        return;
      }
      case 'rm':
      case 'pause':
      case 'resume':
      case 'run':
      case 'next': {
        const proc = await this.cronStore.findById(cmd.id);
        if (!proc) {
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'error',
              title: '❌ 没找到任务',
              body: `没有匹配 \`${cmd.id}\` 的任务。用 \`/cron\` 查看列表。`,
            }),
          );
          return;
        }
        await this.applyCronAction(
          (card) => this.sendInteractiveCard(msg, card),
          proc.id,
          cmd.mode,
        );
        return;
      }
    }
  }

  /**
   * 构造当前 chat 的 cron 列表卡片（带下次触发时间）。
   */
  private async buildCronListCardForConversation(
    conversationId: string,
    senderPrincipalId: string,
  ): Promise<object> {
    if (!this.cronStore || !this.cronScheduler) {
      return buildAckCard({
        state: 'error',
        title: '⚠️ 定时任务未启用',
        body: 'cron 模块未注入',
      });
    }
    const tasks = await this.cronStore.list(conversationId);
    return buildCronListCard({
      tasks: tasks.map((t) => ({
        id: t.id,
        expression: t.expression,
        description: t.description,
        prompt: t.prompt,
        enabled: t.enabled,
        lastRunAt: t.lastRunAt,
        nextRunAt: this.cronScheduler!.nextRun(t.id) ?? nextRun(t.expression),
      })),
      isAdmin: isAdmin(senderPrincipalId, this.config),
    });
  }

  /** 处理列表卡片上的按钮操作（run/pause/resume/rm）。 */
  private async handleCronAction(
    evt: CardActionEvent,
    mode: 'run' | 'pause' | 'resume' | 'rm',
  ): Promise<void> {
    const conversationId = this.conversationIdOfAction(evt);
    const id = String(evt.value['id'] ?? '');
    if (!id) return;
    await this.applyCronAction(
      (card) => this.sendCardToConversation(conversationId, card),
      id,
      mode,
    );
  }

  /**
   * 应用一个 cron 操作（命令入口和按钮回调共用）。
   *
   * sendCard：怎么发回执卡片（命令是 reply，按钮是 sendToChat）
   */
  private async applyCronAction(
    sendCard: (card: object) => Promise<void>,
    id: string,
    mode: 'run' | 'pause' | 'resume' | 'rm' | 'next',
  ): Promise<void> {
    if (!this.cronStore || !this.cronScheduler) return;
    const task = await this.cronStore.findById(id);
    if (!task) {
      await sendCard(buildAckCard({ state: 'error', body: `没找到任务 \`${id}\`` }));
      return;
    }
    switch (mode) {
      case 'rm': {
        const ok = await this.cronStore.delete(task.id);
        if (ok) this.cronScheduler.unregister(task.id);
        await sendCard(
          buildAckCard({
            state: 'done',
            body: `已删除 \`${task.id.slice(0, 6)}\``,
          }),
        );
        return;
      }
      case 'pause': {
        await this.cronStore.update(task.id, (t) => {
          t.enabled = false;
        });
        this.cronScheduler.unregister(task.id);
        await sendCard(
          buildAckCard({
            state: 'done',
            body: `已暂停 \`${task.id.slice(0, 6)}\`，用 resume 恢复`,
          }),
        );
        return;
      }
      case 'resume': {
        const updated = await this.cronStore.update(task.id, (t) => {
          t.enabled = true;
        });
        if (updated) this.cronScheduler.register(updated);
        await sendCard(
          buildAckCard({
            state: 'done',
            body: `已恢复 \`${task.id.slice(0, 6)}\``,
          }),
        );
        return;
      }
      case 'run': {
        // 立即手动触发（异步），不等结果
        this.fireCronTask(task).catch((e) => {
          this.log.error({ err: e, id: task.id }, 'manual cron run failed');
        });
        await sendCard(
          buildAckCard({
            state: 'done',
            body: `已手动触发 \`${task.id.slice(0, 6)}\`，结果会以新卡片回到这里`,
          }),
        );
        return;
      }
      case 'next': {
        const nxt = this.cronScheduler.nextRun(task.id) ?? nextRun(task.expression);
        await sendCard(
          buildAckCard({
            state: 'done',
            title: '⏰ 下次触发',
            body: `\`${task.id.slice(0, 6)}\`：${formatNextRun(nxt)}`,
          }),
        );
        return;
      }
    }
  }

  /**
   * 用户在 /cron add 命令里给的表达式无法解析，点了「让 Kiro 翻译」按钮。
   *
   * 实现：spawn 一次 kiro-cli 让它输出 cron 5 段表达式。
   * Kiro 翻译完后弹出二次确认卡片。
   */
  private async handleCronTranslate(
    evt: CardActionEvent,
    raw: string,
    prompt: string,
  ): Promise<void> {
    const conversationId = this.conversationIdOfAction(evt);
    if (!this.cronStore || !this.cronScheduler) return;
    // 先发占位卡片
    await this.sendCardToConversation(
      conversationId,
      buildLoadingCard(`正在让 Kiro 把 \`${raw}\` 翻译成 cron 表达式…`, '🤔 翻译中'),
    );

    const translatePrompt = [
      '把下面这句中文/英文调度描述转成标准 cron 5 段表达式。',
      '只输出表达式本身（5 段，空格分隔），不要任何解释、引号、代码块标记。',
      '例如输入"每天9点"，输出：0 9 * * *',
      '',
      `输入：${raw}`,
    ].join('\n');

    // 直接调 runAgentTurn
    const { runAgentTurn } = await import('../runtime/runner.js');
    const { resolveRuntimeProfile } = await import('../runtime/config.js');
    const profile = resolveRuntimeProfile(this.config);
    let result: Awaited<ReturnType<typeof runAgentTurn>>;
    try {
      result = await runAgentTurn(profile, {
        prompt: translatePrompt,
        cwd: this.config.workspace.defaultCwd,
        timeoutMs: 60_000,
        idleTimeoutMs: 30_000,
        signal: new AbortController().signal,
      });
    } catch (e) {
      await this.sendCardToConversation(
        conversationId,
        buildAckCard({
          state: 'error',
          body: `翻译失败：${(e as Error).message}`,
        }),
      );
      return;
    }

    // 提取 cron 表达式（Kiro 可能多说了几句）
    const text = (result.text ?? '').trim();
    const m = text.match(/(\S+\s+\S+\s+\S+\s+\S+\s+\S+)/);
    if (!m) {
      await this.sendCardToConversation(
        conversationId,
        buildAckCard({
          state: 'error',
          title: '❌ Kiro 没给出 cron 表达式',
          body: `Kiro 输出：\n\`\`\`\n${text.slice(0, 500)}\n\`\`\``,
        }),
      );
      return;
    }
    const expression = (m[1] as string).trim();
    const parsed = parseExpression(expression);
    if (parsed.kind === 'unknown') {
      await this.sendCardToConversation(
        evt.chatId,
        buildAckCard({
          state: 'error',
          title: '❌ Kiro 给的表达式不合法',
          body: `\`${expression}\`\n\n请用 \`/cron add\` 直接输入合法 cron 表达式。`,
        }),
      );
      return;
    }
    // 弹二次确认卡
    await this.sendCardToConversation(
      conversationId,
      buildCronTranslatedConfirmCard({
        raw,
        expression: parsed.expression,
        description: parsed.description,
        nextRun: formatNextRun(nextRun(parsed.expression)),
        prompt,
      }),
    );
  }

  /** 二次确认通过后真正创建 cron 任务（来自 cron.createConfirmed action）。 */
  private async handleCronCreate(
    evt: CardActionEvent,
    cwd: string,
    expression: string,
    description: string,
    prompt: string,
  ): Promise<void> {
    const conversationId = this.conversationIdOfAction(evt);
    const senderPrincipalId = this.senderPrincipalIdOfAction(evt);
    if (!this.cronStore || !this.cronScheduler) return;
    const parsed = parseExpression(expression);
    if (parsed.kind === 'unknown') {
      await this.sendCardToConversation(
        conversationId,
        buildAckCard({ state: 'error', body: `非法表达式 \`${expression}\`` }),
      );
      return;
    }
    try {
      const task = await this.cronStore.create({
        chatId: conversationId,
        cwd,
        expression: parsed.expression,
        prompt,
        description: description || parsed.description,
        createdBy: senderPrincipalId,
      });
      this.cronScheduler.register(task);
      await this.sendCardToConversation(
        conversationId,
        buildAckCard({
          state: 'done',
          title: '✅ 定时任务已创建',
          body: `\`${task.id.slice(0, 6)}\`：${parsed.description}\n下次：\`${formatNextRun(nextRun(task.expression))}\``,
        }),
      );
    } catch (e) {
      await this.sendCardToConversation(
        conversationId,
        buildAckCard({
          state: 'error',
          body: `创建失败：${(e as Error).message}`,
        }),
      );
    }
  }

  /** 从 /cron add 命令直接创建（已通过表达式解析，不需要二次确认）。 */
  private async handleCronCreateInner(
    msg: IncomingMessage,
    cwd: string,
    expression: string,
    description: string,
    prompt: string,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    const senderPrincipalId = this.senderPrincipalIdOfMessage(msg);
    if (!this.cronStore || !this.cronScheduler) return;
    try {
      const task = await this.cronStore.create({
        chatId: conversationId,
        cwd,
        expression,
        prompt,
        description,
        createdBy: senderPrincipalId,
      });
      this.cronScheduler.register(task);
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'done',
          title: '✅ 定时任务已创建',
          body: `\`${task.id.slice(0, 6)}\`：${description}\n下次：\`${formatNextRun(nextRun(task.expression))}\`\nPrompt：${prompt.length > 100 ? prompt.slice(0, 100) + '…' : prompt}`,
        }),
      );
    } catch (e) {
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'error',
          body: `创建失败：${(e as Error).message}`,
        }),
      );
    }
  }

  // ===== /schedule new — 可视化定时任务表单 =====

  /**
   * /schedule new 入口：弹一张默认状态的表单卡片。
   * 默认值：频率=daily，时分=09:00，prompt/name 都为空。
   *
   * 跟 /cron 一样，要求 cronStore + cronScheduler 注入；否则报"未启用"。
   */
  private async handleScheduleCmd(msg: IncomingMessage): Promise<void> {
    if (!this.cronStore || !this.cronScheduler) {
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'error',
          title: '⚠️ 定时任务未启用',
          body: '当前 bridge 实例没启用 cron 模块。请升级到最新版后重启。',
        }),
      );
      return;
    }
    // 写操作 admin 守卫：表单提交才需要 admin。打开表单本身不需要——
    // 让普通用户也能看到这个 UI（实际能不能创建由 submit 的 admin 校验决定）。
    const initial: ScheduleFormState = {
      frequency: 'daily',
      hour: 9,
      minute: 0,
    };
    await this.sendInteractiveCard(msg, buildScheduleFormCard({ state: initial }));
  }

  /**
   * /conduit — 串联 lwa-conduit（多 agent 并行编排器）
   *
   *   /conduit            → 帮助
   *   /conduit run        → 在当前 cwd 跑 `lwa-conduit run --workspace <cwd>`
   *                         默认不 merge（产出分支供 review），安全
   *   /conduit plan <spec> → 把 markdown spec 拆成 dag.yaml 工作区
   *
   * 设计取舍：
   *   - conduit 是分钟级长任务，用 sendInteractiveCardAsync 占位→结果，不做流式（MVP）
   *   - run 默认不加 --merge：绝不自动改用户分支，只产出 review 分支（安全优先）
   *   - 串联靠 spawn `lwa-conduit` 子进程（同 kiro-cli/lark-cli 模式），需先装上 PATH
   */
  private async handleConduitCmd(
    msg: IncomingMessage,
    cmd: Extract<ParsedCommand, { kind: 'conduit' }>,
    cwd: string,
  ): Promise<void> {
    if (cmd.mode === 'help') {
      const body = [
        '**lwa-conduit** — 多 agent 并行编排器（把大 spec 拆成 DAG 并行跑）。',
        '',
        '`/conduit run` — 在当前目录跑编排（需要目录下有 `dag.yaml`）',
        '　默认**不合并**，只产出分支供 review；不会动你的工作区',
        '`/conduit plan <spec.md>` — 让 Kiro 把一份 markdown spec 拆成 `dag.yaml`',
        '`/conduit status` — 查看上次 run-state 摘要（不启动进程）',
        '',
        `当前目录：\`${cwd}\``,
        '',
        "<font color='grey'>前提：本机已 `uv tool install` / `pipx install` lwa-conduit</font>",
      ].join('\n');
      await this.sendInteractiveCard(
        msg,
        buildAckCard({ state: 'done', title: '🚦 /conduit 帮助', body }),
      );
      return;
    }

    if (cmd.mode === 'status') {
      const summary = summarizeRunState(cwd);
      if (!summary) {
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: 'done',
            title: '📊 conduit status',
            body: [
              `当前目录：\`${cwd}\``,
              '',
              '未找到 `.lwa-conduit/run-state.json`（或旧 `.kiro-conduit/`）。',
              '先 `/conduit run` 或确认 cwd 正确。',
            ].join('\n'),
          }),
        );
        return;
      }
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'done',
          title: '📊 conduit status',
          body: formatRunSummary(summary),
        }),
      );
      return;
    }

    if (cmd.mode === 'run-merge') {
      // 二次确认卡片：合并是不可逆的（改了 base branch），必须确认
      await this.sendInteractiveCard(msg, buildConduitMergeConfirmCard({ cwd }));
      return;
    }

    if (cmd.mode === 'plan') {
      const outDir = `${cwd}/.conduit-plan`;
      await this.sendInteractiveCardAsync(
        msg,
        buildLoadingCard(`拆分 spec：\`${cmd.spec}\` …（可能几分钟）`, '🗺️ conduit plan'),
        async () => {
          const r = await runConduit(['plan', '--spec', cmd.spec, '--out', outDir], { cwd });
          return buildAckCard({
            state: r.ok ? 'done' : 'error',
            title: r.ok ? '🗺️ 拆分完成' : r.notFound ? '❌ lwa-conduit 未安装' : '❌ 拆分失败',
            body: [
              r.ok
                ? `已生成 \`${outDir}/dag.yaml\`。review 后用 \`/conduit run\` 执行。`
                : r.notFound
                  ? ''
                  : r.timedOut
                    ? '超时（>30min）。大 spec 拆分较慢，建议本机直接跑 `lwa-conduit plan`。'
                    : `退出码 ${r.exitCode}。`,
              '',
              '```',
              r.output || '（无输出）',
              '```',
            ]
              .filter(Boolean)
              .join('\n'),
          });
        },
      );
      return;
    }

    // mode === 'run'
    const conversationId = this.conversationIdOfMessage(msg);
    const pipeline = this.getPipeline(conversationId);
    await pipeline.submit({
      id: `conduit-run-${Date.now()}`,
      run: async (signal) => {
        const placeholderCard = buildLoadingCard(
          `编排运行中：\`${cwd}\` …\n分钟级任务，会建 worktree 并行跑 Kiro，请耐心等`,
          '🚦 conduit run',
        );
        let placeholderMessageId: string | undefined;
        try {
          placeholderMessageId = await this.ingress.replyCard(msg.messageId, placeholderCard);
        } catch (e) {
          this.log.error({ err: e }, 'conduit placeholder send failed');
        }
        const r = await this.runConduitStreaming(
          ['run', '--workspace', cwd],
          cwd,
          signal,
          placeholderMessageId,
          '🚦 conduit run',
        );
        await this.patchConduitFinal(placeholderMessageId, msg, this.conduitRunCard(r, false, cwd));
      },
    });
  }

  /**
   * 跑 conduit 并把流式输出节流刷到占位卡片。返回最终结果，由调用方渲染终态卡。
   * 节流 2s：飞书 patchCard 有频率限制，太频繁会被限流。
   */
  private async runConduitStreaming(
    args: string[],
    cwd: string,
    signal: AbortSignal,
    messageId: string | undefined,
    runningTitle: string,
  ): Promise<ConduitResult> {
    let lastPatch = 0;
    const onProgress = (info: {
      textTail: string;
      progress: import('../conduit/progress.js').ConduitProgressState;
    }): void => {
      const now = Date.now();
      if (now - lastPatch < 2000 || !messageId) return;
      lastPatch = now;
      const structured =
        info.progress.eventCount > 0 ? formatProgressText(info.progress) : '等待结构化事件…';
      const body = [structured, '', info.textTail ? `\`\`\`\n${info.textTail}\n\`\`\`` : '']
        .filter(Boolean)
        .join('\n');
      const card = buildLoadingCard(body, runningTitle);
      void this.ingress.patchCard(messageId, card).catch(() => {});
    };
    return runConduit(args, { cwd, signal, onProgress });
  }

  /** 把终态卡片 patch 到占位卡片；占位没发出去就新发一张。 */
  private async patchConduitFinal(
    messageId: string | undefined,
    msg: IncomingMessage,
    card: object,
  ): Promise<void> {
    if (messageId) {
      await this.ingress
        .patchCard(messageId, card)
        .catch(() => this.sendInteractiveCard(msg, card));
    } else {
      await this.sendInteractiveCard(msg, card);
    }
  }

  /** 根据 conduit 运行结果渲染终态卡片。merged=true 表示带了 --merge。 */
  private conduitRunCard(r: ConduitResult, merged: boolean, cwd?: string): object {
    const title = r.notFound
      ? '❌ lwa-conduit 未安装'
      : r.aborted
        ? '⏹ 编排已中止'
        : r.ok
          ? merged
            ? '✅ 编排+合并完成'
            : '✅ 编排完成'
          : r.timedOut
            ? '⏱ 编排超时'
            : '⚠️ 编排结束（有失败项）';
    const head = r.notFound
      ? ''
      : r.aborted
        ? '已发出终止信号，子进程正在收尾。'
        : r.timedOut
          ? '超时（>30min）被终止。可在本机直接跑 `lwa-conduit run` 看完整过程。'
          : r.ok
            ? merged
              ? '通过的分支已合并到 base branch。'
              : '默认未合并，产出分支已供 review（见下方摘要）。'
            : `退出码 ${r.exitCode}。部分任务可能失败（已通过的仍会合进 integration 分支）。`;

    const parts: string[] = [head];
    if (r.progress && r.progress.eventCount > 0) {
      parts.push('', '**进度**', formatProgressText(r.progress));
    }
    if (cwd) {
      const summary = summarizeRunState(cwd);
      if (summary) {
        parts.push('', '**Run-state**', formatRunSummary(summary));
      }
    }
    if (r.output) {
      parts.push('', '**日志尾部**', '```', r.output, '```');
    }
    return buildAckCard({
      state: r.ok && !r.aborted ? 'done' : r.aborted ? 'aborted' : 'error',
      title,
      body: parts.filter((p) => p !== undefined).join('\n'),
    });
  }

  /**
   * 用户点了「取消」按钮：把表单卡替换成"已取消"提示。
   */
  private async handleScheduleCancel(evt: CardActionEvent): Promise<void> {
    const conversationId = this.conversationIdOfAction(evt);
    const card = buildAckCard({
      state: 'aborted',
      title: '已取消',
      body: '没有创建任何任务。',
    });
    try {
      await this.ingress.patchCard(evt.messageId, card);
    } catch (e) {
      this.log.error({ err: e, action: 'schedule.cancel' }, 'patchCard failed');
      await this.sendCardToConversation(conversationId, card);
    }
  }

  /**
   * 用户点了「创建」按钮（form submit）。
   *
   * MVP 只处理 daily 频率，强制写死。其他频率请用 /cron add。
   *
   * 流程：
   *   1. 从 evt.formValue 拿 hour/minute/prompt/name
   *   2. 拼成 ScheduleForm，调 formToCron
   *   3. 失败 → patchCard 显示带 error 的同张表单
   *   4. 成功 → cronStore.create + scheduler.register，patchCard 替换为成功提示
   */
  private async handleScheduleSubmit(evt: CardActionEvent, cwd: string): Promise<void> {
    const conversationId = this.conversationIdOfAction(evt);
    const senderPrincipalId = this.senderPrincipalIdOfAction(evt);
    if (!this.cronStore || !this.cronScheduler) return;
    const fv = evt.formValue ?? {};

    const hourRaw = String(fv['hour'] ?? '9').trim();
    const minuteRaw = String(fv['minute'] ?? '0').trim();
    // input 接收的是用户键入的字符串，可能是空、"9"、"09"、"9 " 等
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    const promptRaw = String(fv['prompt'] ?? '').trim();
    const nameRaw = String(fv['name'] ?? '').trim();

    const form: ScheduleForm = { frequency: 'daily', hour, minute };

    // prompt 必填
    if (!promptRaw) {
      const errCard = buildScheduleFormCard({
        state: this.formToState(form, promptRaw, nameRaw),
        error: '请填写"内容"——到点要让 Kiro 做什么',
      });
      await this.replaceWithCard(evt, errCard);
      return;
    }

    const result = formToCron(form);
    if (!result.ok) {
      const errCard = buildScheduleFormCard({
        state: this.formToState(form, promptRaw, nameRaw),
        error: result.error,
      });
      await this.replaceWithCard(evt, errCard);
      return;
    }

    // 任务名：用户填了用用户的，否则取 prompt 前 20 字
    const description = nameRaw || promptRaw.slice(0, 20);

    try {
      const task = await this.cronStore.create({
        chatId: conversationId,
        cwd,
        expression: result.expression,
        prompt: promptRaw,
        description,
        createdBy: senderPrincipalId,
        runOnce: result.runOnce,
      });
      this.cronScheduler.register(task);
      const next = this.cronScheduler.nextRun(task.id) ?? nextRun(task.expression);
      const card = buildAckCard({
        state: 'done',
        title: '✅ 定时任务已创建',
        body: [
          `\`${task.id.slice(0, 6)}\` · ${description}`,
          `**频率**：${result.description}`,
          `**下次触发**：${formatNextRun(next)}`,
        ].join('\n'),
      });
      await this.replaceWithCard(evt, card);
    } catch (e) {
      const errCard = buildScheduleFormCard({
        state: this.formToState(form, promptRaw, nameRaw),
        error: `创建失败：${(e as Error).message}`,
      });
      await this.replaceWithCard(evt, errCard);
    }
  }

  /**
   * 把 ScheduleForm + 用户输入合并回 ScheduleFormState（出错时回填表单用）。
   */
  private formToState(form: ScheduleForm, prompt: string, name: string): ScheduleFormState {
    const out: ScheduleFormState = { frequency: form.frequency };
    if (form.hour !== undefined) out.hour = form.hour;
    if (form.minute !== undefined) out.minute = form.minute;
    if (form.weekdays !== undefined) out.weekdays = form.weekdays;
    if (form.dayOfMonth !== undefined) out.dayOfMonth = form.dayOfMonth;
    if (form.date !== undefined) out.date = form.date;
    if (form.expression !== undefined) out.expression = form.expression;
    if (prompt) out.prompt = prompt;
    if (name) out.name = name;
    return out;
  }

  /**
   * 把卡片替换到原消息上（patchCard 失败时降级为新发卡）。
   */
  private async replaceWithCard(evt: CardActionEvent, card: object): Promise<void> {
    const conversationId = this.conversationIdOfAction(evt);
    try {
      await this.ingress.patchCard(evt.messageId, card);
    } catch (e) {
      this.log.error({ err: e }, 'patchCard failed; fallback to send new card');
      await this.sendCardToConversation(conversationId, card);
    }
  }

  /**
   * cron 任务到点触发：构造一个伪 IncomingMessage 调用 runKiroTask。
   *
   * 关键设计：触发时往原 chat 发一张「⏰ 定时任务」开头的卡片，跟用户主动 @ 走完全相同的卡片渲染体系，
   * 只是头部多一个 "⏰ 定时" 标记（通过 prompt 前缀实现，让 Kiro 知道这是定时任务）。
   *
   * 注意：这里**不走** rapid-fire 合并（因为是定时，不存在用户连发）。
   * 直接调用 executeKiroTask。
   */
  async fireCronTask(task: CronTask): Promise<void> {
    const conversationId = task.chatId;
    const fakeMessage: IncomingMessage = {
      eventId: `cron-${task.id}-${Date.now()}`,
      messageId: '',
      chatId: task.chatId,
      chatType: 'group',
      senderOpenId: task.createdBy || 'cron',
      messageType: 'text',
      rawContent: '',
      text: task.prompt,
      mentions: [],
      receivedAt: Date.now(),
    };
    // 触发时给一张提示卡片，让用户知道是定时任务
    try {
      await this.sendCardToConversation(
        conversationId,
        buildAckCard({
          state: 'done',
          title: '⏰ 定时任务触发',
          body: `\`${task.id.slice(0, 6)}\` (${task.description || task.expression})\n${task.prompt.length > 100 ? task.prompt.slice(0, 100) + '…' : task.prompt}`,
        }),
      );
    } catch (e) {
      this.log.warn({ err: e, id: task.id }, 'failed to send cron trigger notice');
    }

    // 调 executeKiroTask 跑 Kiro，跟普通消息一样的卡片渲染
    await this.executeKiroTask(fakeMessage, task.prompt, task.cwd, [], undefined);
  }

  /**
   * 用户在超时卡片上点"继续未完成的部分"按钮的处理。
   *
   * 关键：靠 kiro-cli 的 session 续接能力——sessionId 已存在 sessions store，
   * executeKiroTask 拿到 resumeId 就会传 `--resume-id` 给 kiro-cli，
   * 模型读到完整对话历史，自然知道接着上次的工作干。
   *
   * 我们这里只需要构造一条"继续"prompt 触发任务，无需重传全部上下文。
   */
  async fireContinue(conversationId: string): Promise<void> {
    const session = await this.sessions.getConversation(
      conversationId,
      this.config.workspace.defaultCwd,
    );
    const resumeId = await this.sessions.getKiroSession(conversationId, session.currentCwd);
    if (!resumeId) {
      // 没有 sessionId 说明上次根本没跑成功；提示一下就行
      await this.sendCardToConversation(
        conversationId,
        buildAckCard({
          state: 'error',
          title: '⚠️ 无法继续',
          body: '当前 chat 在该工作目录下没有可续接的会话。请重新发送原消息。',
        }),
      );
      return;
    }
    const fakeMessage: IncomingMessage = {
      eventId: `continue-${conversationId}-${Date.now()}`,
      messageId: '',
      chatId: conversationId,
      chatType: 'group',
      senderOpenId: 'continue-button',
      messageType: 'text',
      rawContent: '',
      text: '',
      mentions: [],
      receivedAt: Date.now(),
    };
    const continuePrompt =
      '继续上次未完成的工作。如果上次任务有明确的剩余步骤就只完成剩余的；如果接近完成就只补完最后一步。' +
      '不要重做已经完成的部分。';
    await this.executeKiroTask(
      fakeMessage,
      continuePrompt,
      session.currentCwd,
      [],
      session.idleTimeoutMinutes,
    );
  }

  private async replyErrorCard(msg: IncomingMessage, body: string, cwd: string): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    const renderer = new CardRenderer({
      ingress: this.ingress,
      chatId: conversationId,
      replyToMessageId: msg.messageId,
      intervalMs: this.config.preferences.cardUpdateIntervalMs,
      logger: this.log,
      ctx: { cwd },
    });
    await renderer.open('error', body);
    await renderer.finalize('error', body);
  }

  /**
   * 把一条用户消息丢给 Kiro 处理。
   *
   * **包了一层 rapid-fire 合并**：先放 buffer，等 200ms 静默期再真正 submit；
   * 期间若同 chat 又来新消息，就追加到同一个 buffer，不会触发 abort+rerun。
   *
   * 真正的 Kiro 调用在 executeKiroTask 里。
   */
  private async runKiroTask(
    msg: IncomingMessage,
    prompt: string,
    cwd: string,
    mediaPaths: string[] = [],
    perChatIdleMin?: number,
    quoteSourceId?: string,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    // 命令型场景（doctor 等）prompt 极长且不该合并，跳过合并直接执行
    // 这里用启发式：prompt > 500 字符或 包含 "**最近日志**" 视为命令型
    const skipMerge = prompt.length > 500 || prompt.includes('**最近日志');
    if (skipMerge) {
      await this.executeKiroTask(msg, prompt, cwd, mediaPaths, perChatIdleMin);
      return;
    }

    const existing = this.mergeBuffers.get(conversationId);
    if (existing) {
      // 追加到现有 buffer
      if (prompt) existing.texts.push(prompt);
      existing.mediaPaths.push(...mediaPaths);
      if (quoteSourceId) existing.quoteSourceIds.add(quoteSourceId);
      // 重置计时器：续窗用短窗（用户已在连发，不必久等）
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        this.flushMergeBuffer(conversationId);
      }, this.MERGE_WINDOW_MS);
      this.log.debug(
        { chatId: conversationId, accumulated: existing.texts.length },
        'merging rapid-fire message',
      );
      return;
    }

    // 第一条：开 buffer 等更多。
    // 合并转发用长首窗（等可能的追问），普通消息用短首窗（保持响应灵敏）。
    const firstWindow =
      msg.messageType === 'merge_forward' ? this.MERGE_WINDOW_FORWARD_MS : this.MERGE_WINDOW_MS;
    const timer = setTimeout(() => {
      this.flushMergeBuffer(conversationId);
    }, firstWindow);
    this.mergeBuffers.set(conversationId, {
      anchor: msg,
      texts: prompt ? [prompt] : [],
      mediaPaths: [...mediaPaths],
      quoteSourceIds: new Set(quoteSourceId ? [quoteSourceId] : []),
      cwd,
      perChatIdleMin,
      timer,
    });
  }

  /**
   * flush 当前 chat 的合并 buffer：拉取引用/转发原文 → 拼接文本 → 调 executeKiroTask。
   *
   * 引用/转发内容在这里统一拉取（而非主路径），原因见 handle() 第 4.6 步注释：
   * 避免网络延迟破坏 200ms 合并窗口。多条消息引用同一源时只拉一次（Set 去重）。
   */
  private flushMergeBuffer(conversationId: string): void {
    const buf = this.mergeBuffers.get(conversationId);
    if (!buf) return;
    this.mergeBuffers.delete(conversationId);
    clearTimeout(buf.timer);
    const userText = buf.texts.filter((t) => t.length > 0).join('\n\n');
    if (buf.texts.length > 1) {
      this.log.info(
        { chatId: conversationId, mergedCount: buf.texts.length, totalLen: userText.length },
        'flushing merged rapid-fire batch',
      );
    }
    const quoteIds = [...buf.quoteSourceIds].filter((id) => id);
    // 不 await：让定时器线程立即返回，拉取 + submit 在后台排队
    void (async () => {
      // 拉取所有引用/转发源内容（已去重）
      const quoteBlocks: string[] = [];
      for (const id of quoteIds) {
        const block = await this.fetchQuoteContent(id);
        if (block) quoteBlocks.push(block);
      }
      const quoteContext = quoteBlocks.join('\n\n');
      // 引用上下文放前面作背景。
      // 关键：明确告诉 Kiro "以下面这段内容为准"，避免它从复用的历史会话里
      // 捞旧记忆乱答（曾出现"这次转发不含银联，却答成上次的银联话题"）。
      const FOCUS_HINT = '（请只针对上面这段引用/转发的内容作答，不要混入之前对话里的其他话题。）';
      let prompt: string;
      if (quoteContext) {
        prompt = userText
          ? `${quoteContext}\n\n---\n\n${userText}\n\n${FOCUS_HINT}`
          : `${quoteContext}\n\n---\n\n（用户转发/引用了以上内容但没有附加文字，请理解其内容并作出有帮助的回应，例如解释、总结或询问用户想做什么。）\n\n${FOCUS_HINT}`;
      } else {
        prompt = userText;
      }
      if (!prompt) {
        this.log.debug({ chatId: conversationId }, 'merge buffer flushed with empty prompt, skip');
        return;
      }
      await this.executeKiroTask(buf.anchor, prompt, buf.cwd, buf.mediaPaths, buf.perChatIdleMin);
    })().catch((e) =>
      this.log.error({ err: e, chatId: conversationId }, 'flush merge buffer execute failed'),
    );
  }

  /**
   * CLI 纯文本 turn：不走飞书卡片，只把最终回复打到终端。
   */
  private async executeCliTurn(
    msg: IncomingMessage,
    finalPrompt: string,
    cwd: string,
    idleTimeoutMs: number,
    taskId: string,
    taskStartedAt: number,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    const pipeline = this.getPipeline(conversationId);

    await pipeline.submit({
      id: taskId,
      run: async (signal) => {
        process.stdout.write('\n…\n');
        try {
          const sessionTtlMs =
            this.config.kiro.sessionTtlHours > 0 ? this.config.kiro.sessionTtlHours * 3_600_000 : 0;

          // auto-compact：上下文过大时先压缩再继续
          await this.maybeAutoCompact(conversationId, cwd, finalPrompt);

          const phase = await this.sessions.getConversationPhase(conversationId);
          const priorSummary = await this.sessions.getCompactionSummary(conversationId);
          let turnPrompt = finalPrompt;
          if (priorSummary) {
            turnPrompt = `${priorSummary}\n\n---\nContinue from the compacted context above.\n\n${finalPrompt}`;
          }
          if (phase === 'plan' && !turnPrompt.includes('[PLAN ONLY')) {
            turnPrompt = `[PLAN ONLY — do not edit files; produce a concrete plan]\n${turnPrompt}`;
          } else if (phase === 'review' && !turnPrompt.includes('[REVIEW ONLY')) {
            turnPrompt = `[REVIEW ONLY — read-only; findings / risks / suggestions; do not edit]\n${turnPrompt}`;
          }
          const { profileName, profile, reason, complexityScore, modelDecision } =
            await this.selectRuntimeForTask(conversationId, turnPrompt, 0);
          const { shortenHomePath } = await import('../ingress/cli/workspace.js');
          const { buildCliCodingSystemPrompt, buildCliChatSystemPrompt } = await import(
            '../ingress/cli/codingPrompt.js'
          );
          const harnessMode = this.harnessModeOf(conversationId);
          const systemPromptPrefix =
            harnessMode === 'chat'
              ? buildCliChatSystemPrompt({
                  cwd,
                  profileName,
                  model: profile.model,
                  feishuPrefix: this.config.kiro.systemPromptPrefix,
                })
              : buildCliCodingSystemPrompt({
                  cwd,
                  profileName,
                  model: profile.model,
                });
          const codingProfile = {
            ...profile,
            systemPromptPrefix,
          };
          if (reason.includes('gateway_skip') || reason.includes('gateway-circuit')) {
            process.stdout.write(`(gateway degraded → ${profileName})\n`);
          }
          process.stdout.write(
            `[${profileName}${profile.model ? ` · ${profile.model}` : ''}]  ${shortenHomePath(cwd)}\n\n`,
          );
          const storedSid = await this.sessions.getConversationAgentSession(
            conversationId,
            cwd,
            sessionTtlMs,
          );

          let pooled: Parameters<typeof runAgentTurn>[1]['pooled'];
          if (profile.kind === 'kiro-cli-acp') {
            const pool = this.getAcpPool(profile);
            pooled = await pool.acquire(conversationId, {
              cwd,
              resumeId: storedSid ? decodeSessionId(storedSid, profile.kind) : undefined,
            });
          }

          const { extractPathsFromSessionEvent, normalizeArtifactPath } = await import(
            '../runtime/artifacts.js'
          );
          let streamed = '';
          const touchedThisTurn: string[] = [];
          let result: Awaited<ReturnType<typeof runAgentTurn>>;
          try {
            result = await runAgentTurn(codingProfile, {
              prompt: turnPrompt,
              cwd,
              resumeId: storedSid,
              timeoutMs: profile.timeoutMs ?? this.config.kiro.timeoutMs,
              idleTimeoutMs,
              signal,
              onEvent: (ev) => {
                if (ev.kind === 'message' && ev.text) {
                  streamed += ev.text;
                  process.stdout.write(ev.text);
                }
                for (const raw of extractPathsFromSessionEvent(ev)) {
                  const abs = normalizeArtifactPath(cwd, raw);
                  if (abs) touchedThisTurn.push(abs);
                }
              },
              extraEnv: {
                LARK_KIRO_CHAT_ID: conversationId,
                LARK_KIRO_CHAT_TYPE: msg.chatType,
                LARK_KIRO_SENDER_OPEN_ID: msg.senderOpenId,
                LARK_AGENT_RUNTIME: profileName,
                LARK_AGENT_RUNTIME_REASON: reason,
                LARK_AGENT_COMPLEXITY_SCORE: String(complexityScore ?? ''),
                LARK_AGENT_MODEL: profile.model ?? '',
                LARK_AGENT_MODEL_REASON: modelDecision?.reason ?? '',
                LWA_CLI_MODE: harnessMode,
                LWA_PHASE: phase ?? '',
              },
              pooled,
            });
            if (profile.kind === 'openai-compatible') {
              sharedGatewayHealth.recordSuccess(profile, profileName);
            }
          } catch (e) {
            if (profile.kind === 'openai-compatible') {
              sharedGatewayHealth.recordFailure(profile, profileName, (e as Error).message);
              process.stdout.write(
                `\n(gateway error → circuit; next turns prefer kiro/cursor)\n${(e as Error).message}\n`,
              );
              return;
            }
            throw e;
          }

          if (profile.kind === 'kiro-cli-acp') {
            this.getAcpPool(profile).release(conversationId);
          }

          if (result.aborted) {
            process.stdout.write('\n(aborted)\n');
            return;
          }
          if (result.idleTimedOut || result.timedOut) {
            process.stdout.write('\n(timeout)\n');
            return;
          }
          if (result.exitCode !== 0) {
            if (profile.kind === 'openai-compatible') {
              sharedGatewayHealth.recordFailure(profile, profileName, `exit ${result.exitCode}`);
            }
            process.stdout.write(`\n(error: exit ${result.exitCode})\n`);
            return;
          }

          if (!streamed && result.text) {
            process.stdout.write(result.text);
          }
          process.stdout.write('\n');

          if (result.newSessionId) {
            await this.sessions.setConversationKiroSession(
              conversationId,
              cwd,
              result.newSessionId,
            );
          }
          if (touchedThisTurn.length > 0) {
            await this.sessions.appendFilesTouched(
              conversationId,
              touchedThisTurn,
              this.config.workspace.defaultCwd,
            );
          }
          await this.sessions.touchConversation(conversationId);

          if (this.taskHistory) {
            await this.taskHistory
              .add({
                taskId,
                conversationId,
                chatId: conversationId,
                cwd,
                startedAt: taskStartedAt,
                finishedAt: Date.now(),
                terminal: 'done',
                promptPreview: finalPrompt.slice(0, 100),
                toolCallCount: 0,
                artifacts: [...new Set(touchedThisTurn)].slice(0, 20),
                runtimeKind: profile.kind,
                runtimeProfile: profileName,
                model: profile.model,
              })
              .catch(() => undefined);
          }
        } catch (e) {
          process.stdout.write(`\n(error: ${(e as Error).message})\n`);
        }
      },
    });
  }

  /**
   * 真正把任务丢到 ChatPipeline 跑 Kiro 的实现（不含 rapid-fire 合并）。
   * - 在 ChatPipeline 里跑（自动 preempt）
   * - 用 RunCardController 流式刷新卡片（每个工具独立 panel）
   * - mediaPaths 非空时，把绝对路径作为前缀加到 prompt 前面
   * - perChatIdleMin 控制本次 idle watchdog 阈值
   */
  private async executeKiroTask(
    msg: IncomingMessage,
    prompt: string,
    cwd: string,
    mediaPaths: string[] = [],
    perChatIdleMin?: number,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    const pipeline = this.getPipeline(conversationId);
    const taskId = `${msg.eventId || msg.messageId}-${Date.now().toString(36)}`;
    const taskStartedAt = Date.now();

    // 任务开始前：清理该 chat 上次任务遗留的 plan 文件，准备新目录
    const planDir = planDirFor(conversationId);
    try {
      rmSync(planDir, { recursive: true, force: true });
      mkdirSync(planDir, { recursive: true, mode: 0o700 });
    } catch (e) {
      this.log.warn({ err: e, planDir }, 'plan dir reset failed (non-fatal)');
    }
    const planFilePath = planFilePathFor(conversationId);

    // 拼接 prompt：[系统前缀] + [plan 路径提示] + 媒体路径 + 用户文本
    // 系统前缀约束工具偏好；plan 路径提示让 kiro 知道写计划文件的位置
    const systemPrefix = this.config.kiro.systemPromptPrefix;
    const isCli = this.isTextChannel(conversationId);
    const planHint = isCli
      ? ''
      : `\n\n# 任务计划文件\n\n` +
        `如果当前任务超过 3 步，把 JSON 计划写到 \`${planFilePath}\`，bridge 会自动渲染到飞书卡片让用户看到进度。\n` +
        `Schema：{version:1, chatId, status:"planning"|"running"|"completed"|"failed"|"cancelled", title?, items:[{id,title,status:"pending"|"in_progress"|"done"|"failed"|"skipped",detail?,startedAt?,finishedAt?}], createdAt, updatedAt}\n` +
        `**原子写入**：先写 \`${planFilePath}.tmp\` 再 \`mv\` 成正式文件，避免读到半截 JSON。\n` +
        `每完成一步 update 一次（status 改 done）；不要一次性把所有 step 标 done；不要提交后忘了写。`;
    const userPrompt = mediaPaths.length
      ? mediaPaths.map((p) => `@${p}`).join(' ') + (prompt ? '\n\n' + prompt : '')
      : prompt;
    const finalPrompt = systemPrefix
      ? `${systemPrefix}${planHint}\n\n---\n\n${userPrompt}`
      : userPrompt;

    const idleMin = this.effectiveIdleMinutes(perChatIdleMin);
    const idleTimeoutMs = idleMin > 0 ? idleMin * 60 * 1000 : 0;

    this.log.debug(
      {
        taskId,
        chatId: conversationId,
        cwd,
        promptLen: finalPrompt.length,
        promptHead: finalPrompt.slice(0, 120),
        mediaCount: mediaPaths.length,
        idleMin,
      },
      'executeKiroTask start',
    );

    if (isCli) {
      await this.executeCliTurn(msg, finalPrompt, cwd, idleTimeoutMs, taskId, taskStartedAt);
      return;
    }

    await pipeline.submit({
      id: taskId,
      run: async (signal) => {
        const ctrlOpts: ConstructorParameters<typeof RunCardController>[0] = {
          ingress: this.ingress,
          chatId: conversationId,
          replyToMessageId: msg.messageId,
          intervalMs: this.config.preferences.cardUpdateIntervalMs,
          logger: this.log,
        };
        if (idleMin > 0) ctrlOpts.idleTimeoutMinutes = idleMin;
        const ctrl = new RunCardController(ctrlOpts);
        let selectedProfileName: string | undefined;
        let selectedProfile: RuntimeProfile | undefined;
        let selectedComplexityScore: number | undefined;
        try {
          await ctrl.open();
        } catch (e) {
          this.log.error({ err: e }, 'failed to open card; aborting task');
          return;
        }

        // 注册到 active-cards 注册表：daemon 异常退出时下次启动可以认领并 finalize
        const cardMessageId = ctrl.getMessageId();
        if (this.activeCards && cardMessageId) {
          await this.activeCards
            .add({
              chatId: conversationId,
              messageId: cardMessageId,
              taskId,
              startedAt: Date.now(),
              replyToMessageId: msg.messageId,
            })
            .catch((e) => {
              // 持久化失败不影响主流程；只是失去崩溃恢复能力
              this.log.warn({ err: e, taskId }, 'active-cards add failed (non-fatal)');
            });
        }

        // 启动 PlanSource 监听该 chat 的 plan 文件变化；变化推到 ctrl 触发 patch
        const planSource = new FilePlanSource(conversationId, this.log);
        await planSource.start((plan) => {
          ctrl.setPlan(plan);
        });

        try {
          const sessionTtlMs =
            this.config.kiro.sessionTtlHours > 0 ? this.config.kiro.sessionTtlHours * 3_600_000 : 0;
          const { profileName, profile, reason, complexityScore, modelDecision } =
            await this.selectRuntimeForTask(conversationId, finalPrompt, mediaPaths.length);
          selectedProfileName = profileName;
          selectedProfile = profile;
          selectedComplexityScore = complexityScore;
          const storedSid = await this.sessions.getConversationAgentSession(
            conversationId,
            cwd,
            sessionTtlMs,
          );
          const resumeId = storedSid
            ? decodeSessionId(storedSid, profile.kind)
              ? storedSid
              : undefined
            : undefined;
          this.log.info(
            {
              chatId: conversationId,
              profileName,
              runtimeKind: profile.kind,
              model: profile.model,
              reason,
              complexityScore,
              modelRouteMode: modelDecision?.mode,
              modelRouteTier: modelDecision?.tier,
              availableModelCount: modelDecision?.availableModelCount,
            },
            'runtime selected for task',
          );

          let pooled: Parameters<typeof runAgentTurn>[1]['pooled'];
          if (profile.kind === 'kiro-cli-acp') {
            const pool = this.getAcpPool(profile);
            pooled = await pool.acquire(conversationId, {
              cwd,
              resumeId: resumeId ? decodeSessionId(resumeId, profile.kind) : undefined,
            });
          }

          const runOpts: Parameters<typeof runAgentTurn>[1] = {
            prompt: finalPrompt,
            cwd,
            resumeId: storedSid,
            timeoutMs: profile.timeoutMs ?? this.config.kiro.timeoutMs,
            idleTimeoutMs,
            signal,
            onEvent: (ev) => ctrl.applyEvent(ev),
            extraEnv: {
              LARK_KIRO_CHAT_ID: conversationId,
              LARK_KIRO_CHAT_TYPE: msg.chatType,
              LARK_KIRO_SENDER_OPEN_ID: msg.senderOpenId,
              LARK_AGENT_RUNTIME: profileName,
              LARK_AGENT_RUNTIME_REASON: reason,
              LARK_AGENT_COMPLEXITY_SCORE: String(complexityScore ?? ''),
              LARK_AGENT_MODEL: profile.model ?? '',
              LARK_AGENT_MODEL_REASON: modelDecision?.reason ?? '',
            },
            pooled,
          };

          let result: Awaited<ReturnType<typeof runAgentTurn>>;
          try {
            result = await runAgentTurn(profile, runOpts);
          } catch (e) {
            await ctrl.finalize('error', (e as Error).message);
            return;
          } finally {
            if (profile.kind === 'kiro-cli-acp') {
              this.getAcpPool(profile).release(conversationId);
            }
          }

          if (result.aborted) {
            // 被抢占/主动中止：如果一个字都没产出，这张卡片显示"已中止"纯属噪音，
            // 直接撤回（典型场景：转发消息触发的任务被紧跟的追问抢占）。
            // 已经产出过内容的，仍保留"已中止"终态，让用户看到中断点。
            if (ctrl.hasContent()) {
              await ctrl.finalize('interrupted');
            } else {
              await ctrl.discard();
            }
            return;
          }
          if (result.idleTimedOut) {
            await ctrl.finalize('idle_timeout');
            return;
          }
          if (result.timedOut) {
            // 总超时：保留全部已产出的 blocks（不当 error 处理），用 'timeout' 终态。
            // 用户可以点卡片底部的"继续未完成部分"按钮触发续接。
            await ctrl.finalize('timeout');
            return;
          }
          if (result.exitCode !== 0) {
            const engine = profile.kind === 'cursor-agent-cli' ? 'cursor agent' : 'kiro-cli';
            await ctrl.finalize('error', `${engine} 退出码 ${result.exitCode}`);
            return;
          }

          // 成功：保存新 sessionId 用于续接
          if (result.newSessionId && result.newSessionId !== resumeId) {
            await this.sessions.setConversationKiroSession(
              conversationId,
              cwd,
              result.newSessionId,
            );
          }
          // 刷新 lastActiveAt，防止 TTL 误过期
          await this.sessions.touchConversation(conversationId);
          // 缓存 Kiro 推送的当前 agent 可用 skills（供 /help 动态展示）
          if (result.availableSkills && result.availableSkills.length > 0) {
            this.chatSkills.set(conversationId, result.availableSkills);
          }
          await ctrl.finalize('done');
        } finally {
          // 任务终结（任何路径）后清理资源
          planSource.stop();
          if (this.activeCards && cardMessageId) {
            await this.activeCards.removeConversation(conversationId, cardMessageId).catch((e) => {
              this.log.warn({ err: e, taskId }, 'active-cards remove failed (non-fatal)');
            });
          }
          // 记录任务历史（discard 掉的空任务 terminal 仍是 'running'，不记录，没有展示价值）
          if (this.taskHistory && ctrl.getTerminal() !== 'running') {
            const { toolCallCount, artifacts } = ctrl.summarizeForHistory();
            const taskBucket = classifyTaskBucket({
              prompt: finalPrompt,
              mediaCount: mediaPaths.length,
            });
            const record: Parameters<TaskHistoryStore['add']>[0] = {
              taskId,
              conversationId,
              chatId: conversationId,
              cwd,
              startedAt: taskStartedAt,
              finishedAt: Date.now(),
              terminal: ctrl.getTerminal(),
              promptPreview: prompt.slice(0, 100),
              toolCallCount,
              artifacts,
              taskBucket,
              runtimeProfile: selectedProfileName,
              runtimeKind: selectedProfile?.kind,
              model: selectedProfile?.model,
              complexityScore: selectedComplexityScore,
            };
            const errMsg = ctrl.getErrorMsg();
            if (errMsg !== undefined) record.errorMsg = errMsg;
            await this.taskHistory.add(record).catch((e) => {
              this.log.warn({ err: e, taskId }, 'task-history add failed (non-fatal)');
            });
          }
        }
      },
    });
  }

  // ─── Skill_Marketplace ─────────────────────────────────────────

  private async handleSkillCmd(
    msg: IncomingMessage,
    cmd: Extract<ParsedCommand, { kind: 'skill' }>,
  ): Promise<void> {
    switch (cmd.mode) {
      case 'list': {
        const { listGlobalSkills } = await import('../dashboard/skills.js');
        const skills = listGlobalSkills();
        const body =
          skills.length === 0
            ? '未发现全局 Skill。\n目录：`~/.kiro/skills/`'
            : skills.map((s) => `• **${s.name}**：${s.description}`).join('\n');
        await this.sendInteractiveCard(
          msg,
          buildAckCard({ state: 'done', title: `🧩 Skills (${skills.length})`, body }),
        );
        return;
      }
      case 'source-list': {
        const sources = await listSources('skill');
        if (sources.length === 0) {
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'done',
              title: '🧩 Skill Sources',
              body: '未注册任何 Skill Source。\n用 `/skill source add <name> <git-url>` 添加。',
            }),
          );
          return;
        }
        const body = sources.map((s) => `• **${s.name}**\n  ${s.gitUrl}`).join('\n');
        await this.sendInteractiveCard(
          msg,
          buildAckCard({ state: 'done', title: `🧩 Skill Sources (${sources.length})`, body }),
        );
        return;
      }
      case 'source-add': {
        await addSource({ name: cmd.name, gitUrl: cmd.url, kind: 'skill' });
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: 'done',
            title: '✅ Source 已添加',
            body: `\`${cmd.name}\` → ${cmd.url}\n\n用 \`/skill sync ${cmd.name}\` 同步并查看可安装的 Skill。`,
          }),
        );
        return;
      }
      case 'source-remove': {
        const ok = await removeSource(cmd.name);
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: ok ? 'done' : 'error',
            title: ok ? '🗑️ Source 已移除' : '❌ Source 不存在',
            body: ok ? `已移除 \`${cmd.name}\`` : `没有名为 \`${cmd.name}\` 的 source`,
          }),
        );
        return;
      }
      case 'sync': {
        try {
          const candidates = await syncSource(cmd.name);
          if (candidates.length === 0) {
            await this.sendInteractiveCard(
              msg,
              buildAckCard({
                state: 'done',
                title: '🧩 同步完成',
                body: `\`${cmd.name}\` 中未发现可安装的 Skill。`,
              }),
            );
            return;
          }
          const source = await getSource(cmd.name);
          const lines = [
            `来源：\`${source?.gitUrl ?? cmd.name}\``,
            '⚠️ **内容未经 Bridge_Maintainer 审核**',
            '⚠️ 第三方 Skill 可能包含试图诱导执行危险操作的指令',
            '',
            `发现 ${candidates.length} 个候选 Skill：`,
            '',
            ...candidates.map((c) => `• **${c.id}**${c.isNew ? ' 🆕' : ''}\n  ${c.summary}`),
            '',
            '要安装某个 Skill，请发送：`/skill install ' + cmd.name + ' <name>`',
          ];
          await this.sendInteractiveCard(
            msg,
            buildAckCard({ state: 'done', title: '🧩 同步完成', body: lines.join('\n') }),
          );
        } catch (e) {
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'error',
              title: '❌ 同步失败',
              body: (e as Error).message.slice(0, 500),
            }),
          );
        }
        return;
      }
      case 'install': {
        const r = await installAsset(cmd.name, cmd.assetId);
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: r.installed ? 'done' : 'error',
            title: r.installed ? '✅ Skill 已安装' : '⚠️ 未安装',
            body: r.installed
              ? `\`${cmd.assetId}\` 已安装到 \`~/.kiro/skills/\``
              : (r.reason ?? '安装失败'),
          }),
        );
        return;
      }
    }
  }

  // ─── Persona_System ────────────────────────────────────────────

  private async handleAgentCmd(
    msg: IncomingMessage,
    cmd: Extract<ParsedCommand, { kind: 'agent' }>,
  ): Promise<void> {
    const conversationId = this.conversationIdOfMessage(msg);
    switch (cmd.mode) {
      case 'show': {
        const agents = listGlobalAgents();
        if (agents.length === 0) {
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'done',
              title: '🎭 Agents',
              body: '未发现任何 Agent_Config。\n\n• 手动创建：编辑 `~/.kiro/agents/<name>.json`\n• 安装默认角色库：`/agent install-defaults`',
            }),
          );
          return;
        }
        const current = this.config.kiro.agent ?? '（未设置，使用 Kiro 默认）';
        const lines = [
          `当前生效：**${current}**`,
          '',
          ...agents.map((a) => `• **${a.name}**：${a.promptPreview}`),
          '',
          '切换：`/agent <name>`｜重置：`/agent reset`',
        ];
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: 'done',
            title: `🎭 Agents (${agents.length})`,
            body: lines.join('\n'),
          }),
        );
        return;
      }
      case 'set': {
        const agents = listGlobalAgents();
        const found = agents.find((a) => a.name === cmd.name);
        if (!found) {
          const valid = agents.map((a) => `\`${a.name}\``).join('、') || '（无可用 agent）';
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'error',
              title: '❌ Agent 不存在',
              body: `没有名为 \`${cmd.name}\` 的 Agent_Config。\n\n可用：${valid}`,
            }),
          );
          return;
        }
        this.config = patchAndSaveConfig(this.config, (draft) => {
          draft.kiro.agent = cmd.name;
        });
        // 确保下一条消息用新 agent：evict 当前 chat 的池化进程
        await this.evictChatFromAllPools(conversationId);
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: 'done',
            title: '✅ Agent 已切换',
            body: `已切换到 \`${cmd.name}\`（下一条消息生效）`,
          }),
        );
        return;
      }
      case 'reset': {
        this.config = patchAndSaveConfig(this.config, (draft) => {
          delete draft.kiro.agent;
        });
        await this.evictChatFromAllPools(conversationId);
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: 'done',
            title: '✅ Agent 已恢复默认',
            body: '已清除 agent 覆盖，回归 Kiro 默认',
          }),
        );
        return;
      }
      case 'create': {
        // 简单实现：写入一个只含 prompt 占位的 JSON，提示用户编辑
        const { existsSync, writeFileSync, mkdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { homedir } = await import('node:os');
        const agentsDir = join(homedir(), '.kiro', 'agents');
        const filePath = join(agentsDir, `${cmd.name}.json`);
        if (existsSync(filePath)) {
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'error',
              title: '❌ 已存在',
              body: `\`${cmd.name}.json\` 已存在，请直接编辑该文件或用其他名称。`,
            }),
          );
          return;
        }
        mkdirSync(agentsDir, { recursive: true });
        const template = {
          prompt: `你是${cmd.name}。请编辑此文件，填入具体的角色定义。`,
          tools: [],
        };
        writeFileSync(filePath, JSON.stringify(template, null, 2) + '\n', 'utf-8');
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: 'done',
            title: '✅ Agent 已创建',
            body: `已写入 \`~/.kiro/agents/${cmd.name}.json\`\n\n请编辑文件填入你的角色 prompt 和 tools，然后用 \`/agent ${cmd.name}\` 切换。`,
          }),
        );
        return;
      }
      case 'sync': {
        try {
          const candidates = await syncSource(cmd.source);
          if (candidates.length === 0) {
            await this.sendInteractiveCard(
              msg,
              buildAckCard({
                state: 'done',
                title: '🎭 同步完成',
                body: `\`${cmd.source}\` 中未发现可安装的 Agent_Config。`,
              }),
            );
            return;
          }
          const source = await getSource(cmd.source);
          const lines = [
            `来源：\`${source?.gitUrl ?? cmd.source}\``,
            '⚠️ **内容未经 Bridge_Maintainer 审核**',
            '⚠️ `prompt` 可能包含试图诱导模型偏离预期职责的指令，`tools`/`mcpServers` 可能授予超出预期范围的工具访问权限',
            '',
            `发现 ${candidates.length} 个候选 Agent_Config：`,
            '',
            ...candidates.map((c) => `• **${c.id}**${c.isNew ? ' 🆕' : ''}\n  ${c.summary}`),
            '',
            '要安装某个 Agent，请发送：`/agent install ' + cmd.source + ' <name>`',
          ];
          await this.sendInteractiveCard(
            msg,
            buildAckCard({ state: 'done', title: '🎭 同步完成', body: lines.join('\n') }),
          );
        } catch (e) {
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'error',
              title: '❌ 同步失败',
              body: (e as Error).message.slice(0, 500),
            }),
          );
        }
        return;
      }
      case 'install': {
        const r = await installAsset(cmd.source, cmd.assetId);
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: r.installed ? 'done' : 'error',
            title: r.installed ? '✅ Agent 已安装' : '⚠️ 未安装',
            body: r.installed
              ? `\`${cmd.assetId}\` 已安装到 \`~/.kiro/agents/\`\n用 \`/agent ${cmd.assetId}\` 切换`
              : (r.reason ?? '安装失败'),
          }),
        );
        return;
      }
      case 'install-defaults': {
        const library = listPersonaLibrary();
        if (library.length === 0) {
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'error',
              title: '❌ 默认角色库为空',
              body: '未找到内置角色文件。',
            }),
          );
          return;
        }
        const { existsSync, writeFileSync, mkdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { homedir } = await import('node:os');
        const agentsDir = join(homedir(), '.kiro', 'agents');
        mkdirSync(agentsDir, { recursive: true });
        let installed = 0;
        let skipped = 0;
        for (const entry of library) {
          const filePath = join(agentsDir, `${entry.name}.json`);
          if (existsSync(filePath)) {
            skipped++;
          } else {
            writeFileSync(filePath, JSON.stringify(entry.config, null, 2) + '\n', 'utf-8');
            installed++;
          }
        }
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: 'done',
            title: '✅ 默认角色库已安装',
            body: `已安装 ${installed} 个，跳过 ${skipped} 个已存在的。\n\n用 \`/agent\` 查看全部可用角色。`,
          }),
        );
        return;
      }
    }
  }
}
