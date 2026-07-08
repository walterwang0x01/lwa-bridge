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
 * 定位：第一版"只读总览"。后续要"可操作"（网页点按钮触发 conduit）再加 POST 路由。
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
import { listGlobalSkills } from './skills.js';
import { listGlobalAgents } from '../kiro/agents.js';
import { listInstalls } from '../assets/gitSource.js';

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
  sessions: SessionStore;
  cronStore?: CronStore;
  taskHistory?: TaskHistoryStore;
  logger: Logger;
}

export interface DashboardHandle {
  close: () => Promise<void>;
}

async function buildOverview(deps: DashboardDeps): Promise<object> {
  const chats = await deps.sessions.listAll();
  const sessions = Object.entries(chats).map(([chatId, s]) => ({
    chatId,
    currentCwd: s.currentCwd,
    cwdCount: Object.keys(s.sessionsByCwd).length,
    lastActiveAt: s.lastActiveAt,
    idleTimeoutMinutes: s.idleTimeoutMinutes ?? null,
  }));

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

  return {
    bridge: {
      pid: process.pid,
      appId: deps.appId,
      startedAt: deps.startedAt,
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      now: Date.now(),
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
    logs,
  };
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
