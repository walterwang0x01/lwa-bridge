// loadConfig 单元测试，重点覆盖 modelRouting.cursor.model 的默认值与历史占位符清洗。
// 用 LWA_HOME 环境变量重定向数据目录，避免触碰用户真实 ~/.lwa/。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpHome: string;
let prevLwaHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'lwa-config-test-'));
  prevLwaHome = process.env['LWA_HOME'];
  process.env['LWA_HOME'] = tmpHome;
});

afterEach(() => {
  if (prevLwaHome === undefined) delete process.env['LWA_HOME'];
  else process.env['LWA_HOME'] = prevLwaHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

async function freshConfigModule() {
  // vi.resetModules 保证每个测试拿到基于当前 LWA_HOME 重新计算路径的模块实例
  const vitest = await import('vitest');
  vitest.vi.resetModules();
  return import('./config.js');
}

function writeConfigFile(dataDir: string, body: unknown): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(body, null, 2));
}

/**
 * 复现：早期版本 modelRouting.cursor.model 的 schema 默认值是字面字符串 'Auto'。
 * 用户的 config.json 一旦被 saveConfig 落盘过，这个占位符就持久化到磁盘；
 * Cursor Agent 收到 --model Auto 会挂起无输出（thinking 卡死），
 * 同时状态栏把它当真实模型名显示（current model: Auto）。
 */
describe('loadConfig — modelRouting.cursor.model', () => {
  it('leaves the field undefined when the config file never set it (fresh install)', async () => {
    const { loadConfig } = await freshConfigModule();
    writeConfigFile(join(tmpHome, '.lwa'), {
      lark: { appId: 'a', appSecret: 'b' },
    });
    const cfg = loadConfig();
    expect(cfg.modelRouting.cursor.model).toBeUndefined();
  });

  it('sanitizes a legacy config.json that already persisted the literal "Auto" placeholder', async () => {
    const { loadConfig } = await freshConfigModule();
    writeConfigFile(join(tmpHome, '.lwa'), {
      lark: { appId: 'a', appSecret: 'b' },
      modelRouting: { cursor: { mode: 'fixed', model: 'Auto' } },
    });
    const cfg = loadConfig();
    // 清洗后应变回 undefined，而不是原样保留 'Auto'
    expect(cfg.modelRouting.cursor.model).toBeUndefined();
  });

  it('sanitizes case-insensitively and trims whitespace', async () => {
    const { loadConfig } = await freshConfigModule();
    writeConfigFile(join(tmpHome, '.lwa'), {
      lark: { appId: 'a', appSecret: 'b' },
      modelRouting: { cursor: { mode: 'fixed', model: '  AUTO  ' } },
    });
    const cfg = loadConfig();
    expect(cfg.modelRouting.cursor.model).toBeUndefined();
  });

  it('preserves a real, explicitly configured model name', async () => {
    const { loadConfig } = await freshConfigModule();
    writeConfigFile(join(tmpHome, '.lwa'), {
      lark: { appId: 'a', appSecret: 'b' },
      modelRouting: { cursor: { mode: 'fixed', model: 'claude-opus-4-8' } },
    });
    const cfg = loadConfig();
    expect(cfg.modelRouting.cursor.model).toBe('claude-opus-4-8');
  });
});
