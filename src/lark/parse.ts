/**
 * 飞书消息事件解析
 *
 * 把飞书 SDK 推过来的原始 event 转成业务层 IncomingMessage。
 * 同时负责：
 *   - 抽取纯文本（text 类型直接拿 .text；post 类型遍历 content）
 *   - 把 chat_type 字符串归一化成 ChatType
 *   - 整理 mentions 数组
 */
import type { IncomingMessage, ChatType, LarkMessageItem } from './types.js';

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
 * 从飞书互动卡片（interactive，schema 2.0）正文里抽取纯文本。
 *
 * 前提：调用「获取指定消息内容」时带了 card_msg_content_type=user_card_content，
 * 飞书才会返回发送时的原始卡片 JSON（否则只返回降级占位符，抽不到正文）。
 *
 * bridge 的回复卡片结构见 src/card/runRenderer.ts：
 *   - 正文 = 顶层 body.elements[] 里 tag:"markdown" 的块
 *   - 噪音 = collapsible_panel（思考过程 / 工具调用 trace）、button（终止/继续按钮）、
 *     以及 footer 的灰字状态行
 *
 * 抽取策略：
 *   - 只遍历 body.elements 顶层，不递归进 collapsible_panel（避免把工具 trace 当正文）
 *   - 收集 markdown / lark_md / plain_text 节点的文本
 *   - 剥离 <font> 富文本标签、过滤「等待响应…/无输出/未返回内容」等占位文案
 *   - 过滤纯状态行（🧠 正在思考 / 🧰 正在调用工具 / ✍️ 正在输出 / ⏹ 已被中断 等）
 */
function extractCardText(contentJson: string): string {
  let card: unknown;
  try {
    card = JSON.parse(contentJson);
  } catch {
    return '';
  }
  const root = card as { body?: { elements?: unknown[] }; elements?: unknown[] };
  // schema 2.0 在 body.elements；个别 1.0 卡片在顶层 elements
  const elements = root.body?.elements ?? root.elements;
  if (!Array.isArray(elements)) return '';

  const parts: string[] = [];
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const node = el as Record<string, unknown>;
    // 只取顶层文本块；collapsible_panel / button / 其他容器一律跳过
    if ((node.tag === 'markdown' || node.tag === 'lark_md') && typeof node.content === 'string') {
      parts.push(node.content);
    } else if (node.tag === 'plain_text' && typeof node.content === 'string') {
      parts.push(node.content);
    }
  }

  // 状态/占位行过滤：这些是 runRenderer 加的装饰，不是回复正文
  const NOISE = /^(🧠|🧰|✍️|⏹|⏱|⏰|▶️|☕)/;
  const PLACEHOLDER = /^(等待响应|无输出|未返回内容|（未返回内容）)/;
  const cleaned = parts
    .map((p) => p.replace(/<\/?font[^>]*>/g, '').trim())
    .filter((p) => p && !NOISE.test(p) && !PLACEHOLDER.test(p));

  return cleaned.join('\n').trim();
}

/**
 * 从 message.content（JSON 字符串）中抽取纯文本。
 * - text 类型：{ "text": "hello @_user_1 world" }
 * - post 类型：富文本，遍历段落取 text 段
 * - interactive 类型：互动卡片，抽 body 正文（见 extractCardText）
 * - 其他类型：返回空字符串
 *
 * 同时被「接收消息事件」和「获取指定消息内容」两条链路复用：
 * 后者（引用回复 / 合并转发）的子消息 body.content 结构与前者一致。
 */
export function messageContentToText(messageType: string, contentJson: string): string {
  if (messageType === 'interactive') return extractCardText(contentJson);
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

/** 内部别名，保留原调用点可读性 */
function extractText(messageType: string, contentJson: string): string {
  return messageContentToText(messageType, contentJson);
}

/**
 * 把通过「获取指定消息内容」拿到的一条消息渲染成给 LLM 看的纯文本。
 *
 * - text/post：抽正文，并把 @_user_N 占位符替换成真实姓名（更可读）
 * - image/file/audio 等无法转文本的类型：返回一个 [图片]/[文件] 之类的占位描述
 * - 解析失败：返回空字符串（调用方决定要不要丢弃）
 */
export function larkItemToText(item: LarkMessageItem): string {
  const raw = messageContentToText(item.msgType, item.content);
  if (raw) {
    // 把 @_user_N 占位符替换成真实姓名
    let text = raw;
    for (const mt of item.mentions) {
      if (mt.key && mt.name) text = text.split(mt.key).join(`@${mt.name}`);
    }
    return text.trim();
  }
  // 非文本类型给个占位描述，至少让 LLM 知道这里有张图/一个文件
  switch (item.msgType) {
    case 'image':
      return '[图片]';
    case 'file':
      return '[文件]';
    case 'audio':
      return '[语音]';
    case 'media':
      return '[视频]';
    case 'sticker':
      return '[表情]';
    case 'merge_forward':
      return '[合并转发消息]';
    default:
      return '';
  }
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
  if (m.parent_id !== undefined && m.parent_id !== '') {
    result.parentId = m.parent_id;
  }
  if (m.root_id !== undefined && m.root_id !== '') {
    result.rootId = m.root_id;
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
