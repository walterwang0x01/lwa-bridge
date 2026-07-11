/**
 * 项目级持久记忆：LWA.md > AGENTS.md > CLAUDE.md（先找到的优先，可叠加截断）。
 * compact 后仍靠磁盘重载存活。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_MEMORY_FILES = ['LWA.md', 'AGENTS.md', 'CLAUDE.md'] as const;

export interface ProjectMemoryFile {
  name: string;
  path: string;
  content: string;
}

const DEFAULT_MAX_TOTAL = 12_000;
const DEFAULT_MAX_PER_FILE = 6_000;

export function loadProjectMemory(
  cwd: string,
  opts?: { maxTotalChars?: number; maxPerFile?: number },
): ProjectMemoryFile[] {
  const maxTotal = opts?.maxTotalChars ?? DEFAULT_MAX_TOTAL;
  const maxPer = opts?.maxPerFile ?? DEFAULT_MAX_PER_FILE;
  const out: ProjectMemoryFile[] = [];
  let used = 0;
  for (const name of PROJECT_MEMORY_FILES) {
    if (used >= maxTotal) break;
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    try {
      let content = readFileSync(path, 'utf-8').trim();
      if (!content) continue;
      const budget = Math.min(maxPer, maxTotal - used);
      if (content.length > budget) {
        content = `${content.slice(0, budget)}\n…[truncated]`;
      }
      out.push({ name, path, content });
      used += content.length;
    } catch {
      // ignore unreadable
    }
  }
  return out;
}

export function formatProjectMemoryBlock(files: ProjectMemoryFile[]): string {
  if (files.length === 0) return '';
  const parts = files.map((f) => `### ${f.name}\n${f.content}`);
  return ['Project memory (always follow; survives compaction):', ...parts].join('\n\n');
}
