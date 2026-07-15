#!/usr/bin/env node
/** 冒烟：多行输入布局（委托 vitest，无需 TTY） */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  'pnpm exec vitest run src/ingress/cli/liveInput.test.ts -t "screenshot scenario" --reporter=dot',
  { stdio: 'inherit', cwd: root },
);
console.log('smoke-input-pane: OK');
