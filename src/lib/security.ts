/**
 * 安全工具：cwd 白名单、路径规范化、访问控制判断
 */
import { resolve, normalize } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Config } from './config.js';

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/**
 * 把用户给的 path 规范化成绝对路径：
 *   - 展开 ~ 到 home
 *   - 解析相对路径（相对于 cwd 参数）
 *   - normalize 去掉 .. 和 . 段
 */
export function resolvePath(p: string, baseCwd: string): string {
  let s = p.trim();
  if (s.startsWith('~/') || s === '~') {
    s = s.replace(/^~/, homedir());
  }
  return normalize(resolve(baseCwd, s));
}

/**
 * 判断 absPath 是否在 allowedRoots 任一根之下。
 * allowedRoots 也会先经过 resolvePath 规范化。
 */
export function isPathAllowed(absPath: string, allowedRoots: string[]): boolean {
  const target = normalize(absPath);
  for (const root of allowedRoots) {
    const r = normalize(resolve(root));
    // 加 path.sep 防止 /foo 误匹配 /foobar
    const rWithSep = r.endsWith('/') ? r : `${r}/`;
    if (target === r || target.startsWith(rWithSep)) return true;
  }
  return false;
}

/**
 * 校验目标 cwd 是否可用：
 *   - 在白名单内
 *   - 实际存在且是目录
 * 不通过时抛 SecurityError，错误信息可直接展示给用户。
 */
export function validateCwd(targetPath: string, config: Config, baseCwd: string): string {
  const abs = resolvePath(targetPath, baseCwd);
  if (!isPathAllowed(abs, config.workspace.allowedRoots)) {
    throw new SecurityError(
      `路径 \`${abs}\` 不在白名单内。\n白名单：\n${config.workspace.allowedRoots
        .map((r) => `  • \`${r}\``)
        .join('\n')}`,
    );
  }
  if (!existsSync(abs)) {
    throw new SecurityError(`路径不存在：\`${abs}\``);
  }
  const stat = statSync(abs);
  if (!stat.isDirectory()) {
    throw new SecurityError(`不是目录：\`${abs}\``);
  }
  return abs;
}

/**
 * 校验消息发送者是否被允许使用机器人。
 *
 * 三层独立校验，全部通过才算允许：
 *   1. allowedUsers：发送者必须在白名单（空列表=不限）
 *   2. allowedChats：消息所在 chat 必须在白名单（空列表=不限）
 *      —— **DM（p2p）永远豁免**，避免管理员把自己锁在外面，无法 DM 改配置
 *   3. （admins 单独走 isAdmin 判断；不在这里）
 *
 * 使用模式：
 *   - 个人使用：三个都为空，全开放
 *   - 团队使用：填 allowedChats=team-group，DM 仍可改 config
 *   - 锁死：三个都填，但 DM 永远能进
 */
export function isUserAllowed(
  senderOpenId: string,
  chatId: string,
  chatType: 'p2p' | 'group' | 'topic_group' | 'unknown',
  config: Config,
): boolean {
  const { allowedUsers, allowedChats } = config.access;
  const userOk = allowedUsers.length === 0 || allowedUsers.includes(senderOpenId);
  // DM 永远绕过 chat allowlist —— 防止把自己锁在外面
  const chatOk = chatType === 'p2p' || allowedChats.length === 0 || allowedChats.includes(chatId);
  return userOk && chatOk;
}

/** 校验是否管理员（仅 admin 才能 /cd /ws save /config 之类）。 */
export function isAdmin(senderOpenId: string, config: Config): boolean {
  const { admins } = config.access;
  // admins 为空 = 所有用户都是 admin（个人使用模式）
  return admins.length === 0 || admins.includes(senderOpenId);
}

/**
 * 校验访问控制配置本身合法（防止把自己锁在外面）。
 *
 * 触发场景：用户通过 /config 表单改 access 时，先校验再保存。
 *
 * 规则：
 *   - admins 非空时，submitter 必须在 admins 里（否则提交完自己再也改不了）
 *   - allowedUsers 非空时，submitter 必须在 allowedUsers（否则下条消息就被拦）
 *   - allowedChats 不需要校验 submitter 所在 chat（DM 永远豁免，能恢复）
 *
 * 返回错误信息字符串数组；空数组 = 通过。
 */
export function validateAccessChange(opts: {
  submitterOpenId: string;
  next: { allowedUsers: string[]; allowedChats: string[]; admins: string[] };
}): string[] {
  const errors: string[] = [];
  const { submitterOpenId, next } = opts;
  if (next.admins.length > 0 && !next.admins.includes(submitterOpenId)) {
    errors.push(
      `❌ 你的 open_id（\`${submitterOpenId}\`）不在 admins 列表里，提交后你将无法再改配置。请先把自己加进去。`,
    );
  }
  if (next.allowedUsers.length > 0 && !next.allowedUsers.includes(submitterOpenId)) {
    errors.push(
      `❌ 你的 open_id（\`${submitterOpenId}\`）不在 allowedUsers 列表里，提交后你的下一条消息会被静默丢弃。请先把自己加进去。`,
    );
  }
  return errors;
}
