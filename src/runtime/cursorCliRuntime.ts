/**
 * Cursor Agent CLI 运行时适配器：`agent --print --output-format stream-json`。
 */
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { getLogger } from '../lib/logger.js';
import { parseCursorStreamLine, type CursorStreamState } from './cursorStreamParser.js';
import { waitForExitOrKill } from './processTermination.js';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeProfile,
  UnifiedSessionEvent,
} from './types.js';

const log = () => getLogger().child({ module: 'cursor-cli-runtime' });

/**
 * 已知的路由占位符/伪模型名黑名单：这些值语义上表示"让 Cursor Agent 自己选"，
 * 绝不能作为真实 --model 参数下发给 CLI（Cursor 不认识这些名字，会导致该次调用
 * 挂起无输出或直接报错）。纵深防御：即便上游路由逻辑再次意外把占位符写进
 * profile.model，这里也会拦截，不影响正常配置的真实模型名。
 */
const PLACEHOLDER_MODEL_NAMES = new Set(['auto', 'default', 'none']);

export function isRealModelName(model: string | undefined): model is string {
  if (!model) return false;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  return !PLACEHOLDER_MODEL_NAMES.has(normalized);
}

const CAPABILITIES: RuntimeCapabilities = {
  acp: false,
  streaming: true,
  toolEvents: true,
  sessionResume: true,
  parallelWorkers: false,
  skills: false,
  poolable: false,
};

export class CursorCliRuntime implements AgentRuntime {
  readonly kind = 'cursor-agent-cli' as const;
  readonly capabilities = CAPABILITIES;

  private readonly profile: RuntimeProfile;
  private readonly cwd: string;
  private readonly extraEnv?: Record<string, string>;
  private proc: ResultPromise | null = null;
  private sessionId = '';
  private _skills: Array<{ name: string; description: string }> = [];

  constructor(profile: RuntimeProfile, opts: { cwd: string; extraEnv?: Record<string, string> }) {
    this.profile = profile;
    this.cwd = opts.cwd;
    if (opts.extraEnv) this.extraEnv = opts.extraEnv;
  }

  async initialize(): Promise<void> {
    // cursor-cli 无握手步骤
  }

  async newSession(_cwd: string): Promise<string> {
    this.sessionId = '';
    return '';
  }

  async loadSession(id: string, _cwd: string): Promise<void> {
    this.sessionId = id;
  }

  async *prompt(sessionId: string, text: string): AsyncIterable<UnifiedSessionEvent> {
    const sid = sessionId || this.sessionId;
    const args = ['--print', '--output-format', 'stream-json'];
    if (this.profile.force !== false) args.push('-f');
    if (isRealModelName(this.profile.model)) args.push('--model', this.profile.model);
    if (sid) args.push('--resume', sid);
    args.push('-p', text);

    const env = this.extraEnv ? { ...process.env, ...this.extraEnv } : undefined;
    this.proc = execa(this.profile.bin, args, {
      cwd: this.cwd,
      env,
      reject: false,
      stdin: 'ignore',
    });

    const child = this.proc;
    if (!child.stdout) {
      throw new Error('cursor agent produced no stdout');
    }

    const state: CursorStreamState = { sessionId: sid };
    const rl = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });

    try {
      for await (const line of rl) {
        const events = parseCursorStreamLine(line, state);
        if (state.sessionId && !this.sessionId) this.sessionId = state.sessionId;
        for (const ev of events) {
          yield ev;
        }
      }
    } finally {
      rl.close();
    }

    const result = await child;
    if (result.exitCode !== 0 && result.exitCode !== null) {
      log().warn(
        { exitCode: result.exitCode, stderr: result.stderr },
        'cursor agent non-zero exit',
      );
    }
    if (state.sessionId) this.sessionId = state.sessionId;
  }

  async cancel(_sessionId: string): Promise<void> {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
    }
  }

  async close(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      await waitForExitOrKill(this.proc);
    }
    this.proc = null;
  }

  get availableSkills(): Array<{ name: string; description: string }> {
    return this._skills;
  }

  get lastSessionId(): string {
    return this.sessionId;
  }
}
