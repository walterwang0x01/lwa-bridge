/**
 * 「定时任务表单 → cron 5 段」转换器
 *
 * 服务于 /schedule new 的可视化创建流程。表单字段按 6 种频率分组：
 *   - daily        每天 H:M
 *   - weekday      工作日（周一到周五）H:M
 *   - weekly       每周指定的几个星期 H:M
 *   - monthly      每月 D 号 H:M
 *   - once         一次性，YYYY-MM-DD 的 H:M（搭配 store 的 runOnce 自删）
 *   - custom       直接给标准 cron 5 段（兜底给工程师）
 *
 * 设计取舍：
 *   - 不用 Date 库，简单算术 + 正则即可
 *   - 不做"节假日"调整（中国法定假日规则太复杂，先不进表单）
 *   - "once" 只校验日期不在过去（精度到日）；当天选小时已过去也允许（用户自己负责）
 *   - 错误用 union type 返回，不抛异常（调用方更好处理）
 */
import { parseExpression } from './expression.js';

export type ScheduleFrequency = 'daily' | 'weekday' | 'weekly' | 'monthly' | 'once' | 'custom';

/**
 * 表单原始字段。所有可选字段是否被读取由 frequency 决定。
 * 调用方（dispatcher）从飞书 form_value 拼出这个对象。
 */
export interface ScheduleForm {
  frequency: ScheduleFrequency;
  /** 0-23，custom 频率下不读 */
  hour?: number;
  /** 0-59，custom 频率下不读 */
  minute?: number;
  /** weekly 频率必填：cron 风格 0=周日, 1=周一, ..., 6=周六。允许重复，会去重 */
  weekdays?: number[];
  /** monthly 频率必填：1-31 */
  dayOfMonth?: number;
  /** once 频率必填：YYYY-MM-DD（本地时区） */
  date?: string;
  /** custom 频率必填：cron 5 段或 @shorthand */
  expression?: string;
}

export interface ScheduleConvertOk {
  ok: true;
  expression: string;
  description: string;
  /** once 频率为 true，dispatcher 据此把 store.create 的 runOnce 设成 true */
  runOnce: boolean;
}

export interface ScheduleConvertError {
  ok: false;
  error: string;
}

export type ScheduleConvertResult = ScheduleConvertOk | ScheduleConvertError;

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MONTH_NAMES = [
  '1 月',
  '2 月',
  '3 月',
  '4 月',
  '5 月',
  '6 月',
  '7 月',
  '8 月',
  '9 月',
  '10 月',
  '11 月',
  '12 月',
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 校验 0-23 整数 */
function checkHour(h: unknown): h is number {
  return typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23;
}

/** 校验 0-59 整数 */
function checkMinute(m: unknown): m is number {
  return typeof m === 'number' && Number.isInteger(m) && m >= 0 && m <= 59;
}

/** 校验 1-31 整数 */
function checkDayOfMonth(d: unknown): d is number {
  return typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 31;
}

/** YYYY-MM-DD 解析与校验，失败返回 null */
function parseDate(s: unknown): { year: number; month: number; day: number } | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // 用 Date 反向校验合法性（避免 2026-02-30 这种）
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() + 1 !== month || d.getDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/**
 * 把 ScheduleForm 转成 cron 5 段表达式 + 人类可读 description。
 *
 * 注入 now 是为了测试"once 不能选过去"的逻辑。生产代码默认用 Date.now()。
 */
export function formToCron(form: ScheduleForm, now: Date = new Date()): ScheduleConvertResult {
  switch (form.frequency) {
    case 'daily': {
      if (!checkHour(form.hour)) return { ok: false, error: '小时必须是 0-23 的整数' };
      if (!checkMinute(form.minute)) return { ok: false, error: '分钟必须是 0-59 的整数' };
      return {
        ok: true,
        expression: `${form.minute} ${form.hour} * * *`,
        description: `每天 ${pad2(form.hour)}:${pad2(form.minute)}`,
        runOnce: false,
      };
    }
    case 'weekday': {
      if (!checkHour(form.hour)) return { ok: false, error: '小时必须是 0-23 的整数' };
      if (!checkMinute(form.minute)) return { ok: false, error: '分钟必须是 0-59 的整数' };
      return {
        ok: true,
        expression: `${form.minute} ${form.hour} * * 1-5`,
        description: `工作日 ${pad2(form.hour)}:${pad2(form.minute)}`,
        runOnce: false,
      };
    }
    case 'weekly': {
      if (!checkHour(form.hour)) return { ok: false, error: '小时必须是 0-23 的整数' };
      if (!checkMinute(form.minute)) return { ok: false, error: '分钟必须是 0-59 的整数' };
      if (!form.weekdays || form.weekdays.length === 0) {
        return { ok: false, error: '请至少选一个星期' };
      }
      // 去重 + 校验范围 + 排序
      const set = new Set<number>();
      for (const d of form.weekdays) {
        if (!Number.isInteger(d) || d < 0 || d > 6) {
          return { ok: false, error: `星期值非法：${d}（应为 0-6）` };
        }
        set.add(d);
      }
      const sorted = [...set].sort((a, b) => a - b);
      const desc =
        sorted.length === 7 ? '每天' : `每周 ${sorted.map((d) => WEEKDAY_NAMES[d]).join('/')}`;
      return {
        ok: true,
        expression: `${form.minute} ${form.hour} * * ${sorted.join(',')}`,
        description: `${desc} ${pad2(form.hour)}:${pad2(form.minute)}`,
        runOnce: false,
      };
    }
    case 'monthly': {
      if (!checkHour(form.hour)) return { ok: false, error: '小时必须是 0-23 的整数' };
      if (!checkMinute(form.minute)) return { ok: false, error: '分钟必须是 0-59 的整数' };
      if (!checkDayOfMonth(form.dayOfMonth)) {
        return { ok: false, error: '日必须是 1-31 的整数' };
      }
      const note = form.dayOfMonth > 28 ? '（不存在的月份会跳过）' : '';
      return {
        ok: true,
        expression: `${form.minute} ${form.hour} ${form.dayOfMonth} * *`,
        description: `每月 ${form.dayOfMonth} 号 ${pad2(form.hour)}:${pad2(form.minute)}${note}`,
        runOnce: false,
      };
    }
    case 'once': {
      if (!checkHour(form.hour)) return { ok: false, error: '小时必须是 0-23 的整数' };
      if (!checkMinute(form.minute)) return { ok: false, error: '分钟必须是 0-59 的整数' };
      const parsed = parseDate(form.date);
      if (!parsed) return { ok: false, error: '日期格式应为 YYYY-MM-DD' };
      const target = new Date(
        parsed.year,
        parsed.month - 1,
        parsed.day,
        form.hour,
        form.minute,
        0,
        0,
      );
      if (target.getTime() <= now.getTime()) {
        return { ok: false, error: '日期时间不能在过去' };
      }
      // cron 5 段：minute hour day month *  （* = 任意星期）
      return {
        ok: true,
        expression: `${form.minute} ${form.hour} ${parsed.day} ${parsed.month} *`,
        description: `${MONTH_NAMES[parsed.month - 1]}${parsed.day} 日 ${pad2(form.hour)}:${pad2(form.minute)}（一次）`,
        runOnce: true,
      };
    }
    case 'custom': {
      if (typeof form.expression !== 'string' || !form.expression.trim()) {
        return { ok: false, error: '请输入 cron 表达式' };
      }
      const parsed = parseExpression(form.expression);
      if (parsed.kind === 'unknown') {
        return { ok: false, error: `无法解析：${form.expression}` };
      }
      return {
        ok: true,
        expression: parsed.expression,
        description: parsed.description,
        runOnce: false,
      };
    }
    default: {
      // 编译期穷尽，运行时兜底
      const _exhaustive: never = form.frequency;
      return { ok: false, error: `未知频率：${String(_exhaustive)}` };
    }
  }
}
