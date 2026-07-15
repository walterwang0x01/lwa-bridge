/**
 * Gemini CLI 运行时适配器：`gemini -p ... --output-format stream-json`。
 */
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { getLogger } from '../lib/logger.js';
import { parseGeminiStreamLine, type GeminiStreamState } from './geminiStreamParser.js';
import { waitForExitOrKill } from './processTermination.js';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeProfile,
  UnifiedSessionEvent,
} from './types.js';

const log = () => getLogger().child({ module: 'gemini-cli-runtime' });

const CAPABILITIES: RuntimeCapabilities = {
  acp: false,
  streaming: true,
  toolEvents: true,
  sessionResume: true,
  parallelWorkers: true,
  skills: false,
  poolable: false,
};

export class GeminiCliRuntime implements AgentRuntime {
  readonly kind = 'gemini-cli' as const;
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

  async initialize(): Promise<void> {}

  async newSession(_cwd: string): Promise<string> {
    this.sessionId = '';
    return '';
  }

  async loadSession(id: string, _cwd: string): Promise<void> {
    this.sessionId = id;
  }

  async *prompt(sessionId: string, text: string): AsyncIterable<UnifiedSessionEvent> {
    const sid = sessionId || this.sessionId;
    const args: string[] = [];
    if (sid) args.push('-r', sid);
    args.push('-p', text, '--output-format', 'stream-json', '--skip-trust');
    if (this.profile.force !== false) args.push('--approval-mode', 'yolo');
    if (this.profile.model) args.push('-m', this.profile.model);

    const env = this.extraEnv ? { ...process.env, ...this.extraEnv } : undefined;
    this.proc = execa(this.profile.bin, args, {
      cwd: this.cwd,
      env,
      reject: false,
      stdin: 'ignore',
    });

    const child = this.proc;
    if (!child.stdout) {
      throw new Error('gemini cli produced no stdout');
    }

    const state: GeminiStreamState = { sessionId: sid };
    const rl = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });

    try {
      for await (const line of rl) {
        const events = parseGeminiStreamLine(line, state);
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
      log().warn({ exitCode: result.exitCode, stderr: result.stderr }, 'gemini cli non-zero exit');
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
