// 「定时任务表单 → cron 5 段」转换器单测
import { describe, it, expect } from 'vitest';
import { formToCron, type ScheduleForm } from './scheduleForm.js';

describe('formToCron — daily', () => {
  it('每天 9:00', () => {
    const r = formToCron({ frequency: 'daily', hour: 9, minute: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expression).toBe('0 9 * * *');
      expect(r.description).toBe('每天 09:00');
      expect(r.runOnce).toBe(false);
    }
  });

  it('每天 14:30 — 分钟非 0', () => {
    const r = formToCron({ frequency: 'daily', hour: 14, minute: 30 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expression).toBe('30 14 * * *');
      expect(r.description).toBe('每天 14:30');
    }
  });

  it('小时越界报错', () => {
    const r = formToCron({ frequency: 'daily', hour: 24, minute: 0 });
    expect(r.ok).toBe(false);
  });

  it('分钟越界报错', () => {
    const r = formToCron({ frequency: 'daily', hour: 9, minute: 60 });
    expect(r.ok).toBe(false);
  });

  it('小时缺失报错', () => {
    const r = formToCron({ frequency: 'daily', minute: 0 });
    expect(r.ok).toBe(false);
  });
});

describe('formToCron — weekday', () => {
  it('工作日 9:00 → 0 9 * * 1-5', () => {
    const r = formToCron({ frequency: 'weekday', hour: 9, minute: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expression).toBe('0 9 * * 1-5');
      expect(r.description).toBe('工作日 09:00');
    }
  });
});

describe('formToCron — weekly', () => {
  it('周一周三周五 14:30', () => {
    const r = formToCron({
      frequency: 'weekly',
      hour: 14,
      minute: 30,
      weekdays: [1, 3, 5],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expression).toBe('30 14 * * 1,3,5');
      expect(r.description).toBe('每周 周一/周三/周五 14:30');
    }
  });

  it('星期会去重 + 排序', () => {
    const r = formToCron({
      frequency: 'weekly',
      hour: 9,
      minute: 0,
      weekdays: [5, 1, 3, 1, 5],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.expression).toBe('0 9 * * 1,3,5');
  });

  it('选满 7 天 → description 退化成"每天"', () => {
    const r = formToCron({
      frequency: 'weekly',
      hour: 9,
      minute: 0,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expression).toBe('0 9 * * 0,1,2,3,4,5,6');
      expect(r.description).toContain('每天');
    }
  });

  it('星期为空报错', () => {
    const r = formToCron({
      frequency: 'weekly',
      hour: 9,
      minute: 0,
      weekdays: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/至少选一个星期/);
  });

  it('星期值越界报错', () => {
    const r = formToCron({
      frequency: 'weekly',
      hour: 9,
      minute: 0,
      weekdays: [1, 7],
    });
    expect(r.ok).toBe(false);
  });

  it('星期 0=周日 处理正确', () => {
    const r = formToCron({
      frequency: 'weekly',
      hour: 10,
      minute: 0,
      weekdays: [0, 6],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.expression).toBe('0 10 * * 0,6');
  });
});

describe('formToCron — monthly', () => {
  it('每月 15 号 10:00', () => {
    const r = formToCron({
      frequency: 'monthly',
      hour: 10,
      minute: 0,
      dayOfMonth: 15,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expression).toBe('0 10 15 * *');
      expect(r.description).toBe('每月 15 号 10:00');
    }
  });

  it('29-31 号 description 带提示', () => {
    const r = formToCron({
      frequency: 'monthly',
      hour: 9,
      minute: 0,
      dayOfMonth: 31,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.description).toContain('跳过');
  });

  it('日越界报错（0）', () => {
    const r = formToCron({
      frequency: 'monthly',
      hour: 9,
      minute: 0,
      dayOfMonth: 0,
    });
    expect(r.ok).toBe(false);
  });

  it('日越界报错（32）', () => {
    const r = formToCron({
      frequency: 'monthly',
      hour: 9,
      minute: 0,
      dayOfMonth: 32,
    });
    expect(r.ok).toBe(false);
  });

  it('日缺失报错', () => {
    const r = formToCron({ frequency: 'monthly', hour: 9, minute: 0 });
    expect(r.ok).toBe(false);
  });
});

describe('formToCron — once', () => {
  // 用固定 now 让测试稳定
  const NOW = new Date('2026-05-25T10:00:00');

  it('明天 9:00 — 合法', () => {
    const r = formToCron(
      {
        frequency: 'once',
        hour: 9,
        minute: 0,
        date: '2026-05-26',
      },
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expression).toBe('0 9 26 5 *');
      expect(r.description).toContain('5 月');
      expect(r.description).toContain('一次');
      expect(r.runOnce).toBe(true);
    }
  });

  it('当天但晚于 now — 合法', () => {
    const r = formToCron(
      {
        frequency: 'once',
        hour: 18,
        minute: 0,
        date: '2026-05-25',
      },
      NOW,
    );
    expect(r.ok).toBe(true);
  });

  it('当天但早于 now — 报错', () => {
    const r = formToCron(
      {
        frequency: 'once',
        hour: 8,
        minute: 0,
        date: '2026-05-25',
      },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/过去/);
  });

  it('昨天 — 报错', () => {
    const r = formToCron(
      {
        frequency: 'once',
        hour: 23,
        minute: 59,
        date: '2026-05-24',
      },
      NOW,
    );
    expect(r.ok).toBe(false);
  });

  it('日期格式非法报错', () => {
    const r = formToCron(
      {
        frequency: 'once',
        hour: 9,
        minute: 0,
        date: '2026/05/26',
      },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/格式/);
  });

  it('2 月 30 号这种不存在日期 — 报错', () => {
    const r = formToCron(
      {
        frequency: 'once',
        hour: 9,
        minute: 0,
        date: '2026-02-30',
      },
      NOW,
    );
    expect(r.ok).toBe(false);
  });

  it('日期缺失报错', () => {
    const r = formToCron({ frequency: 'once', hour: 9, minute: 0 }, NOW);
    expect(r.ok).toBe(false);
  });
});

describe('formToCron — custom', () => {
  it('合法 cron 5 段', () => {
    const r = formToCron({
      frequency: 'custom',
      expression: '*/5 9-18 * * 1-5',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expression).toBe('*/5 9-18 * * 1-5');
      expect(r.runOnce).toBe(false);
    }
  });

  it('合法 shorthand', () => {
    const r = formToCron({
      frequency: 'custom',
      expression: '@daily',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.expression).toBe('0 0 * * *');
  });

  it('中文关键词 走 parseExpression', () => {
    const r = formToCron({
      frequency: 'custom',
      expression: '每天9点',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.expression).toBe('0 9 * * *');
  });

  it('表达式空报错', () => {
    const r = formToCron({ frequency: 'custom', expression: '' });
    expect(r.ok).toBe(false);
  });

  it('表达式缺失报错', () => {
    const r = formToCron({ frequency: 'custom' });
    expect(r.ok).toBe(false);
  });

  it('非法表达式报错', () => {
    const r = formToCron({
      frequency: 'custom',
      expression: 'not-a-cron-expression',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/无法解析/);
  });
});

describe('formToCron — 边界', () => {
  it('未知 frequency 兜底', () => {
    const r = formToCron({
      frequency: 'unknown' as ScheduleForm['frequency'],
      hour: 9,
      minute: 0,
    });
    expect(r.ok).toBe(false);
  });
});
