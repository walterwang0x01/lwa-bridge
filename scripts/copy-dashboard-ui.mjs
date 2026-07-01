#!/usr/bin/env node
/**
 * 把 dashboard-ui 的构建产物拷进根包的 dist/dashboard-ui/。
 *
 * 为什么单独一个脚本而不是内联 shell 命令：cp -r 在不同平台参数不一致
 * （macOS/Linux 的 cp 和 Windows 没有 cp），用 Node 内置 fs.cpSync 跨平台一致，
 * 且这里顺便做一次"源目录必须存在"的校验，构建产物缺失时给出明确报错而不是
 * 静默生成一个空的 dist/dashboard-ui/。
 */
import { cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'dashboard-ui', 'dist');
const dest = join(root, 'dist', 'dashboard-ui');

if (!existsSync(src)) {
  console.error(
    `❌ ${src} 不存在。请先跑 \`pnpm build:ui\`（或直接跑根包的 \`pnpm build\`，会自动先构建前端）。`,
  );
  process.exit(1);
}

cpSync(src, dest, { recursive: true });
console.log(`✅ dashboard-ui 构建产物已拷贝到 ${dest}`);
