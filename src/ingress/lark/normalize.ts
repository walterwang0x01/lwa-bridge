import type { CardActionEvent, IncomingMessage, LarkMessageItem } from '../../lark/types.js';
import type {
  ChannelId,
  ConversationKind,
  NormalizedCardAction,
  NormalizedMessage,
  NormalizedMessageItem,
} from '../types.js';

const LARK_CHANNEL: ChannelId = 'lark';

function mapConversationKind(chatType: IncomingMessage['chatType']): ConversationKind {
  return chatType;
}

export function fromLarkMessage(msg: IncomingMessage): NormalizedMessage {
  return {
    channel: LARK_CHANNEL,
    eventId: msg.eventId,
    messageId: msg.messageId,
    conversationId: msg.chatId,
    parentId: msg.parentId,
    rootId: msg.rootId,
    threadId: msg.threadId,
    conversationKind: mapConversationKind(msg.chatType),
    senderPrincipalId: msg.senderOpenId,
    messageType: msg.messageType,
    rawContent: msg.rawContent,
    text: msg.text,
    mentions: msg.mentions.map((m) => ({
      key: m.key,
      principalId: m.openId,
      name: m.name,
    })),
    receivedAt: msg.receivedAt,
  };
}

export function fromLarkCardAction(evt: CardActionEvent): NormalizedCardAction {
  return {
    channel: LARK_CHANNEL,
    messageId: evt.messageId,
    conversationId: evt.chatId,
    senderPrincipalId: evt.senderOpenId,
    value: evt.value,
    formValue: evt.formValue,
    token: evt.token,
    receivedAt: evt.receivedAt,
  };
}

/** 将归一化消息转回 IncomingMessage，供 dispatcher 内部沿用现有逻辑。 */
export function toIncomingMessage(msg: NormalizedMessage): IncomingMessage {
  return {
    eventId: msg.eventId,
    messageId: msg.messageId,
    chatId: msg.conversationId,
    parentId: msg.parentId,
    rootId: msg.rootId,
    threadId: msg.threadId,
    chatType: msg.conversationKind,
    senderOpenId: msg.senderPrincipalId,
    messageType: msg.messageType,
    rawContent: msg.rawContent,
    text: msg.text,
    mentions: msg.mentions.map((m) => ({
      key: m.key,
      openId: m.principalId,
      name: m.name,
    })),
    receivedAt: msg.receivedAt,
  };
}

export function toCardActionEvent(evt: NormalizedCardAction): CardActionEvent {
  return {
    messageId: evt.messageId,
    chatId: evt.conversationId,
    senderOpenId: evt.senderPrincipalId,
    value: evt.value,
    formValue: evt.formValue,
    token: evt.token,
    receivedAt: evt.receivedAt,
  };
}

export function fromLarkMessageItem(item: LarkMessageItem): NormalizedMessageItem {
  return {
    messageId: item.messageId,
    upperMessageId: item.upperMessageId,
    msgType: item.msgType,
    senderName: item.senderName,
    senderType: item.senderType,
    content: item.content,
    mentions: item.mentions,
  };
}
