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

/** 校验消息发送者是否被允许使用机器人。 */
export function isUserAllowed(senderOpenId: string, chatId: string, config: Config): boolean {
  const { allowedUsers, allowedChats } = config.access;
  // 白名单都为空 = 完全开放
  const userOk = allowedUsers.length === 0 || allowedUsers.includes(senderOpenId);
  const chatOk = allowedChats.length === 0 || allowedChats.includes(chatId);
  return userOk && chatOk;
}

/** 校验是否管理员（仅 admin 才能 /cd /ws save 之类）。 */
export function isAdmin(senderOpenId: string, config: Config): boolean {
  const { admins } = config.access;
  // admins 为空 = 所有用户都是 admin（个人使用模式）
  return admins.length === 0 || admins.includes(senderOpenId);
}
