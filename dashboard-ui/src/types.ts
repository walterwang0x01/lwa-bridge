/**
 * /api/overview 的响应类型。
 *
 * 必须跟 lark-kiro-bridge 根包 src/dashboard/server.ts 的 buildOverview() 手动保持一致
 * ——两个项目目前没有共享类型的构建管线（dashboard-ui 是独立的 vue-tsc 项目，
 * 根包是 tsc/tsup），所以这里是契约的"前端副本"，改后端字段时记得同步这里。
 */
export interface SessionSummary {
  chatId: string;
  currentCwd: string;
  cwdCount: number;
  lastActiveAt: number;
  idleTimeoutMinutes: number | null;
}

export interface CronSummary {
  id: string;
  description: string;
  expression: string;
  enabled: boolean;
  lastRunAt: number;
  cwd: string;
}

export interface ProcessSummary {
  pid: number;
  shortId: string;
  startedAt: number;
  cwd: string;
}

export interface SkillSummary {
  dir: string;
  name: string;
  description: string;
}

export interface AgentSummary {
  name: string;
  promptPreview: string;
}

export interface AssetInstallRecord {
  assetKind: 'skill' | 'agent';
  assetId: string;
  sourceName: string;
  sourceGitUrl: string;
  installedAt: number;
}

export interface TaskHistoryRecord {
  taskId: string;
  chatId: string;
  cwd: string;
  startedAt: number;
  finishedAt: number;
  terminal: string;
  promptPreview: string;
  toolCallCount: number;
  artifacts: string[];
  runtimeProfile?: string;
  runtimeKind?: string;
  model?: string;
  complexityScore?: number;
  errorMsg?: string;
}

export interface RuntimeMetricsRow {
  runtimeKind: string;
  model: string;
  total: number;
  success: number;
  failed: number;
  successRate: number;
  avgDurationMs: number;
}

export interface BridgeInfo {
  pid: number;
  appId: string;
  startedAt: number;
  uptimeSec: number;
  now: number;
}

export interface Overview {
  bridge: BridgeInfo;
  sessions: SessionSummary[];
  cron: CronSummary[];
  processes: ProcessSummary[];
  skills: SkillSummary[];
  agents: AgentSummary[];
  assetInstalls: AssetInstallRecord[];
  taskHistory: TaskHistoryRecord[];
  runtimeMetrics: RuntimeMetricsRow[];
  logs: string[];
}
