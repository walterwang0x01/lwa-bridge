/**
 * 飞书消息事件解析
 *
 * 把飞书 SDK 推过来的原始 event 转成业务层 IncomingMessage。
 * 同时负责：
 *   - 抽取纯文本（text 类型直接拿 .text；post 类型遍历 content）
 *   - 把 chat_type 字符串归一化成 ChatType
 *   - 整理 mentions 数组
 */
import type { IncomingMessage, ChatType } from './types.js';

interface RawSenderId {
  union_id?: string;
  user_id?: string;
  open_id?: string;
}

interface RawMention {
  key: string;
  id: RawSenderId;
  mentioned_type?: string;
  name: string;
}

interface RawMessage {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  create_time: string;
  chat_id: string;
  thread_id?: string;
  chat_type: string;
  message_type: string;
  content: string;
  mentions?: RawMention[];
}

interface RawSender {
  sender_id?: RawSenderId;
  sender_type: string;
}

interface RawEvent {
  event_id?: string;
  sender: RawSender;
  message: RawMessage;
}

function normalizeChatType(s: string): ChatType {
  switch (s) {
    case 'p2p':
      return 'p2p';
    case 'group':
      return 'group';
    case 'topic_group':
      return 'topic_group';
    default:
      return 'unknown';
  }
}

/**
 * 从 message.content（JSON 字符串）中抽取纯文本。
 * - text 类型：{ "text": "hello @_user_1 world" }
 * - post 类型：富文本，遍历段落取 text 段
 * - 其他类型：返回空字符串
 */
function extractText(messageType: string, contentJson: string): string {
  if (messageType !== 'text' && messageType !== 'post') return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return '';
  }
  if (messageType === 'text') {
    const text = (parsed as { text?: string }).text;
    return typeof text === 'string' ? text : '';
  }
  // post：content.title + content.content[][].text
  const post = parsed as {
    title?: string;
    content?: Array<Array<{ tag?: string; text?: string; user_id?: string }>>;
  };
  const parts: string[] = [];
  if (post.title) parts.push(post.title);
  if (Array.isArray(post.content)) {
    for (const para of post.content) {
      if (!Array.isArray(para)) continue;
      for (const seg of para) {
        if (seg.tag === 'text' && typeof seg.text === 'string') {
          parts.push(seg.text);
        } else if (seg.tag === 'at' && typeof seg.user_id === 'string') {
          parts.push(`@${seg.user_id}`);
        }
      }
    }
  }
  return parts.join(' ').trim();
}

export function parseIncomingMessage(ev: RawEvent): IncomingMessage {
  const m = ev.message;
  const senderOpenId = ev.sender?.sender_id?.open_id ?? '';
  const mentions = (m.mentions ?? []).map((x) => {
    const mention: { key: string; openId?: string; name: string } = {
      key: x.key,
      name: x.name,
    };
    if (x.id.open_id !== undefined) {
      mention.openId = x.id.open_id;
    }
    return mention;
  });

  const result: IncomingMessage = {
    eventId: ev.event_id ?? '',
    messageId: m.message_id,
    chatId: m.chat_id,
    chatType: normalizeChatType(m.chat_type),
    senderOpenId,
    messageType: m.message_type,
    rawContent: m.content,
    text: extractText(m.message_type, m.content),
    mentions,
    receivedAt: Date.now(),
  };
  if (m.thread_id !== undefined) {
    result.threadId = m.thread_id;
  }
  return result;
}

/**
 * 检查消息文本里是否 @了机器人。
 * 飞书的 mention key 形如 "@_user_1"，对应到 mentions 数组。
 * 我们只关心 mentions 里有没有 open_id == botOpenId 的项。
 */
export function isMentioningBot(msg: IncomingMessage, botOpenId: string): boolean {
  if (!botOpenId) return false;
  return msg.mentions.some((m) => m.openId === botOpenId);
}

/**
 * 移除消息文本里所有 @bot 的 mention key（"@_user_1" 这种），返回净化后的文本。
 * 飞书的 mentions[i].key 就是文本里出现的占位符。
 */
export function stripMentions(msg: IncomingMessage, botOpenId: string): string {
  let text = msg.text;
  for (const m of msg.mentions) {
    if (m.openId === botOpenId) {
      text = text.split(m.key).join('');
    }
  }
  return text.trim();
}
