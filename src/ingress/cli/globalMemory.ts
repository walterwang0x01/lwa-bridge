/**
 * 全局用户记忆：~/.lwa/memory/*.md（跨项目，压缩后仍从磁盘重载）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, ensureDataDirs } from '../../lib/paths.js';

export const GLOBAL_MEMORY_DIR = join(DATA_DIR, 'memory');

export interface GlobalMemoryFile {
  name: string;
  path: string;
  content: string;
}

const DEFAULT_MAX_TOTAL = 8_000;
const DEFAULT_MAX_PER_FILE = 4_000;

export function ensureGlobalMemoryDir(): string {
  ensureDataDirs();
  if (!existsSync(GLOBAL_MEMORY_DIR)) {
    mkdirSync(GLOBAL_MEMORY_DIR, { recursive: true, mode: 0o700 });
  }
  return GLOBAL_MEMORY_DIR;
}

export function loadGlobalMemory(opts?: {
  maxTotalChars?: number;
  maxPerFile?: number;
}): GlobalMemoryFile[] {
  const dir = GLOBAL_MEMORY_DIR;
  if (!existsSync(dir)) return [];
  const maxTotal = opts?.maxTotalChars ?? DEFAULT_MAX_TOTAL;
  const maxPer = opts?.maxPerFile ?? DEFAULT_MAX_PER_FILE;
  let names: string[] = [];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith('.md') && !n.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
  const out: GlobalMemoryFile[] = [];
  let used = 0;
  for (const name of names) {
    if (used >= maxTotal) break;
    const path = join(dir, name);
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
      // ignore
    }
  }
  return out;
}

export function formatGlobalMemoryBlock(files: GlobalMemoryFile[]): string {
  if (files.length === 0) return '';
  const parts = files.map((f) => `### ~/.lwa/memory/${f.name}\n${f.content}`);
  return ['Global memory (user preferences across projects):', ...parts].join('\n\n');
}
