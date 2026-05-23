/**
 * 消息总分发器
 *
 * 把一条飞书消息变成一个动作：
 *   1. 访问控制校验（用户/群白名单、@bot 检测）
 *   2. 解析斜杠命令
 *   3. 路由到 commandHandler 或 kiroHandler
 *   4. 更新卡片
 *
 * 跨 chat 并发不限（每个 chat 自己内部串行）。
 */
import type { Logger } from 'pino';
import type { Config } from '../lib/config.js';
import type { LarkClient } from '../lark/client.js';
import type { IncomingMessage } from '../lark/types.js';
import { isMentioningBot, stripMentions } from '../lark/parse.js';
import { parseCommand } from '../commands/parse.js';
import { helpMarkdown } from '../commands/help.js';
import { isUserAllowed, isAdmin, validateCwd, SecurityError } from '../lib/security.js';
import { SessionStore } from '../store/sessions.js';
import { WorkspaceStore } from '../store/workspaces.js';
import { runKiro } from '../kiro/runner.js';
import { CardRenderer } from '../card/renderer.js';
import type { CardContext } from '../card/schema.js';
import { ChatPipeline } from './pipeline.js';

export interface DispatcherOptions {
  config: Config;
  lark: LarkClient;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  logger: Logger;
}

export class Dispatcher {
  private readonly config: Config;
  private readonly lark: LarkClient;
  private readonly sessions: SessionStore;
  private readonly workspaces: WorkspaceStore;
  private readonly log: Logger;
  private readonly pipelines = new Map<string, ChatPipeline>();

  constructor(opts: DispatcherOptions) {
    this.config = opts.config;
    this.lark = opts.lark;
    this.sessions = opts.sessions;
    this.workspaces = opts.workspaces;
    this.log = opts.logger.child({ module: 'dispatcher' });
  }

  private getPipeline(chatId: string): ChatPipeline {
    let p = this.pipelines.get(chatId);
    if (!p) {
      p = new ChatPipeline(chatId, this.log);
      this.pipelines.set(chatId, p);
    }
    return p;
  }

  /**
   * 主入口：处理一条飞书消息。
   */
  async handle(msg: IncomingMessage): Promise<void> {
    // 1) 学习 botOpenId（第一次有人 @bot 的时候）
    if (!this.lark['botOpenIdCache' as never]) {
      // 私有字段访问不太优雅；改用 setBotOpenId 即可
      const guess = msg.mentions.find((m) => m.name?.toLowerCase().includes('kiro'))?.openId;
      if (guess) this.lark.setBotOpenId(guess);
    }

    // 2) 访问控制
    if (!isUserAllowed(msg.senderOpenId, msg.chatId, this.config)) {
      this.log.debug({ user: msg.senderOpenId, chat: msg.chatId }, 'message dropped by access control');
      return;
    }

    // 3) 群里要 @bot 才回复（除非 preferences.requireMentionInGroup=false）
    if (msg.chatType === 'group' || msg.chatType === 'topic_group') {
      if (this.config.preferences.requireMentionInGroup) {
        // 暂时还没拿到 botOpenId 的话先放过（避免漏消息）；后续 setBotOpenId 后会生效
        // 简化逻辑：mentions 不为空且没人提到 bot → 跳过
        const botMentioned = msg.mentions.some((m) =>
          (m.name ?? '').toLowerCase().includes('kiro') || (m.name ?? '').toLowerCase().includes('bot'),
        );
        if (!botMentioned && msg.mentions.length > 0) {
          this.log.debug('group message without @bot, ignored');
          return;
        }
        if (msg.mentions.length === 0) {
          this.log.debug('group message has no mentions at all, ignored (requireMentionInGroup)');
          return;
        }
      }
    }

    // 4) 仅支持 text/post 消息
    if (msg.messageType !== 'text' && msg.messageType !== 'post') {
      await this.lark.sendText(
        msg.chatId,
        `当前版本只支持文本消息，收到 ${msg.messageType} 消息已忽略。`,
      );
      return;
    }

    // 提取纯净文本（去掉 @bot mention key）
    const guessedBotOpenId =
      msg.mentions.find((m) => (m.name ?? '').toLowerCase().includes('kiro'))?.openId ?? '';
    const cleanText = stripMentions(msg, guessedBotOpenId).trim();
    if (!cleanText) {
      this.log.debug('empty text after strip, ignored');
      return;
    }

    // 5) 解析命令
    const cmd = parseCommand(cleanText);
    const session = await this.sessions.get(msg.chatId, this.config.workspace.defaultCwd);

    // 命令需要管理员权限的判断
    const needAdmin = (() => {
      if (!cmd) return false;
      switch (cmd.kind) {
        case 'cd':
        case 'ws-save':
        case 'ws-use':
        case 'ws-remove':
          return true;
        default:
          return false;
      }
    })();
    if (needAdmin && !isAdmin(msg.senderOpenId, this.config)) {
      await this.lark.sendText(msg.chatId, '❌ 此命令仅管理员可用');
      return;
    }

    // 6) 路由
    if (cmd) {
      switch (cmd.kind) {
        case 'help':
          await this.replyDoneCard(msg, helpMarkdown(), session.currentCwd);
          return;
        case 'pwd': {
          const wsName = await this.workspaceNameOf(session.currentCwd);
          const body = `**当前目录**: \`${session.currentCwd}\`${
            wsName ? `\n**工作区**: \`${wsName}\`` : ''
          }`;
          await this.replyDoneCard(msg, body, session.currentCwd, wsName);
          return;
        }
        case 'status': {
          const kiroSid = await this.sessions.getKiroSession(msg.chatId, session.currentCwd);
          const wsName = await this.workspaceNameOf(session.currentCwd);
          const body = [
            `**当前目录**: \`${session.currentCwd}\``,
            wsName ? `**工作区**: \`${wsName}\`` : null,
            `**Kiro session**: ${kiroSid ? `\`${kiroSid}\`` : '_（未建立，新对话会创建）_'}`,
            `**任务状态**: ${this.getPipeline(msg.chatId).hasActiveTask() ? '🟢 进行中' : '⚪ 空闲'}`,
          ]
            .filter(Boolean)
            .join('\n');
          await this.replyDoneCard(msg, body, session.currentCwd, wsName);
          return;
        }
        case 'new': {
          await this.sessions.clearKiroSession(msg.chatId, session.currentCwd);
          await this.replyDoneCard(
            msg,
            `✅ 已重置 \`${session.currentCwd}\` 下的会话。下次提问会新建 Kiro session。`,
            session.currentCwd,
          );
          return;
        }
        case 'stop': {
          const ok = this.getPipeline(msg.chatId).abortCurrent();
          await this.replyDoneCard(
            msg,
            ok ? '⏹️ 已发出中止信号' : '当前没有进行中的任务',
            session.currentCwd,
          );
          return;
        }
        case 'cd': {
          try {
            const abs = validateCwd(cmd.path, this.config, session.currentCwd);
            await this.sessions.setCwd(msg.chatId, abs, this.config.workspace.defaultCwd);
            const wsName = await this.workspaceNameOf(abs);
            await this.replyDoneCard(
              msg,
              `✅ 已切换到 \`${abs}\`${wsName ? `（工作区 \`${wsName}\`）` : ''}`,
              abs,
              wsName,
            );
          } catch (e) {
            const m = e instanceof SecurityError ? e.message : String((e as Error).message);
            await this.replyErrorCard(msg, m, session.currentCwd);
          }
          return;
        }
        case 'ws-list': {
          const all = await this.workspaces.list();
          const entries = Object.entries(all);
          const body = entries.length
            ? '**命名工作区**\n\n' +
              entries.map(([n, p]) => `• \`${n}\` → \`${p}\``).join('\n')
            : '_（暂无命名工作区，用 \\`/ws save <name>\\` 添加）_';
          await this.replyDoneCard(msg, body, session.currentCwd);
          return;
        }
        case 'ws-save': {
          await this.workspaces.save(cmd.name, session.currentCwd);
          await this.replyDoneCard(
            msg,
            `✅ 已保存：\`${cmd.name}\` → \`${session.currentCwd}\``,
            session.currentCwd,
            cmd.name,
          );
          return;
        }
        case 'ws-use': {
          const target = await this.workspaces.get(cmd.name);
          if (!target) {
            await this.replyErrorCard(msg, `没有名为 \`${cmd.name}\` 的工作区`, session.currentCwd);
            return;
          }
          try {
            const abs = validateCwd(target, this.config, session.currentCwd);
            await this.sessions.setCwd(msg.chatId, abs, this.config.workspace.defaultCwd);
            await this.replyDoneCard(
              msg,
              `✅ 已切换到工作区 \`${cmd.name}\` → \`${abs}\``,
              abs,
              cmd.name,
            );
          } catch (e) {
            const m = e instanceof SecurityError ? e.message : String((e as Error).message);
            await this.replyErrorCard(msg, m, session.currentCwd);
          }
          return;
        }
        case 'ws-remove': {
          const ok = await this.workspaces.remove(cmd.name);
          await this.replyDoneCard(
            msg,
            ok ? `✅ 已删除工作区 \`${cmd.name}\`` : `没有名为 \`${cmd.name}\` 的工作区`,
            session.currentCwd,
          );
          return;
        }
        case 'unknown':
          // 不识别的 /xxx 命令：原样转发给 Kiro
          break;
      }
    }

    // 7) 普通消息 / 未知命令 → 跑 Kiro
    await this.runKiroTask(msg, cleanText, session.currentCwd);
  }

  private async workspaceNameOf(cwd: string): Promise<string | undefined> {
    const all = await this.workspaces.list();
    for (const [name, p] of Object.entries(all)) {
      if (p === cwd) return name;
    }
    return undefined;
  }

  private async replyDoneCard(
    msg: IncomingMessage,
    body: string,
    cwd: string,
    wsName?: string,
  ): Promise<void> {
    const ctx: CardContext = { cwd };
    if (wsName !== undefined) ctx.workspaceName = wsName;
    const renderer = new CardRenderer({
      lark: this.lark,
      chatId: msg.chatId,
      replyToMessageId: msg.messageId,
      intervalMs: this.config.preferences.cardUpdateIntervalMs,
      logger: this.log,
      ctx,
    });
    await renderer.open('done', body);
    // 立即终止（done 卡片不需要流式）
    await renderer.finalize('done', body);
  }

  private async replyErrorCard(msg: IncomingMessage, body: string, cwd: string): Promise<void> {
    const renderer = new CardRenderer({
      lark: this.lark,
      chatId: msg.chatId,
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
   * - 在 ChatPipeline 里跑（自动 preempt）
   * - 用 CardRenderer 流式刷新卡片
   */
  private async runKiroTask(msg: IncomingMessage, prompt: string, cwd: string): Promise<void> {
    const pipeline = this.getPipeline(msg.chatId);
    const taskId = `${msg.eventId || msg.messageId}-${Date.now().toString(36)}`;
    const wsName = await this.workspaceNameOf(cwd);
    const cardCtx: CardContext = { cwd };
    if (wsName !== undefined) cardCtx.workspaceName = wsName;

    await pipeline.submit({
      id: taskId,
      run: async (signal) => {
        const renderer = new CardRenderer({
          lark: this.lark,
          chatId: msg.chatId,
          replyToMessageId: msg.messageId,
          intervalMs: this.config.preferences.cardUpdateIntervalMs,
          logger: this.log,
          ctx: cardCtx,
        });
        try {
          await renderer.open('pending', '');
        } catch (e) {
          this.log.error({ err: e }, 'failed to open card; aborting task');
          return;
        }

        const resumeId = await this.sessions.getKiroSession(msg.chatId, cwd);

        const runOpts: Parameters<typeof runKiro>[0] = {
          prompt,
          cwd,
          binPath: this.config.kiro.binPath,
          trustedTools: this.config.kiro.trustedTools,
          timeoutMs: this.config.kiro.timeoutMs,
          signal,
          onChunk: (text) => renderer.appendText(text),
        };
        if (resumeId !== undefined) runOpts.resumeId = resumeId;
        if (this.config.kiro.model !== undefined) runOpts.model = this.config.kiro.model;
        if (this.config.kiro.agent !== undefined) runOpts.agent = this.config.kiro.agent;

        let result;
        try {
          result = await runKiro(runOpts);
        } catch (e) {
          await renderer.finalize('error', `❌ Kiro 执行出错：\n\`\`\`\n${(e as Error).message}\n\`\`\``);
          return;
        }

        if (result.aborted) {
          await renderer.finalize(
            'aborted',
            (result.text || '_（已中止）_') + '\n\n_⏹️ 任务被打断_',
          );
          return;
        }
        if (result.timedOut) {
          await renderer.finalize(
            'timedout',
            (result.text || '') + `\n\n_⏱️ 超过 ${this.config.kiro.timeoutMs / 1000}s 未完成，已强制终止_`,
          );
          return;
        }
        if (result.exitCode !== 0) {
          await renderer.finalize(
            'error',
            (result.text || '') + `\n\n_⚠️ kiro-cli 退出码 ${result.exitCode}_`,
          );
          return;
        }

        // 成功：保存新 sessionId 用于续接
        if (result.newSessionId && result.newSessionId !== resumeId) {
          await this.sessions.setKiroSession(msg.chatId, cwd, result.newSessionId);
        }
        await renderer.finalize('done', result.text || '_（无回复）_');
      },
    });
  }
}
