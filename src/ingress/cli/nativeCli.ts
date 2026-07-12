/**
 * 本地 coding：把终端交给原生 CLI（kiro-cli chat / agent），手感对齐官方 TUI。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { RuntimeKind, RuntimeProfile } from '../../runtime/types.js';
import { shortenHomePath } from './workspace.js';

export type NativeCodingTarget =
  | { kind: 'kiro-cli-acp'; bin: string; args: string[]; label: string }
  | { kind: 'cursor-agent-cli'; bin: string; args: string[]; label: string };

export interface BuildNativeTargetOptions {
  profile: RuntimeProfile;
  /** 对应 sticky / 选中的 profile 名（仅日志） */
  profileName?: string;
  /** 是否续上最近会话（kiro: --resume；cursor: --continue） */
  continueSession?: boolean;
  resumeId?: string;
}

/** 哪些 runtime 适合原生 TUI handoff。 */
export function supportsNativeCodingHandoff(kind: RuntimeKind): boolean {
  return kind === 'kiro-cli-acp' || kind === 'cursor-agent-cli';
}

/**
 * 根据 profile 构造原生启动参数。
 * - kiro → `kiro-cli chat`（或 bin 已是 kiro-cli-chat 时直接 `chat`）
 * - cursor → `agent`（interactive，不加 --print）
 */
export function buildNativeCodingTarget(opts: BuildNativeTargetOptions): NativeCodingTarget {
  const { profile, continueSession, resumeId } = opts;
  if (profile.kind === 'cursor-agent-cli') {
    const bin = profile.bin?.trim() || 'agent';
    const args: string[] = [];
    if (resumeId) {
      args.push('--resume', resumeId);
    } else if (continueSession) {
      args.push('--continue');
    }
    if (profile.model && profile.model !== 'Auto') {
      args.push('--model', profile.model);
    }
    return {
      kind: 'cursor-agent-cli',
      bin,
      args,
      label: `${bin}${args.length ? ` ${args.join(' ')}` : ''}`,
    };
  }

  // kiro-cli-acp（及未知时回退 kiro）
  const bin = profile.bin?.trim() || 'kiro-cli';
  const args: string[] = [];
  // bin 可能是 kiro-cli 或 kiro-cli-chat
  const base = bin.endsWith('kiro-cli-chat') ? [] : ['chat'];
  args.push(...base);
  if (resumeId) {
    args.push('--resume-id', resumeId);
  } else if (continueSession) {
    args.push('--resume');
  }
  if (profile.model) {
    args.push('--model', profile.model);
  }
  if (profile.agent) {
    args.push('--agent', profile.agent);
  }
  return {
    kind: 'kiro-cli-acp',
    bin,
    args,
    label: `${bin} ${args.join(' ')}`.trim(),
  };
}

export interface LaunchNativeCodingCliOptions {
  target: NativeCodingTarget;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 测试可注入 */
  spawnImpl?: typeof spawn;
  /** 测试可注入 write */
  write?: (s: string) => void;
}

/**
 * stdio inherit 启动原生 CLI；返回子进程退出码。
 * Ctrl+C 会转发给子进程（不在此处 process.exit）。
 */
export function launchNativeCodingCli(opts: LaunchNativeCodingCliOptions): Promise<number> {
  const { target, cwd } = opts;
  const write = opts.write ?? ((s: string) => process.stderr.write(s));
  const spawnFn = opts.spawnImpl ?? spawn;

  write(`→ ${target.label}  @ ${shortenHomePath(cwd)}\n`);

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(target.bin, target.args, {
        cwd,
        env: { ...process.env, ...opts.env },
        stdio: 'inherit',
      });
    } catch (e) {
      reject(e);
      return;
    }

    const onSigInt = (): void => {
      if (!child.killed) child.kill('SIGINT');
    };
    const onSigTerm = (): void => {
      if (!child.killed) child.kill('SIGTERM');
    };
    process.once('SIGINT', onSigInt);
    process.once('SIGTERM', onSigTerm);

    child.on('error', (err) => {
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
      if (signal) {
        resolve(signal === 'SIGINT' ? 130 : 1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}
