import type { ConversationKind, NormalizedCardAction, NormalizedMessage } from '../types.js';

const SLACK_CHANNEL = 'slack' as const;

function conversationKind(channelId: string): ConversationKind {
  if (channelId.startsWith('D')) return 'p2p';
  if (channelId.startsWith('G') || channelId.startsWith('C')) return 'group';
  return 'unknown';
}

/** 去掉 Slack mention 标记，保留可读文本。 */
export function slackTextToPlain(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/g, '')
    .replace(/<#[A-Z0-9]+\|[^>]+>/g, '')
    .trim();
}

export function fromSlackMessage(
  event: {
    type: string;
    subtype?: string;
    channel?: string;
    ts?: string;
    user?: string;
    text?: string;
    thread_ts?: string;
    bot_id?: string;
  },
  eventId: string,
): NormalizedMessage | null {
  if (event.subtype && event.subtype !== 'file_share') return null;
  if ('bot_id' in event && event.bot_id) return null;
  if (!event.channel || !event.ts || !event.user) return null;

  const rawText = event.text ?? '';
  const text = slackTextToPlain(rawText);
  if (!text && event.subtype !== 'file_share') return null;

  const threadTs = event.thread_ts;
  return {
    channel: SLACK_CHANNEL,
    eventId,
    messageId: event.ts,
    conversationId: event.channel,
    parentId: threadTs && threadTs !== event.ts ? threadTs : undefined,
    rootId: threadTs,
    threadId: threadTs,
    conversationKind: conversationKind(event.channel),
    senderPrincipalId: event.user,
    messageType: event.subtype ?? 'text',
    rawContent: JSON.stringify({ text: rawText }),
    text,
    mentions: [],
    receivedAt: Date.now(),
  };
}

export function fromSlackBlockAction(
  body: {
    channel?: { id?: string };
    message?: { ts?: string };
    user?: { id?: string };
  },
  action: { type: string; value?: string },
): NormalizedCardAction | null {
  const channel = body.channel?.id;
  const messageId = body.message?.ts;
  const user = body.user?.id;
  if (!channel || !messageId || !user) return null;

  let value: Record<string, unknown> = {};
  if (action.type === 'button') {
    try {
      value = JSON.parse(action.value ?? '{}') as Record<string, unknown>;
    } catch {
      value = { raw: action.value ?? '' };
    }
  }

  return {
    channel: SLACK_CHANNEL,
    messageId,
    conversationId: channel,
    senderPrincipalId: user,
    value,
    receivedAt: Date.now(),
  };
}
