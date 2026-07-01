/**
 * 列出 Kiro 全局 skills（~/.kiro/skills/<name>/SKILL.md），给 dashboard 只读展示。
 *
 * 只读、只解析 frontmatter 的 name/description 两个字段，不引入 YAML 解析库
 * （frontmatter 在这里的形态很规整：`key: value` 或 `key: "多行引号字符串"`，
 * 正则够用，没必要为两个字段加一个新依赖）。
 *
 * 容错：任何单个 skill 解析失败都不影响其它 skill 展示，只是这条显示为"未知"。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface SkillSummary {
  /** 目录名（skill 的 slug） */
  dir: string;
  name: string;
  description: string;
}

const SKILLS_DIR = join(homedir(), '.kiro', 'skills');

/**
 * 从 SKILL.md 的 YAML frontmatter 提取 name / description。
 * 支持三种取值形态（这批 skill 里都出现过）：
 *   name: foo
 *   description: "多行\n引号字符串"        ← 引号包裹，可跨行
 *   description: >-                         ← YAML 折叠块语法，后续缩进行拼成一段
 *     Use when the user wants to ...
 *     more text on next line
 * 不引入 YAML 解析库，用够用的正则/逐行处理。
 */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return {};
  const fm = fmMatch[1] ?? '';
  const lines = fm.split(/\r?\n/);

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const name = nameMatch?.[1]?.trim().replace(/^["']|["']$/g, '');

  const descLineIdx = lines.findIndex((l) => /^description:\s*(.*)$/.test(l));
  let description = '';
  if (descLineIdx !== -1) {
    const line = lines[descLineIdx] ?? '';
    const inline = line.replace(/^description:\s*/, '').trim();

    if (inline === '>-' || inline === '>' || inline === '|-' || inline === '|') {
      // YAML 块语法：收集后续缩进比声明行更深的连续行，拼成一段（折叠换行为空格）
      const collected: string[] = [];
      for (let i = descLineIdx + 1; i < lines.length; i++) {
        const l = lines[i] ?? '';
        if (l.trim() === '' || /^\s+/.test(l)) {
          collected.push(l.trim());
        } else {
          break;
        }
      }
      description = collected.join(' ').trim();
    } else if (inline.startsWith('"')) {
      // 引号包裹，可能跨多行到下一个 `"` 结束
      const rest = fm.slice(fm.indexOf(line) + line.length);
      const quoted = (inline.slice(1) + '\n' + rest).match(/^([\s\S]*?)"/);
      description = (quoted?.[1] ?? inline.slice(1)).trim();
    } else {
      description = inline;
    }
  }

  return { name, description };
}

/**
 * 列出全局 skills。目录不存在返回空数组（不是所有机器都装了 skill）。
 */
export function listGlobalSkills(): SkillSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(SKILLS_DIR);
  } catch {
    return [];
  }

  const out: SkillSummary[] = [];
  for (const dir of entries) {
    if (dir.startsWith('.')) continue;
    const skillPath = join(SKILLS_DIR, dir);
    try {
      if (!statSync(skillPath).isDirectory()) continue;
      const mdPath = join(skillPath, 'SKILL.md');
      const content = readFileSync(mdPath, 'utf-8');
      const { name, description } = parseFrontmatter(content);
      out.push({
        dir,
        name: name || dir,
        description: description || '（无描述）',
      });
    } catch {
      // 单个 skill 读取/解析失败不影响其它——常见于纯符号链接失效或非标准目录
      out.push({ dir, name: dir, description: '（无法读取 SKILL.md）' });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
