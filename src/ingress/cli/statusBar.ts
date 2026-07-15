/**
 * LWA Code Shell 底部状态栏（对齐 Cursor Agent：Auto · ctx% · files · Run Everything）。
 */
import type { Config } from '../../lib/config.js';
import type { ChatSession } from '../../store/sessions.js';
import { resolveRuntimeProfile } from '../../runtime/config.js';
import { gitBranch, shortenHomePath } from './workspace.js';

export type ApprovalMode = 'Run Everything' | 'Ask each time';

export interface CliStatusSnapshot {
  /** Auto 或粘性引擎名（cursor / kiro / openai-fast …） */
  routeMode: string;
  /** Auto 模式下上一轮实际引擎；手动模式与 routeMode 相同 */
  engine?: string;
  model?: string;
  ctxPct?: number;
  filesCount: number;
  approval: ApprovalMode;
  cwd: string;
  branch?: string;
  /** 进行中的 conduit 摘要（Wave / Tasks） */
  conduitHint?: string;
}

export function resolveApprovalMode(
  session: Pick<ChatSession, 'runEverything'>,
  profileForce?: boolean,
): ApprovalMode {
  if (session.runEverything === false) return 'Ask each time';
  if (session.runEverything === true) return 'Run Everything';
  if (profileForce === false) return 'Ask each time';
  return 'Run Everything';
}

export function buildCliStatusSnapshot(opts: {
  cwd: string;
  session: Pick<
    ChatSession,
    'runtimeProfile' | 'lastUsedRuntimeProfile' | 'lastUsedModel' | 'filesTouched' | 'runEverything'
  >;
  config: Config;
  ctxPct?: number;
}): CliStatusSnapshot {
  const sticky = opts.session.runtimeProfile?.trim();
  const isAuto = !sticky || sticky === 'auto';
  const routeMode = isAuto ? 'Auto' : sticky;
  const engine = isAuto ? opts.session.lastUsedRuntimeProfile : sticky;

  let model: string | undefined;
  let profileForce: boolean | undefined;
  try {
    const profileName = isAuto ? (engine ?? 'kiro') : sticky!;
    const p = resolveRuntimeProfile(opts.config, profileName);
    model = isAuto ? (opts.session.lastUsedModel ?? p.model) : p.model;
    profileForce = p.force;
  } catch {
    model = isAuto ? opts.session.lastUsedModel : undefined;
  }

  return {
    routeMode,
    engine,
    model,
    ctxPct: opts.ctxPct,
    filesCount: opts.session.filesTouched?.length ?? 0,
    approval: resolveApprovalMode(opts.session, profileForce),
    cwd: opts.cwd,
    branch: gitBranch(opts.cwd),
  };
}

/** 主状态左段：路由、可用的 context 用量和实际修改文件数。 */
export function formatCliStatusPrimary(snapshot: CliStatusSnapshot): string {
  const route =
    snapshot.routeMode === 'Auto' && snapshot.engine
      ? `Auto→${snapshot.engine}`
      : snapshot.routeMode;
  const parts: string[] = [route];
  if (snapshot.ctxPct !== undefined) parts.push(`ctx ${snapshot.ctxPct}%`);
  const files = snapshot.filesCount;
  if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** 主状态栏单行：Auto · 42% · 3 files edited · Run Everything */
export function formatCliStatusBar(snapshot: CliStatusSnapshot): string {
  return `${formatCliStatusPrimary(snapshot)} · ${snapshot.approval}`;
}

/** 副状态行：~/proj · main · kiro · claude-sonnet（或 conduit 进度前缀） */
export function formatCliSubStatusLine(snapshot: CliStatusSnapshot): string {
  const parts: string[] = [];
  if (snapshot.conduitHint) parts.push(snapshot.conduitHint);
  parts.push(shortenHomePath(snapshot.cwd));
  if (snapshot.branch) parts.push(snapshot.branch);
  if (snapshot.model) parts.push(snapshot.model);
  return parts.join(' · ');
}

/** 合并两行（prompt 前展示）；docked 时 approval 画在底栏右侧 */
export function formatCliFooter(snapshot: CliStatusSnapshot): {
  primary: string;
  secondary: string;
  approval: string;
} {
  return {
    primary: formatCliStatusPrimary(snapshot),
    secondary: formatCliSubStatusLine(snapshot),
    approval: snapshot.approval,
  };
}
