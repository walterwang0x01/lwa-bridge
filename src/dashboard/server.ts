/**
 * 只读 Web Dashboard
 *
 * 在本机起一个极简 HTTP server（Node 内置 http），暴露：
 *   GET /              → 静态托管 Vue 前端构建产物（dashboard-ui/dist）
 *   GET /api/overview  → 会话 / 定时任务 / 进程 / 技能 / 最近日志 的只读快照
 *
 * 前端是独立的 Vue 3 + Vite 子项目（../../dashboard-ui），构建后拷进
 * dist/dashboard-ui/ 随包分发；这里只做静态文件托管 + JSON API，不引入
 * express/fastify —— 只读小面板，Node 内置 http 已经够用。
 *
 * 安全：
 *   - 绑定 127.0.0.1，只本机可访问；手机访问用 `tailscale serve <port>` 代理
 *   - 纯只读，不暴露任何写操作；不返回 config（含 appSecret）
 *   - 静态文件路径做了 `..` 穿越校验，且限制在构建产物目录内
 *
 * 定位：只读总览 + 少量本机可写操作（切会话 runtime）。
 *   POST /api/session/runtime  { conversationId, profileName }  // profileName=auto 清除粘性
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { SessionStore } from '../store/sessions.js';
import type { CronStore } from '../cron/store.js';
import type { TaskHistoryStore } from '../store/taskHistory.js';
import { listProcesses } from '../daemon/registry.js';
import { readRecentLogLines } from '../lib/logger.js';
import type { Config } from '../lib/config.js';
import { listGlobalSkills } from './skills.js';
import { listGlobalAgents } from '../kiro/agents.js';
import { listInstalls } from '../assets/gitSource.js';
import { discoverRuntimeRegistry } from '../runtime/registry.js';
import { probeAllRuntimeQuotasForDashboard } from '../runtime/quota.js';
import { sharedConduitRegistry } from '../conduit/registry.js';
import { formatProgressOneLiner } from '../conduit/progress.js';
import { summarizeRunState } from '../conduit/summary.js';
import { shortenHomePath } from '../ingress/cli/workspace.js';
import { resolveRuntimeProfile, listRuntimeProfileNames } from '../runtime/config.js';

// tsup 把整个包打成单文件 bundle（dist/cli.js / dist/index.js），不保留 src/
// 的目录结构——所以运行时 import.meta.url 指向的是 dist/cli.js，HERE 算出来
// 就是 dist/ 本身，不是"看起来应该"的 dist/dashboard/。
//   生产（跑 dist/cli.js）：HERE = dist/               → dist/dashboard-ui/
//   开发（tsx 跑 src/dashboard/server.ts）：HERE = src/dashboard/ → dashboard-ui/dist/
// 两个路径都探测一下，谁先命中用谁。
const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIST_CANDIDATES = [
  join(HERE, 'dashboard-ui'), // 生产：dist/ → dist/dashboard-ui/
  join(HERE, '..', '..', 'dashboard-ui', 'dist'), // 开发：src/dashboard/ → dashboard-ui/dist/
];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export interface DashboardDeps {
  port: number;
  appId: string;
  startedAt: number;
  config: Config;
  sessions: SessionStore;
  cronStore?: CronStore;
  taskHistory?: TaskHistoryStore;
  logger: Logger;
}

export interface DashboardHandle {
  close: () => Promise<void>;
}

function summarizeRuntimeEntry(
  entry: Awaited<ReturnType<typeof discoverRuntimeRegistry>>[number],
): object {
  const profile = entry.profile;
  const base: Record<string, unknown> = {
    profileName: entry.profileName,
    runtimeKind: profile.kind,
    available: entry.available,
    model: profile.model ?? null,
  };
  if (profile.kind === 'openai-compatible') {
    let apiBaseHost: string | null = null;
    try {
      apiBaseHost = profile.apiBase ? new URL(profile.apiBase).host : null;
    } catch {
      apiBaseHost = profile.apiBase ?? null;
    }
    base['apiBaseHost'] = apiBaseHost;
    return base;
  }
  base['bin'] = profile.bin;
  return base;
}

async function buildOverview(deps: DashboardDeps): Promise<object> {
  const chats = await deps.sessions.listAll();
  const sessions = Object.entries(chats).map(([chatId, s]) => {
    const channel = chatId.startsWith('cli-')
      ? 'cli'
      : chatId.startsWith('slack-')
        ? 'slack'
        : 'lark';
    return {
      chatId,
      channel,
      currentCwd: s.currentCwd,
      cwdShort: shortenHomePath(s.currentCwd),
      cwdCount: Object.keys(s.sessionsByCwd).length,
      lastActiveAt: s.lastActiveAt,
      idleTimeoutMinutes: s.idleTimeoutMinutes ?? null,
      title: s.title ?? null,
      phase: s.phase ?? null,
      runtimeProfile: s.runtimeProfile ?? null,
      lastUsedRuntimeProfile: s.lastUsedRuntimeProfile ?? null,
      lastUsedModel: s.lastUsedModel ?? null,
      filesTouched: s.filesTouched?.length ?? 0,
      liveContextPct: s.liveContextPct ?? null,
      runEverything: s.runEverything ?? null,
    };
  });

  const cron = deps.cronStore
    ? (await deps.cronStore.list()).map((t) => ({
        id: t.id,
        description: t.description,
        expression: t.expression,
        enabled: t.enabled,
        lastRunAt: t.lastRunAt,
        cwd: t.cwd,
      }))
    : [];

  const processes = (await listProcesses()).map((p) => ({
    pid: p.pid,
    shortId: p.shortId,
    startedAt: p.startedAt,
    cwd: p.cwd,
  }));

  const logs = readRecentLogLines(120);
  const skills = listGlobalSkills();
  const agents = listGlobalAgents();
  const assetInstalls = await listInstalls();
  const taskHistory = deps.taskHistory ? await deps.taskHistory.listRecent(50) : [];
  const runtimeMetrics = deps.taskHistory
    ? await deps.taskHistory.summarizeRuntimeMetrics(200)
    : [];
  const adaptiveRecommendation = deps.taskHistory
    ? await deps.taskHistory.recommendAdaptiveStrategy(200)
    : { sampleSize: 0, reason: 'no-task-history' };
  const adaptiveReadiness = deps.taskHistory
    ? await deps.taskHistory.evaluateApplySafeReadiness(200)
    : [];
  const metricsAlerts = deps.taskHistory ? await deps.taskHistory.listMetricsAlerts(200) : [];
  const monthUsageByKind = deps.taskHistory
    ? await deps.taskHistory.countMonthUsageByKind().catch(() => ({}))
    : {};
  const registry = await discoverRuntimeRegistry(deps.config);
  const quotaStatuses = await probeAllRuntimeQuotasForDashboard(
    registry
      .filter((e) => e.available)
      .map((e) => ({ profileName: e.profileName, profile: e.profile })),
    deps.config,
    monthUsageByKind,
  );

  const conduitActive = sharedConduitRegistry.listActive().map((r) => ({
    conversationId: r.conversationId,
    cwd: r.cwd,
    cwdShort: shortenHomePath(r.cwd),
    startedAt: r.startedAt,
    eventCount: r.progress.eventCount,
    oneLiner: formatProgressOneLiner(r.progress),
    wave:
      r.progress.totalWaves > 0
        ? { current: r.progress.currentWave, total: r.progress.totalWaves }
        : null,
  }));

  // 最近活跃会话的 cwd 上扫一眼 run-state（最多 5 个不同 cwd）
  const seenCwds = new Set<string>();
  const conduitRecent: object[] = [];
  for (const s of sessions
    .slice()
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, 20)) {
    if (seenCwds.has(s.currentCwd) || seenCwds.size >= 5) continue;
    seenCwds.add(s.currentCwd);
    const summary = summarizeRunState(s.currentCwd);
    if (!summary) continue;
    conduitRecent.push({
      cwd: s.currentCwd,
      cwdShort: shortenHomePath(s.currentCwd),
      dirName: summary.dirName,
      baseBranch: summary.baseBranch ?? null,
      passed: summary.passed.length,
      failed: summary.failed.length,
      skipped: summary.skipped.length,
      pending: summary.pending.length,
    });
  }

  return {
    bridge: {
      pid: process.pid,
      appId: deps.appId,
      startedAt: deps.startedAt,
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      now: Date.now(),
      plan: deps.config.runtime?.plan ?? 'kiro-unlimited+cursor-lite',
      defaultRuntime: deps.config.runtime?.default ?? 'auto',
    },
    sessions,
    cron,
    processes,
    skills,
    agents,
    assetInstalls,
    taskHistory,
    runtimeMetrics,
    adaptiveRecommendation,
    adaptiveReadiness,
    metricsAlerts,
    runtimeProfiles: registry.map((entry) => summarizeRuntimeEntry(entry)),
    quotaStatuses,
    conduitActive,
    conduitRecent,
    logs,
  };
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as unknown;
}

async function handleSessionRuntimePost(
  deps: DashboardDeps,
  body: unknown,
): Promise<
  { ok: true; conversationId: string; profileName: string } | { ok: false; error: string }
> {
  const obj = (body ?? {}) as Record<string, unknown>;
  const conversationId = typeof obj.conversationId === 'string' ? obj.conversationId.trim() : '';
  const profileName = typeof obj.profileName === 'string' ? obj.profileName.trim() : '';
  if (!conversationId || !profileName) {
    return { ok: false, error: 'conversationId and profileName required' };
  }
  if (profileName === 'auto' || profileName === 'clear') {
    await deps.sessions.clearConversationRuntimeProfile(conversationId);
    return { ok: true, conversationId, profileName: 'auto' };
  }
  try {
    resolveRuntimeProfile(deps.config, profileName);
  } catch {
    const valid = listRuntimeProfileNames(deps.config).join(', ');
    return { ok: false, error: `unknown profile; available: ${valid}` };
  }
  await deps.sessions.setConversationRuntimeProfile(
    conversationId,
    profileName,
    deps.config.workspace.defaultCwd,
  );
  return { ok: true, conversationId, profileName };
}

/** 找到第一个存在的前端产物目录；找不到返回 undefined（server 会用文字兜底页）。 */
async function resolveUiDist(): Promise<string | undefined> {
  for (const dir of UI_DIST_CANDIDATES) {
    try {
      await readFile(join(dir, 'index.html'));
      return dir;
    } catch {
      // 试下一个候选路径
    }
  }
  return undefined;
}

/**
 * 静态文件托管，带路径穿越防护：解析后的绝对路径必须仍在 uiDist 内。
 * 找不到具体文件时（SPA 路由，比如以后加 hash 路由）回退到 index.html。
 */
async function serveStatic(
  uiDist: string,
  urlPath: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const resolved = normalize(join(uiDist, rel));
  if (!resolved.startsWith(normalize(uiDist))) return null; // 路径穿越拒绝

  const tryRead = async (p: string): Promise<Buffer | null> => {
    try {
      return await readFile(p);
    } catch {
      return null;
    }
  };

  let body = await tryRead(resolved);
  let servedPath = resolved;
  if (!body) {
    // SPA 兜底：找不到就吐 index.html（当前没有前端路由，但为未来留口子）
    body = await tryRead(join(uiDist, 'index.html'));
    servedPath = join(uiDist, 'index.html');
    if (!body) return null;
  }
  const contentType = MIME[extname(servedPath)] ?? 'application/octet-stream';
  return { body, contentType };
}

/**
 * 启动 dashboard server。返回 close() 用于优雅关闭。
 * 端口被占用等启动失败只 warn，不阻塞 bridge 主流程。
 */
export function startDashboard(deps: DashboardDeps): DashboardHandle {
  const log = deps.logger.child({ module: 'dashboard' });

  // 异步探测一次，缓存结果；找不到就用文字提示页兜底（不阻塞 dashboard 启动）
  const uiDistPromise = resolveUiDist();

  const server: Server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    if (req.method === 'POST' && url === '/api/session/runtime') {
      void readJsonBody(req)
        .then((body) => handleSessionRuntimePost(deps, body))
        .then((result) => {
          res.writeHead(result.ok ? 200 : 400, {
            'content-type': 'application/json; charset=utf-8',
          });
          res.end(JSON.stringify(result));
        })
        .catch((e) => {
          log.warn({ err: e }, 'session runtime post failed');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }));
        });
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    if (url === '/api/overview') {
      buildOverview(deps)
        .then((data) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(data));
        })
        .catch((e) => {
          log.warn({ err: e }, 'overview build failed');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String((e as Error).message) }));
        });
      return;
    }
    // 其余 GET 请求：静态文件托管（前端构建产物）
    uiDistPromise
      .then(async (uiDist) => {
        if (!uiDist) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(
            'dashboard-ui 构建产物未找到。请先在 dashboard-ui/ 跑 `pnpm build`，' +
              '或在根包跑 `pnpm build`（会自动先构建前端）。',
          );
          return;
        }
        const file = await serveStatic(uiDist, url ?? '/');
        if (!file) {
          res.writeHead(404).end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': file.contentType });
        res.end(file.body);
      })
      .catch((e) => {
        log.warn({ err: e }, 'static file serve failed');
        res.writeHead(500).end('internal error');
      });
  });

  server.on('error', (e) => {
    log.warn({ err: e, port: deps.port }, 'dashboard server error (non-fatal)');
  });

  // 仅绑定本机回环地址，外网/局域网默认不可达
  server.listen(deps.port, '127.0.0.1', () => {
    log.info({ port: deps.port }, `📊 dashboard at http://127.0.0.1:${deps.port}`);
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
