/**
 * 业务层使用的精简飞书事件类型。
 * 把飞书 SDK 的复杂结构压平成 bridge 关心的字段。
 */
export type ChatType = 'p2p' | 'group' | 'topic_group' | 'unknown';

export interface IncomingMessage {
  /** 事件 id，用于去重和日志关联 */
  eventId: string;
  /** 飞书 message id */
  messageId: string;
  /** 飞书 chat id（DM 或群） */
  chatId: string;
  /** 主题群里的 thread id，普通群/DM 为 undefined */
  threadId?: string;
  /** 单聊 / 群聊 / 主题群 */
  chatType: ChatType;
  /** 发送者的 open_id（飞书租户内稳定 id） */
  senderOpenId: string;
  /** 消息类型：text、post、image、file、... */
  messageType: string;
  /** 原始 content（JSON 字符串，由飞书发来），具体结构因 messageType 而异 */
  rawContent: string;
  /** 已抽取的纯文本（仅 text/post 类型；其他类型为空字符串） */
  text: string;
  /** 是否 @ 了某个用户/机器人 */
  mentions: Array<{ key: string; openId?: string; name: string }>;
  /** 收到事件的时间戳（毫秒） */
  receivedAt: number;
}
