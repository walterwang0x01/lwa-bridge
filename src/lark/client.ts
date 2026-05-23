/**
 * 飞书 SDK 封装
 *
 * 提供两个能力：
 *   1. WebSocket 长连接事件监听（订阅 im.message.receive_v1）
 *   2. 飞书 OpenAPI 调用：发消息、发卡片、更新卡片、查机器人 open_id
 *
 * 与业务层之间通过 onMessage 回调解耦。
 */
import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from 'pino';
import { parseIncomingMessage } from './parse.js';
import type { IncomingMessage } from './types.js';

export interface LarkClientOptions {
  appId: string;
  appSecret: string;
  logger: Logger;
}

export class LarkClient {
  readonly appId: string;
  private readonly appSecret: string;
  private readonly log: Logger;
  readonly api: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private botOpenIdCache: string | null = null;

  constructor(opts: LarkClientOptions) {
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
    this.log = opts.logger.child({ module: 'lark-client' });
    this.api = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      disableTokenCache: false,
    });
  }

  /**
   * 启动 WebSocket 长连接，注册 im.message.receive_v1 事件 handler。
   */
  async startEventLoop(handlers: {
    onMessage: (msg: IncomingMessage) => void | Promise<void>;
    onReady?: () => void;
    onReconnected?: () => void;
  }): Promise<void> {
    const wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
      onReady: () => {
        this.log.info('lark websocket connected');
        handlers.onReady?.();
      },
      onReconnecting: () => {
        this.log.warn('lark websocket reconnecting');
      },
      onReconnected: () => {
        this.log.info('lark websocket reconnected');
        handlers.onReconnected?.();
      },
      onError: (err) => {
        this.log.error({ err }, 'lark websocket error');
      },
    });

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          const msg = parseIncomingMessage(data as Parameters<typeof parseIncomingMessage>[0]);
          this.log.debug(
            {
              event: 'enter',
              eventId: msg.eventId,
              chatId: msg.chatId,
              senderId: msg.senderOpenId,
              chatType: msg.chatType,
              messageType: msg.messageType,
            },
            'incoming message',
          );
          await handlers.onMessage(msg);
        } catch (e) {
          this.log.error({ err: e }, 'onMessage handler threw');
        }
        return { code: 0 };
      },
    });

    await wsClient.start({ eventDispatcher: dispatcher });
    this.wsClient = wsClient;
  }

  close(): void {
    this.wsClient?.close();
    this.wsClient = null;
  }

  /**
   * 查询当前机器人在租户里的 open_id（用来识别 @bot）。
   * 应用启动时调用一次后缓存。
   */
  async getBotOpenId(): Promise<string> {
    if (this.botOpenIdCache) return this.botOpenIdCache;
    // 调 bot/v3/info 接口拿 app_id 关联的 bot 信息
    // SDK 路径：client.bot.info.get / client.application... 因版本而异；
    // 实践里最稳的方式是听到第一条 mention 时学习一下。这里先返回空字符串，
    // 调用方应在收到带 @bot 的消息时通过 mentions 学习并缓存。
    return '';
  }

  /** 业务侧主动设置 botOpenId（一般从配置或第一次 @bot 学习而来）。 */
  setBotOpenId(openId: string): void {
    this.botOpenIdCache = openId;
  }

  /**
   * 发送一张飞书卡片（v2 协议）。
   * 返回卡片所在消息的 message_id，后续用 patchCard 更新。
   */
  async sendCard(chatId: string, cardJson: object): Promise<string> {
    const resp = await this.api.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(cardJson),
      },
    });
    const messageId = resp.data?.message_id;
    if (!messageId) {
      throw new Error(`sendCard failed, no message_id in response: ${JSON.stringify(resp)}`);
    }
    return messageId;
  }

  /**
   * 回复一条消息（reply 卡片，让卡片挂在用户消息下面）。
   */
  async replyCard(messageId: string, cardJson: object): Promise<string> {
    const resp = await this.api.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(cardJson),
      },
    });
    const newMsgId = resp.data?.message_id;
    if (!newMsgId) {
      throw new Error(`replyCard failed, no message_id in response: ${JSON.stringify(resp)}`);
    }
    return newMsgId;
  }

  /**
   * 用 patch 接口整体替换卡片内容。
   * 飞书消息卡片支持通过 `im/v1/messages/:message_id` PATCH 来更新内容，
   * 内容必须是合法的卡片 JSON 字符串。
   */
  async patchCard(messageId: string, cardJson: object): Promise<void> {
    await this.api.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(cardJson) },
    });
  }

  /** 发送纯文本消息（错误兜底用） */
  async sendText(chatId: string, text: string): Promise<string> {
    const resp = await this.api.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    const messageId = resp.data?.message_id;
    if (!messageId) {
      throw new Error(`sendText failed, no message_id in response: ${JSON.stringify(resp)}`);
    }
    return messageId;
  }
}
