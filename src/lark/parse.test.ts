// parseIncomingMessage / isMentioningBot / stripMentions unit tests.
// Covers text/post message extraction, chat type normalization, mentions parsing,
// and the @bot detection helpers.
import { describe, it, expect } from 'vitest';
import {
  parseIncomingMessage,
  isMentioningBot,
  stripMentions,
  messageContentToText,
  larkItemToText,
} from './parse.js';
import type { LarkMessageItem } from './types.js';

function makeRawEvent(opts: {
  messageId?: string;
  chatId?: string;
  chatType?: string;
  messageType?: string;
  content?: string;
  threadId?: string;
  parentId?: string;
  rootId?: string;
  senderOpenId?: string;
  mentions?: Array<{ key: string; openId: string; name: string }>;
  eventId?: string;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ev: any = {
    event_id: opts.eventId ?? 'evt_1',
    sender: {
      sender_id: { open_id: opts.senderOpenId ?? 'ou_sender' },
      sender_type: 'user',
    },
    message: {
      message_id: opts.messageId ?? 'om_msg1',
      create_time: '1700000000000',
      chat_id: opts.chatId ?? 'oc_chat1',
      chat_type: opts.chatType ?? 'p2p',
      message_type: opts.messageType ?? 'text',
      content: opts.content ?? '{"text":"hello"}',
    },
  };
  if (opts.threadId !== undefined) ev.message.thread_id = opts.threadId;
  if (opts.parentId !== undefined) ev.message.parent_id = opts.parentId;
  if (opts.rootId !== undefined) ev.message.root_id = opts.rootId;
  if (opts.mentions !== undefined) {
    ev.message.mentions = opts.mentions.map((m) => ({
      key: m.key,
      id: { open_id: m.openId },
      name: m.name,
    }));
  }
  return ev;
}

describe('parseIncomingMessage', () => {
  describe('basic shape', () => {
    it('extracts top-level fields', () => {
      const ev = makeRawEvent({});
      const m = parseIncomingMessage(ev);
      expect(m.eventId).toBe('evt_1');
      expect(m.messageId).toBe('om_msg1');
      expect(m.chatId).toBe('oc_chat1');
      expect(m.chatType).toBe('p2p');
      expect(m.senderOpenId).toBe('ou_sender');
      expect(m.messageType).toBe('text');
      expect(m.text).toBe('hello');
      expect(m.mentions).toEqual([]);
      expect(typeof m.receivedAt).toBe('number');
    });

    it('rawContent preserved', () => {
      const content = '{"text":"hello world"}';
      const ev = makeRawEvent({ content });
      const m = parseIncomingMessage(ev);
      expect(m.rawContent).toBe(content);
    });

    it('threadId carried through when present', () => {
      const ev = makeRawEvent({ threadId: 'omt_abc' });
      const m = parseIncomingMessage(ev);
      expect(m.threadId).toBe('omt_abc');
    });

    it('threadId omitted when absent', () => {
      const ev = makeRawEvent({});
      const m = parseIncomingMessage(ev);
      expect(m.threadId).toBeUndefined();
    });

    it('parentId extracted when present (quoted reply)', () => {
      const m = parseIncomingMessage(makeRawEvent({ parentId: 'om_parent' }));
      expect(m.parentId).toBe('om_parent');
    });

    it('rootId extracted when present', () => {
      const m = parseIncomingMessage(makeRawEvent({ rootId: 'om_root' }));
      expect(m.rootId).toBe('om_root');
    });

    it('parentId/rootId omitted when absent or empty', () => {
      const m1 = parseIncomingMessage(makeRawEvent({}));
      expect(m1.parentId).toBeUndefined();
      expect(m1.rootId).toBeUndefined();
      const m2 = parseIncomingMessage(makeRawEvent({ parentId: '', rootId: '' }));
      expect(m2.parentId).toBeUndefined();
      expect(m2.rootId).toBeUndefined();
    });
  });

  describe('chat type normalization', () => {
    it('p2p stays p2p', () => {
      const m = parseIncomingMessage(makeRawEvent({ chatType: 'p2p' }));
      expect(m.chatType).toBe('p2p');
    });

    it('group stays group', () => {
      const m = parseIncomingMessage(makeRawEvent({ chatType: 'group' }));
      expect(m.chatType).toBe('group');
    });

    it('topic_group stays topic_group', () => {
      const m = parseIncomingMessage(makeRawEvent({ chatType: 'topic_group' }));
      expect(m.chatType).toBe('topic_group');
    });

    it('unknown values map to "unknown"', () => {
      const m = parseIncomingMessage(makeRawEvent({ chatType: 'something_else' }));
      expect(m.chatType).toBe('unknown');
    });
  });

  describe('text extraction for text messages', () => {
    it('extracts plain text', () => {
      const m = parseIncomingMessage(
        makeRawEvent({ messageType: 'text', content: '{"text":"hi there"}' }),
      );
      expect(m.text).toBe('hi there');
    });

    it('returns empty string for invalid JSON', () => {
      const m = parseIncomingMessage(makeRawEvent({ messageType: 'text', content: 'not-json' }));
      expect(m.text).toBe('');
    });

    it('returns empty string when text field missing', () => {
      const m = parseIncomingMessage(
        makeRawEvent({ messageType: 'text', content: '{"other":"x"}' }),
      );
      expect(m.text).toBe('');
    });
  });

  describe('text extraction for post messages', () => {
    it('extracts title plus paragraph text segments', () => {
      const post = {
        title: 'Title',
        content: [
          [
            { tag: 'text', text: 'first ' },
            { tag: 'text', text: 'second' },
          ],
          [{ tag: 'text', text: 'third' }],
        ],
      };
      const m = parseIncomingMessage(
        makeRawEvent({ messageType: 'post', content: JSON.stringify(post) }),
      );
      expect(m.text).toBe('Title first  second third');
    });

    it('translates @user segments', () => {
      const post = {
        content: [
          [
            { tag: 'text', text: 'hi ' },
            { tag: 'at', user_id: 'ou_alice' },
          ],
        ],
      };
      const m = parseIncomingMessage(
        makeRawEvent({ messageType: 'post', content: JSON.stringify(post) }),
      );
      expect(m.text).toBe('hi  @ou_alice');
    });

    it('returns empty when content missing', () => {
      const m = parseIncomingMessage(makeRawEvent({ messageType: 'post', content: '{}' }));
      expect(m.text).toBe('');
    });
  });

  describe('non-text message types', () => {
    it('image returns empty text', () => {
      const m = parseIncomingMessage(
        makeRawEvent({ messageType: 'image', content: '{"image_key":"img_1"}' }),
      );
      expect(m.text).toBe('');
      expect(m.messageType).toBe('image');
      expect(m.rawContent).toBe('{"image_key":"img_1"}');
    });

    it('file returns empty text', () => {
      const m = parseIncomingMessage(
        makeRawEvent({ messageType: 'file', content: '{"file_key":"f_1"}' }),
      );
      expect(m.text).toBe('');
    });
  });

  describe('mentions parsing', () => {
    it('collects mention entries with open_id and name', () => {
      const m = parseIncomingMessage(
        makeRawEvent({
          mentions: [
            { key: '@_user_1', openId: 'ou_x', name: 'Alice' },
            { key: '@_user_2', openId: 'ou_y', name: 'Bob' },
          ],
        }),
      );
      expect(m.mentions).toEqual([
        { key: '@_user_1', openId: 'ou_x', name: 'Alice' },
        { key: '@_user_2', openId: 'ou_y', name: 'Bob' },
      ]);
    });

    it('empty mentions array when raw is missing', () => {
      const m = parseIncomingMessage(makeRawEvent({}));
      expect(m.mentions).toEqual([]);
    });
  });

  describe('eventId fallback', () => {
    it('missing event_id becomes empty string', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev: any = makeRawEvent({});
      delete ev.event_id;
      const m = parseIncomingMessage(ev);
      expect(m.eventId).toBe('');
    });
  });

  describe('senderOpenId fallback', () => {
    it('missing sender_id.open_id becomes empty string', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev: any = makeRawEvent({});
      ev.sender = { sender_type: 'user' };
      const m = parseIncomingMessage(ev);
      expect(m.senderOpenId).toBe('');
    });
  });
});

describe('isMentioningBot', () => {
  it('returns true when bot openId is in mentions', () => {
    const msg = parseIncomingMessage(
      makeRawEvent({
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bot' }],
      }),
    );
    expect(isMentioningBot(msg, 'ou_bot')).toBe(true);
  });

  it('returns false when bot openId is not mentioned', () => {
    const msg = parseIncomingMessage(
      makeRawEvent({
        mentions: [{ key: '@_user_1', openId: 'ou_other', name: 'Other' }],
      }),
    );
    expect(isMentioningBot(msg, 'ou_bot')).toBe(false);
  });

  it('returns false when mentions empty', () => {
    const msg = parseIncomingMessage(makeRawEvent({}));
    expect(isMentioningBot(msg, 'ou_bot')).toBe(false);
  });

  it('returns false when botOpenId is empty', () => {
    const msg = parseIncomingMessage(
      makeRawEvent({
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bot' }],
      }),
    );
    expect(isMentioningBot(msg, '')).toBe(false);
  });
});

describe('stripMentions', () => {
  it('removes all bot mention keys from text', () => {
    const msg = parseIncomingMessage(
      makeRawEvent({
        content: '{"text":"@_user_1 hello @_user_1 world"}',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bot' }],
      }),
    );
    expect(stripMentions(msg, 'ou_bot')).toBe('hello  world');
  });

  it('leaves non-bot mentions intact', () => {
    const msg = parseIncomingMessage(
      makeRawEvent({
        content: '{"text":"@_user_1 hi @_user_2"}',
        mentions: [
          { key: '@_user_1', openId: 'ou_bot', name: 'Bot' },
          { key: '@_user_2', openId: 'ou_alice', name: 'Alice' },
        ],
      }),
    );
    expect(stripMentions(msg, 'ou_bot')).toBe('hi @_user_2');
  });

  it('returns trimmed text when no mentions match', () => {
    const msg = parseIncomingMessage(
      makeRawEvent({
        content: '{"text":"  hello  "}',
      }),
    );
    expect(stripMentions(msg, 'ou_bot')).toBe('hello');
  });
});

describe('messageContentToText', () => {
  it('extracts text message content', () => {
    expect(messageContentToText('text', '{"text":"hi"}')).toBe('hi');
  });

  it('extracts post title + segments', () => {
    const post = JSON.stringify({
      title: 'T',
      content: [
        [
          { tag: 'text', text: 'a' },
          { tag: 'text', text: 'b' },
        ],
      ],
    });
    expect(messageContentToText('post', post)).toBe('T a b');
  });

  it('returns empty for non text/post types', () => {
    expect(messageContentToText('image', '{"image_key":"x"}')).toBe('');
  });

  it('returns empty for invalid json', () => {
    expect(messageContentToText('text', 'nope')).toBe('');
  });
});

describe('larkItemToText', () => {
  function makeItem(over: Partial<LarkMessageItem>): LarkMessageItem {
    return {
      messageId: 'om_x',
      msgType: 'text',
      content: '{"text":"hello"}',
      mentions: [],
      ...over,
    };
  }

  it('renders text content', () => {
    expect(larkItemToText(makeItem({}))).toBe('hello');
  });

  it('replaces @_user_N placeholders with real names', () => {
    const item = makeItem({
      content: '{"text":"@_user_1 看下这个"}',
      mentions: [{ key: '@_user_1', name: '张伟' }],
    });
    expect(larkItemToText(item)).toBe('@张伟 看下这个');
  });

  it('falls back to placeholder for image type', () => {
    expect(larkItemToText(makeItem({ msgType: 'image', content: '{"image_key":"k"}' }))).toBe(
      '[图片]',
    );
  });

  it('falls back to placeholder for file type', () => {
    expect(larkItemToText(makeItem({ msgType: 'file', content: '{"file_key":"k"}' }))).toBe(
      '[文件]',
    );
  });

  it('returns empty string for unknown non-text type', () => {
    expect(larkItemToText(makeItem({ msgType: 'location', content: '{}' }))).toBe('');
  });

  it('extracts markdown body from interactive card, skipping panels/buttons/status', () => {
    // 模拟 runRenderer 产出的 schema 2.0 卡片：含思考折叠面板、工具折叠面板、
    // 正文 markdown、底部状态行和终止按钮。只应抽出正文。
    const card = {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '✅ Kiro' }, template: 'green' },
      body: {
        elements: [
          {
            tag: 'collapsible_panel',
            header: { title: { tag: 'markdown', content: '🧠 思考完成' } },
            elements: [{ tag: 'markdown', content: '我在想该怎么回答' }],
          },
          {
            tag: 'collapsible_panel',
            header: { title: { tag: 'markdown', content: '☕ 3 个工具调用' } },
            elements: [{ tag: 'markdown', content: '- 📖 读取 x.md' }],
          },
          { tag: 'markdown', content: '这是一个**会议议程**，对方在跟 Jacky 开会。' },
          { tag: 'markdown', content: "<font color='grey'>🧰 正在调用工具</font>" },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⏹ 终止' },
          },
        ],
      },
    };
    const out = larkItemToText(makeItem({ msgType: 'interactive', content: JSON.stringify(card) }));
    expect(out).toBe('这是一个**会议议程**，对方在跟 Jacky 开会。');
  });

  it('returns empty for interactive card with only placeholder/status text', () => {
    const card = {
      schema: '2.0',
      body: {
        elements: [{ tag: 'markdown', content: "<font color='grey'>（未返回内容）</font>" }],
      },
    };
    expect(
      larkItemToText(makeItem({ msgType: 'interactive', content: JSON.stringify(card) })),
    ).toBe('');
  });

  it('joins multiple markdown body blocks', () => {
    const card = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: '第一段' },
          { tag: 'markdown', content: '第二段' },
        ],
      },
    };
    expect(
      larkItemToText(makeItem({ msgType: 'interactive', content: JSON.stringify(card) })),
    ).toBe('第一段\n第二段');
  });
});
