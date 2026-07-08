/**
 * Cursor Agent CLI 运行时适配器：`agent --print --output-format stream-json`。
 */
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { getLogger } from '../lib/logger.js';
import { parseCursorStreamLine, type CursorStreamState } from './cursorStreamParser.js';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeProfile,
  UnifiedSessionEvent,
} from './types.js';

const log = () => getLogger().child({ module: 'cursor-cli-runtime' });

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
    if (this.profile.model) args.push('--model', this.profile.model);
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
      try {
        await this.proc;
      } catch {
        // ignore
      }
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
