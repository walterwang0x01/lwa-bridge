/**
 * 列出 Kiro 全局 agents（~/.kiro/agents/<name>.json），给 dashboard 和 /agent 命令使用。
 *
 * 只读。单个 agent 解析失败不影响其它（容错原则同 dashboard/skills.ts）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export interface AgentSummary {
  /** 文件名去掉 .json */
  name: string;
  /** prompt 字段前 80 字符，无 prompt 则 "（无描述）" */
  promptPreview: string;
}

const AGENTS_DIR = join(homedir(), '.kiro', 'agents');

/**
 * 列出全局 agents。目录不存在返回空数组。
 */
export function listGlobalAgents(): AgentSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(AGENTS_DIR);
  } catch {
    return [];
  }

  const out: AgentSummary[] = [];
  for (const file of entries) {
    if (file.startsWith('.')) continue;
    if (!file.endsWith('.json')) continue;
    // 跳过 .example 文件
    if (file.endsWith('.example') || file.endsWith('.example.json')) continue;
    const filePath = join(AGENTS_DIR, file);
    try {
      if (!statSync(filePath).isFile()) continue;
      const content = readFileSync(filePath, 'utf-8');
      const obj = JSON.parse(content) as { prompt?: string };
      const name = basename(file, '.json');
      const promptPreview = obj.prompt ? obj.prompt.slice(0, 80) : '（无描述）';
      out.push({ name, promptPreview });
    } catch {
      // 解析失败也列出来，标注状态
      out.push({ name: basename(file, '.json'), promptPreview: '⚠️ 解析失败' });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
