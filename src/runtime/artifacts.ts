/**
 * Session artifacts：从 ACP/统一事件里抠文件路径，供 compact 后重读。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const PATH_KEYS = ['path', 'file_path', 'targetFile', 'filePath', 'filename', 'file'] as const;

export function extractPathsFromToolInput(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const obj = input as Record<string, unknown>;
  const out: string[] = [];
  for (const k of PATH_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  return out;
}

/** 从 ACP SessionEvent 粗提取路径（容错不同 payload 形状）。 */
export function extractPathsFromSessionEvent(ev: unknown): string[] {
  if (!ev || typeof ev !== 'object') return [];
  const e = ev as Record<string, unknown>;
  const out: string[] = [];
  const update = e['update'] ?? e['sessionUpdate'] ?? e;
  if (update && typeof update === 'object') {
    const u = update as Record<string, unknown>;
    const toolCall = u['toolCall'] ?? u['tool_call'] ?? u;
    if (toolCall && typeof toolCall === 'object') {
      const tc = toolCall as Record<string, unknown>;
      out.push(...extractPathsFromToolInput(tc['input'] ?? tc['arguments'] ?? tc['rawInput']));
      const loc = tc['locations'];
      if (Array.isArray(loc)) {
        for (const item of loc) {
          if (
            item &&
            typeof item === 'object' &&
            typeof (item as { path?: string }).path === 'string'
          ) {
            out.push((item as { path: string }).path);
          }
        }
      }
    }
  }
  out.push(...extractPathsFromToolInput(e['input']));
  return out;
}

export function normalizeArtifactPath(cwd: string, p: string): string | undefined {
  const cleaned = p.replace(/^file:\/\//, '').trim();
  if (!cleaned || cleaned.length > 512) return undefined;
  if (cleaned.includes('\n') || cleaned.includes('\0')) return undefined;
  try {
    const abs = isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
    const rel = relative(cwd, abs);
    if (rel.startsWith('..')) return abs; // outside cwd still record absolute
    return abs;
  } catch {
    return undefined;
  }
}

export function mergeFilesTouched(prev: string[] | undefined, next: string[], max = 40): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...(prev ?? []), ...next]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * compact 后重读最近触及的文件头部，注入摘要旁路上下文。
 */
export function buildFilesRereadBlock(
  cwd: string,
  files: string[],
  opts?: { maxFiles?: number; maxPerFile?: number; maxTotal?: number },
): string {
  const maxFiles = opts?.maxFiles ?? 6;
  const maxPer = opts?.maxPerFile ?? 2_500;
  const maxTotal = opts?.maxTotal ?? 12_000;
  const picked = files.slice(-maxFiles);
  if (picked.length === 0) return '';

  const parts: string[] = ['Files re-read after compact:'];
  let used = 0;
  for (const p of picked) {
    if (used >= maxTotal) break;
    const abs = normalizeArtifactPath(cwd, p) ?? p;
    if (!existsSync(abs)) {
      parts.push(`### ${shortPath(cwd, abs)}\n(missing)`);
      continue;
    }
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > 400_000) {
        parts.push(`### ${shortPath(cwd, abs)}\n(skipped: not a small file)`);
        continue;
      }
      let content = readFileSync(abs, 'utf-8');
      const budget = Math.min(maxPer, maxTotal - used);
      if (content.length > budget) content = `${content.slice(0, budget)}\n…[truncated]`;
      parts.push(`### ${shortPath(cwd, abs)}\n\`\`\`\n${content}\n\`\`\``);
      used += content.length;
    } catch {
      parts.push(`### ${shortPath(cwd, abs)}\n(unreadable)`);
    }
  }
  return parts.join('\n\n');
}

function shortPath(cwd: string, abs: string): string {
  try {
    const rel = relative(cwd, abs);
    return rel && !rel.startsWith('..') ? rel : abs;
  } catch {
    return abs;
  }
}
