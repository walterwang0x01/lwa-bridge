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
  /** 被引用消息的 message id（用户"引用回复"时存在），用于拉取被引用原文 */
  parentId?: string;
  /** 话题/回复链根消息 id，普通消息为 undefined */
  rootId?: string;
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

/**
 * 卡片按钮回调事件（业务层格式）
 *
 * 用户点击卡片上的 button（behaviors:[{type:'callback'}]) 时，飞书会推一个
 * card.action.trigger 事件，dispatch 到这里。
 */
export interface CardActionEvent {
  /** 触发事件的 message_id（即卡片所在那条消息的 id） */
  messageId: string;
  /** chat id */
  chatId: string;
  /** 操作者的 open_id */
  senderOpenId: string;
  /**
   * 按钮 value 字段——业务层自定义结构。
   * 我们约定每个按钮都带 { action: 'model.set' | 'ws.use' | ..., ... }。
   */
  value: Record<string, unknown>;
  /**
   * 表单提交字段（仅 button 在 form 里点提交时有值）。
   * 飞书 v2 表单：每个 input 的 name 属性 → 用户输入的 value。
   */
  formValue?: Record<string, unknown>;
  /** 飞书发的 token（可用于在 30 分钟内更新原卡片，最多 2 次。当前未用，留给未来） */
  token?: string;
  /** 触发时间戳 */
  receivedAt: number;
}

/**
 * 飞书「获取指定消息内容」接口（GET /open-apis/im/v1/messages/:message_id）
 * 返回的 data.items[] 单项，业务层只关心其中一部分字段。
 *
 * 用途：
 *   - 引用回复：用 parentId 拉父消息，取首项 body.content
 *   - 合并转发：用本条 message_id 拉，items[0] 是父，其余是子消息（按时间序）
 */
export interface LarkMessageItem {
  messageId: string;
  /** 合并转发场景下指向上一级消息；首项（父）没有 */
  upperMessageId?: string;
  msgType: string;
  /** 发送者展示名（飞书在 sender.sender_name 返回，可能为空） */
  senderName?: string;
  /**
   * 发送者类型（飞书 sender.sender_type）：'app' 表示机器人/应用，'user' 表示真人。
   * 用于区分「引用 bot 自己的回复」与「引用他人消息」，注入 Kiro 时措辞不同。
   */
  senderType?: string;
  /** body.content 的 JSON 字符串，结构随 msgType 而异 */
  content: string;
  /** @_user_N 占位符 → 真实姓名 的映射表 */
  mentions: Array<{ key: string; name: string }>;
}
