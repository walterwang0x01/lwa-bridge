// listGlobalSkills 单元测试：frontmatter 解析（引号字符串 / YAML 块语法 / 纯行内值）、
// 目录不存在、单个 skill 解析失败不影响其它。
//
// SKILLS_DIR 是模块顶层常量（join(homedir(), '.kiro', 'skills')），要让它读到测试用的
// 临时目录，必须在 import 模块**之前**把 HOME 指向临时目录——用动态 import 保证顺序。
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'lkb-skills-test-'));
process.env['HOME'] = TMP;

const skillsDir = join(TMP, '.kiro', 'skills');

function writeSkill(name: string, content: string): void {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8');
}

// 动态 import：确保上面设置的 HOME 在模块顶层常量求值前已经生效
let listGlobalSkills: typeof import('./skills.js').listGlobalSkills;

beforeAll(async () => {
  ({ listGlobalSkills } = await import('./skills.js'));
});

describe('listGlobalSkills', () => {
  it('目录不存在时返回空数组，不抛异常', () => {
    rmSync(skillsDir, { recursive: true, force: true });
    expect(listGlobalSkills()).toEqual([]);
  });

  it('解析引号字符串形态的 description（单行）', () => {
    rmSync(skillsDir, { recursive: true, force: true });
    writeSkill(
      'lark-calendar',
      [
        '---',
        'name: lark-calendar',
        'version: 1.0.0',
        'description: "管理飞书日历，创建/查询/删除日程"',
        '---',
        '',
        '# calendar',
      ].join('\n'),
    );
    const skills = listGlobalSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toEqual({
      dir: 'lark-calendar',
      name: 'lark-calendar',
      description: '管理飞书日历，创建/查询/删除日程',
    });
  });

  it('解析 YAML 折叠块语法（>-）的 description，跨行拼成一段', () => {
    // 这是真实踩过的坑：fireworks-tech-graph 的 SKILL.md 用的正是这种写法，
    // 第一版解析只处理引号字符串，这里的结果曾经是乱码 ">-"。
    rmSync(skillsDir, { recursive: true, force: true });
    writeSkill(
      'fireworks-tech-graph',
      [
        '---',
        'name: fireworks-tech-graph',
        'description: >-',
        '  Use when the user wants to create any technical diagram - architecture, data',
        '  flow, flowchart, sequence, agent/memory, or concept map - and export as',
        '  SVG+PNG.',
        '---',
        '',
        '# fireworks',
      ].join('\n'),
    );
    const skills = listGlobalSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe(
      'Use when the user wants to create any technical diagram - architecture, data ' +
        'flow, flowchart, sequence, agent/memory, or concept map - and export as ' +
        'SVG+PNG.',
    );
    // 关键断言：折叠块语法不应该解析出裸露的 ">-" 标记
    expect(skills[0]?.description).not.toContain('>-');
  });

  it('解析纯行内值（不带引号）的 description', () => {
    rmSync(skillsDir, { recursive: true, force: true });
    writeSkill(
      'simple-skill',
      ['---', 'name: simple-skill', 'description: 一句话描述', '---', ''].join('\n'),
    );
    const skills = listGlobalSkills();
    expect(skills[0]?.description).toBe('一句话描述');
  });

  it('没有 frontmatter 时 name 回退到目录名，description 显示无描述', () => {
    rmSync(skillsDir, { recursive: true, force: true });
    writeSkill('no-frontmatter', '# 这个文件没有 frontmatter\n');
    const skills = listGlobalSkills();
    expect(skills[0]).toEqual({
      dir: 'no-frontmatter',
      name: 'no-frontmatter',
      description: '（无描述）',
    });
  });

  it('单个 skill 的 SKILL.md 缺失不影响其它 skill 正常展示', () => {
    rmSync(skillsDir, { recursive: true, force: true });
    writeSkill('good-skill', ['---', 'name: good-skill', 'description: "正常"', '---'].join('\n'));
    // 建一个没有 SKILL.md 的空目录（模拟坏掉的 skill）
    mkdirSync(join(skillsDir, 'broken-skill'), { recursive: true });

    const skills = listGlobalSkills();
    expect(skills).toHaveLength(2);
    const good = skills.find((s) => s.dir === 'good-skill');
    const broken = skills.find((s) => s.dir === 'broken-skill');
    expect(good?.description).toBe('正常');
    expect(broken).toEqual({
      dir: 'broken-skill',
      name: 'broken-skill',
      description: '（无法读取 SKILL.md）',
    });
  });

  it('忽略以 . 开头的隐藏目录', () => {
    rmSync(skillsDir, { recursive: true, force: true });
    writeSkill('.update-log', 'not a skill');
    writeSkill(
      'real-skill',
      ['---', 'name: real-skill', 'description: "真实技能"', '---'].join('\n'),
    );
    const skills = listGlobalSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.dir).toBe('real-skill');
  });

  it('symlink 指向的真实 skill 目录能正常解析（本机 skill 库多为 symlink）', () => {
    rmSync(skillsDir, { recursive: true, force: true });
    const realDir = join(TMP, 'real-skills-source', 'lark-vc');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(
      join(realDir, 'SKILL.md'),
      ['---', 'name: lark-vc', 'description: "视频会议记录"', '---'].join('\n'),
    );
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(realDir, join(skillsDir, 'lark-vc'), 'dir');

    const skills = listGlobalSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toEqual({
      dir: 'lark-vc',
      name: 'lark-vc',
      description: '视频会议记录',
    });
  });

  it('结果按 name 排序', () => {
    rmSync(skillsDir, { recursive: true, force: true });
    writeSkill('zzz-skill', ['---', 'name: zzz-skill', 'description: "z"', '---'].join('\n'));
    writeSkill('aaa-skill', ['---', 'name: aaa-skill', 'description: "a"', '---'].join('\n'));
    const skills = listGlobalSkills();
    expect(skills.map((s) => s.name)).toEqual(['aaa-skill', 'zzz-skill']);
  });
});
