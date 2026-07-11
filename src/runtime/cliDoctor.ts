/**
 * CLI `/doctor` 快速体检（不调 LLM）：plan / runtime / gateway / memory / git。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../lib/config.js';
import { resolvePlanId, resolveModeRouteTable } from './planProfiles.js';
import { discoverRuntimeRegistry } from './registry.js';
import { sharedGatewayHealth } from './gatewayHealth.js';
import { PROJECT_MEMORY_FILES } from '../ingress/cli/projectMemory.js';
import { findGitRoot } from '../ingress/cli/worktree.js';

export interface DoctorLine {
  level: 'ok' | 'warn' | 'fail';
  name: string;
  detail: string;
}

export async function runCliDoctor(opts: {
  config: Config;
  cwd: string;
  harnessMode: 'code' | 'chat' | 'lark';
  conversationId: string;
}): Promise<{ lines: DoctorLine[]; text: string }> {
  const lines: DoctorLine[] = [];
  const plan = resolvePlanId(opts.config);
  const table = resolveModeRouteTable(opts.config, opts.harnessMode);
  lines.push({
    level: 'ok',
    name: 'plan',
    detail: `${plan} · mode=${opts.harnessMode} · simple=${table.simpleProfile} · complex=${table.complexProfile}`,
  });

  const registry = await discoverRuntimeRegistry(opts.config);
  const available = registry.filter((e) => e.available);
  const missing = registry.filter((e) => !e.available);
  lines.push({
    level: available.length > 0 ? 'ok' : 'fail',
    name: 'runtimes',
    detail: `available: ${available.map((e) => e.profileName).join(', ') || '(none)'}${
      missing.length ? ` · missing: ${missing.map((e) => e.profileName).join(', ')}` : ''
    }`,
  });

  const circuits = sharedGatewayHealth.snapshot();
  const open = circuits.filter((c) => c.state === 'open');
  lines.push({
    level: open.length ? 'warn' : 'ok',
    name: 'gateway',
    detail: open.length
      ? `circuit open: ${open.map((c) => c.key).join(', ')}`
      : circuits.length
        ? `tracked ${circuits.length} endpoint(s), all closed/half-open`
        : 'no failures recorded',
  });

  const memHits = PROJECT_MEMORY_FILES.filter((n) => existsSync(join(opts.cwd, n)));
  lines.push({
    level: memHits.length ? 'ok' : 'warn',
    name: 'memory',
    detail: memHits.length
      ? `found ${memHits.join(', ')}`
      : 'no LWA.md / AGENTS.md / CLAUDE.md in cwd (optional)',
  });

  const root = findGitRoot(opts.cwd);
  lines.push({
    level: root ? 'ok' : 'warn',
    name: 'git',
    detail: root ? `root ${root}` : 'not a git repo (worktree commands unavailable)',
  });

  const compact = opts.config.runtime?.compact;
  lines.push({
    level: 'ok',
    name: 'compact',
    detail: `auto=${compact?.auto ?? true} threshold=${compact?.thresholdChars ?? 80_000} chars`,
  });

  lines.push({
    level: 'ok',
    name: 'session',
    detail: opts.conversationId,
  });

  const icon = { ok: '✓', warn: '!', fail: '✗' } as const;
  const text = [
    'LWA doctor',
    ...lines.map((l) => `${icon[l.level]} ${l.name}: ${l.detail}`),
    '',
    'Tips: /runtime check · /status · /compact · optional BrowserSkill (`bsk`)',
  ].join('\n');

  return { lines, text };
}
