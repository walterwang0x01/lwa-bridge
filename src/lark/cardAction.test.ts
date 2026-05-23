/**
 * parseCardAction 单元测试
 *
 * 覆盖：
 *   - v2 嵌套结构（event.operator / event.action / event.context）
 *   - 旧版平铺结构兜底
 *   - snake_case / camelCase open_id 兼容
 *   - 缺失关键字段时返回 null
 *   - value 不是 object 时返回空对象（不让上层崩）
 *   - token 字段可选
 */
import { describe, it, expect } from 'vitest';
import { parseCardAction } from './cardAction.js';

describe('parseCardAction', () => {
  describe('v2 嵌套结构', () => {
    it('完整 v2 payload 解析成功', () => {
      const raw = {
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          operator: { open_id: 'ou_user1', user_id: 'usr_1', name: 'Alice' },
          token: 'c-abc123',
          action: { tag: 'button', value: { action: 'model.set', name: 'claude' } },
          context: { open_message_id: 'om_msg1', open_chat_id: 'oc_chat1' },
        },
      };
      const result = parseCardAction(raw);
      expect(result).not.toBeNull();
      expect(result!.messageId).toBe('om_msg1');
      expect(result!.chatId).toBe('oc_chat1');
      expect(result!.senderOpenId).toBe('ou_user1');
      expect(result!.value).toEqual({ action: 'model.set', name: 'claude' });
      expect(result!.token).toBe('c-abc123');
      expect(typeof result!.receivedAt).toBe('number');
    });

    it('token 缺失时不写入字段', () => {
      const raw = {
        event: {
          operator: { open_id: 'ou_x' },
          action: { tag: 'button', value: { action: 'noop' } },
          context: { open_message_id: 'om_x', open_chat_id: 'oc_x' },
        },
      };
      const result = parseCardAction(raw);
      expect(result).not.toBeNull();
      expect(result!.token).toBeUndefined();
    });
  });

  describe('camelCase 兼容', () => {
    it('operator.openId 也能识别', () => {
      const raw = {
        event: {
          operator: { openId: 'ou_camel' },
          action: { tag: 'button', value: {} },
          context: { open_message_id: 'om_x', open_chat_id: 'oc_x' },
        },
      };
      const result = parseCardAction(raw);
      expect(result).not.toBeNull();
      expect(result!.senderOpenId).toBe('ou_camel');
    });

    it('snake_case 优先于 camelCase（同时存在）', () => {
      const raw = {
        event: {
          operator: { open_id: 'ou_snake', openId: 'ou_camel' },
          action: { value: {} },
          context: { open_message_id: 'om_x', open_chat_id: 'oc_x' },
        },
      };
      const result = parseCardAction(raw);
      expect(result!.senderOpenId).toBe('ou_snake');
    });
  });

  describe('平铺结构兜底（旧版）', () => {
    it('字段直接平铺在顶层', () => {
      const raw = {
        operator: { open_id: 'ou_flat' },
        token: 'c-flat',
        action: { value: { x: 1 } },
        open_message_id: 'om_flat',
        open_chat_id: 'oc_flat',
      };
      const result = parseCardAction(raw);
      expect(result).not.toBeNull();
      expect(result!.messageId).toBe('om_flat');
      expect(result!.chatId).toBe('oc_flat');
      expect(result!.senderOpenId).toBe('ou_flat');
      expect(result!.value).toEqual({ x: 1 });
      expect(result!.token).toBe('c-flat');
    });

    it('event 内平铺 open_message_id（不在 context 里）', () => {
      const raw = {
        event: {
          operator: { open_id: 'ou_x' },
          action: { value: {} },
          open_message_id: 'om_inevent',
          open_chat_id: 'oc_inevent',
        },
      };
      const result = parseCardAction(raw);
      expect(result!.messageId).toBe('om_inevent');
      expect(result!.chatId).toBe('oc_inevent');
    });
  });

  describe('value 类型容错', () => {
    it('value 是 string 时给空对象', () => {
      const raw = {
        event: {
          operator: { open_id: 'ou_x' },
          action: { value: 'not an object' },
          context: { open_message_id: 'om_x', open_chat_id: 'oc_x' },
        },
      };
      const result = parseCardAction(raw);
      expect(result!.value).toEqual({});
    });

    it('value 是 array 时给空对象', () => {
      const raw = {
        event: {
          operator: { open_id: 'ou_x' },
          action: { value: [1, 2, 3] },
          context: { open_message_id: 'om_x', open_chat_id: 'oc_x' },
        },
      };
      const result = parseCardAction(raw);
      expect(result!.value).toEqual({});
    });

    it('value 是 null 时给空对象', () => {
      const raw = {
        event: {
          operator: { open_id: 'ou_x' },
          action: { value: null },
          context: { open_message_id: 'om_x', open_chat_id: 'oc_x' },
        },
      };
      const result = parseCardAction(raw);
      expect(result!.value).toEqual({});
    });

    it('action 完全缺失时给空对象', () => {
      const raw = {
        event: {
          operator: { open_id: 'ou_x' },
          context: { open_message_id: 'om_x', open_chat_id: 'oc_x' },
        },
      };
      const result = parseCardAction(raw);
      expect(result!.value).toEqual({});
    });
  });

  describe('返回 null 的情况', () => {
    it('null 输入', () => {
      expect(parseCardAction(null)).toBeNull();
    });

    it('undefined 输入', () => {
      expect(parseCardAction(undefined)).toBeNull();
    });

    it('非 object 输入', () => {
      expect(parseCardAction('foo')).toBeNull();
      expect(parseCardAction(42)).toBeNull();
      expect(parseCardAction(true)).toBeNull();
    });

    it('缺少 messageId', () => {
      const raw = {
        event: {
          operator: { open_id: 'ou_x' },
          action: { value: {} },
          context: { open_chat_id: 'oc_x' },
        },
      };
      expect(parseCardAction(raw)).toBeNull();
    });

    it('缺少 chatId', () => {
      const raw = {
        event: {
          operator: { open_id: 'ou_x' },
          action: { value: {} },
          context: { open_message_id: 'om_x' },
        },
      };
      expect(parseCardAction(raw)).toBeNull();
    });

    it('缺少 senderOpenId', () => {
      const raw = {
        event: {
          operator: {},
          action: { value: {} },
          context: { open_message_id: 'om_x', open_chat_id: 'oc_x' },
        },
      };
      expect(parseCardAction(raw)).toBeNull();
    });

    it('空对象', () => {
      expect(parseCardAction({})).toBeNull();
    });
  });
});
