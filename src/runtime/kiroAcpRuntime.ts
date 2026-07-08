/**
 * Kiro CLI ACP 运行时适配器：包装现有 AcpClient。
 */
import { AcpClient, type AcpClientConfig } from '../kiro/acp/client.js';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeProfile,
  UnifiedSessionEvent,
} from './types.js';

const CAPABILITIES: RuntimeCapabilities = {
  acp: true,
  streaming: true,
  toolEvents: true,
  sessionResume: true,
  parallelWorkers: true,
  skills: true,
  poolable: true,
};

export class KiroAcpRuntime implements AgentRuntime {
  readonly kind = 'kiro-acp' as const;
  readonly capabilities = CAPABILITIES;

  private readonly client: AcpClient;
  private readonly ownsClient: boolean;

  constructor(client: AcpClient, ownsClient = true) {
    this.client = client;
    this.ownsClient = ownsClient;
  }

  static spawn(
    profile: RuntimeProfile,
    opts: { cwd: string; extraEnv?: Record<string, string> },
  ): KiroAcpRuntime {
    const cfg: AcpClientConfig = { binPath: profile.bin, cwd: opts.cwd };
    if (profile.model) cfg.model = profile.model;
    if (profile.agent) cfg.agent = profile.agent;
    if (opts.extraEnv) cfg.env = opts.extraEnv;
    return new KiroAcpRuntime(AcpClient.spawn(cfg), true);
  }

  async initialize(): Promise<void> {
    await this.client.initialize();
  }

  newSession(cwd: string): Promise<string> {
    return this.client.newSession(cwd);
  }

  loadSession(id: string, cwd: string): Promise<void> {
    return this.client.loadSession(id, cwd);
  }

  prompt(sessionId: string, text: string): AsyncIterable<UnifiedSessionEvent> {
    return this.client.prompt(sessionId, text);
  }

  cancel(sessionId: string): Promise<void> {
    return this.client.cancel(sessionId);
  }

  close(): Promise<void> {
    if (!this.ownsClient) return Promise.resolve();
    return this.client.close();
  }

  get availableSkills(): Array<{ name: string; description: string }> {
    return this.client.availableSkills;
  }

  /** 暴露底层 client 供 AcpPool 池化复用。 */
  get acpClient(): AcpClient {
    return this.client;
  }
}
