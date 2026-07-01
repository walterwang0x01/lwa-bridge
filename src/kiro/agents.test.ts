// listGlobalAgents 单元测试：合法 JSON 解析、非法 JSON 容错、跳过 example、排序。
//
// AGENTS_DIR 是模块顶层常量（join(homedir(), '.kiro', 'agents')），要让它读到测试用的
// 临时目录，必须在 import 模块**之前**把 HOME 指向临时目录——用动态 import 保证顺序。
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'lkb-agents-test-'));
process.env['HOME'] = TMP;

const agentsDir = join(TMP, '.kiro', 'agents');

function writeAgent(name: string, content: string): void {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, name), content, 'utf-8');
}

let listGlobalAgents: typeof import('./agents.js').listGlobalAgents;

beforeAll(async () => {
  ({ listGlobalAgents } = await import('./agents.js'));
});

describe('listGlobalAgents', () => {
  it('目录不存在时返回空数组，不抛异常', () => {
    rmSync(agentsDir, { recursive: true, force: true });
    expect(listGlobalAgents()).toEqual([]);
  });

  it('解析合法 JSON 的 prompt 前 80 字符', () => {
    rmSync(agentsDir, { recursive: true, force: true });
    writeAgent(
      'customer-service.json',
      JSON.stringify({ prompt: '你是客服专员，负责回答用户问题', tools: ['fs_read'] }),
    );
    const agents = listGlobalAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe('customer-service');
    expect(agents[0]?.promptPreview).toBe('你是客服专员，负责回答用户问题');
  });

  it('无 prompt 字段时显示（无描述）', () => {
    rmSync(agentsDir, { recursive: true, force: true });
    writeAgent('no-prompt.json', JSON.stringify({ tools: [] }));
    const agents = listGlobalAgents();
    expect(agents[0]?.promptPreview).toBe('（无描述）');
  });

  it('非法 JSON 标注解析失败但不影响其它 agent', () => {
    rmSync(agentsDir, { recursive: true, force: true });
    writeAgent('good.json', JSON.stringify({ prompt: '正常角色' }));
    writeAgent('broken.json', '{ this is not valid json');
    const agents = listGlobalAgents();
    expect(agents).toHaveLength(2);
    const good = agents.find((a) => a.name === 'good');
    const broken = agents.find((a) => a.name === 'broken');
    expect(good?.promptPreview).toBe('正常角色');
    expect(broken?.promptPreview).toBe('⚠️ 解析失败');
  });

  it('跳过 .example 文件和非 .json 文件', () => {
    rmSync(agentsDir, { recursive: true, force: true });
    writeAgent('agent_config.json.example', JSON.stringify({ prompt: 'example' }));
    writeAgent('README.md', '# not an agent');
    writeAgent('real.json', JSON.stringify({ prompt: '真实角色' }));
    const agents = listGlobalAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe('real');
  });

  it('结果按 name 排序', () => {
    rmSync(agentsDir, { recursive: true, force: true });
    writeAgent('zzz.json', JSON.stringify({ prompt: 'z' }));
    writeAgent('aaa.json', JSON.stringify({ prompt: 'a' }));
    const agents = listGlobalAgents();
    expect(agents.map((a) => a.name)).toEqual(['aaa', 'zzz']);
  });
});
