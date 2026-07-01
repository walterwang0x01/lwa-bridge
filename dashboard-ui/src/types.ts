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
  logs: string[];
}
