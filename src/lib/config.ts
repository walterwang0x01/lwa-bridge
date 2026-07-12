/**
 * 配置文件 schema 与加载逻辑
 *
 * 配置文件路径：~/.lwa/config.json
 *
 * 字段：
 *  - lark.appId / lark.appSecret：飞书自建应用凭证
 *  - kiro.binPath：kiro-cli 可执行文件路径，默认 'kiro-cli'（PATH 中查找）
 *  - kiro.trustedTools：允许 Kiro 自动调用的工具列表
 *  - kiro.timeoutMs：单次 Kiro 任务超时（毫秒）
 *  - workspace.defaultCwd：未设置过 cwd 的会话默认工作目录
 *  - workspace.allowedRoots：白名单根目录，所有 /cd 必须落在这些根之下
 *  - access.allowedUsers / allowedChats / admins：访问控制
 *  - preferences.requireMentionInGroup：群里是否必须 @bot 才回复
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { z } from 'zod';
import { CONFIG_FILE, ensureDataDirs } from './paths.js';
import { cliCommand } from './branding.js';

/** 单个 Agent CLI runtime profile（kiro-cli-acp / cursor-agent-cli 等）。 */
export const RuntimeProfileSchema = z.object({
  kind: z.enum(['kiro-cli-acp', 'cursor-agent-cli', 'gemini-cli', 'openai-compatible']),
  bin: z.string().optional(),
  model: z.string().optional(),
  agent: z.string().optional(),
  force: z.boolean().optional(),
  apiBase: z.string().optional(),
  apiKey: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  idleTimeoutMinutes: z.number().int().nonnegative().optional(),
  systemPromptPrefix: z.string().optional(),
  trustedTools: z.array(z.string()).optional(),
});

export const ConfigSchema = z.object({
  /**
   * 多 CLI 运行时配置（v0.10+）。
   * 未配置时从 legacy `kiro.*` 自动推导 `profiles.kiro` 与 `profiles.cursor`。
   */
  runtime: z
    .object({
      default: z.string().default('auto'),
      /**
       * 套餐感知路由预设。
       * - kiro-unlimited+cursor-lite：code 默认 kiro 主 + cursor 轻量，网关可选
       * - cursor-heavy：cursor 主
       * - gateway-first：openai-compatible 主
       */
      plan: z
        .enum(['kiro-unlimited+cursor-lite', 'cursor-heavy', 'gateway-first'])
        .default('kiro-unlimited+cursor-lite'),
      /** 按 harness 模式覆盖 plan 预设中的路由表 */
      modes: z
        .object({
          code: z
            .object({
              simpleProfile: z.string().optional(),
              complexProfile: z.string().optional(),
              conduitProfile: z.string().optional(),
              fallbackProfiles: z.array(z.string()).optional(),
              sticky: z.boolean().optional(),
              gatewayOptional: z.boolean().optional(),
            })
            .optional(),
          chat: z
            .object({
              simpleProfile: z.string().optional(),
              complexProfile: z.string().optional(),
              conduitProfile: z.string().optional(),
              fallbackProfiles: z.array(z.string()).optional(),
              sticky: z.boolean().optional(),
              gatewayOptional: z.boolean().optional(),
            })
            .optional(),
          lark: z
            .object({
              simpleProfile: z.string().optional(),
              complexProfile: z.string().optional(),
              conduitProfile: z.string().optional(),
              fallbackProfiles: z.array(z.string()).optional(),
              sticky: z.boolean().optional(),
              gatewayOptional: z.boolean().optional(),
            })
            .optional(),
        })
        .optional(),
      /** OpenAPI 网关熔断参数 */
      gateway: z
        .object({
          failureThreshold: z.number().int().positive().default(2),
          cooldownMs: z.number().int().positive().default(60_000),
          probeTimeoutMs: z.number().int().positive().default(3_000),
        })
        .optional(),
      /** 上下文压缩（手动 /compact + auto） */
      compact: z
        .object({
          auto: z.boolean().default(true),
          /** 粗略字符阈值（≈ tokens*4）；默认 80k ≈ 20k tokens */
          thresholdChars: z.number().int().positive().default(80_000),
          cooldownMs: z.number().int().positive().default(60_000),
        })
        .optional(),
      profiles: z.record(z.string(), RuntimeProfileSchema).default({}),
      routing: z
        .object({
          commands: z.record(z.string(), z.string()).default({}),
        })
        .default({}),
      router: z
        .object({
          mode: z.enum(['manual', 'smart']).default('manual'),
          fallbackProfiles: z.array(z.string()).default([]),
          lark: z
            .object({
              simpleProfile: z.string().default('cursor'),
              complexProfile: z.string().default('kiro'),
              conduitProfile: z.string().default('kiro'),
            })
            .default({}),
          rules: z
            .object({
              maxPromptCharsForCursor: z.number().int().positive().default(800),
              complexityThreshold: z.number().int().nonnegative().default(4),
              complexKeywords: z.array(z.string()).default([]),
            })
            .default({}),
        })
        .default({}),
      quota: z
        .object({
          cacheTtlMs: z.number().int().positive().optional(),
          overrides: z
            .record(
              z.enum(['kiro-cli-acp', 'cursor-agent-cli', 'gemini-cli', 'openai-compatible']),
              z.enum(['healthy', 'depleted', 'unknown', 'error']),
            )
            .optional(),
          monthlyLimits: z
            .record(
              z.enum(['kiro-cli-acp', 'cursor-agent-cli', 'gemini-cli', 'openai-compatible']),
              z.number().int().nonnegative(),
            )
            .optional(),
          fallbackByBucket: z
            .record(z.enum(['chat', 'review', 'plan', 'edit', 'conduit']), z.array(z.string()))
            .optional(),
          /** Dashboard 配额重探最小间隔（默认 60s）；路由仍用 cacheTtlMs */
          dashboardRefreshMs: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
  modelRouting: z
    .object({
      kiro: z
        .object({
          mode: z.enum(['fixed', 'smart']).default('smart'),
          adaptiveMode: z
            .enum(['off', 'suggest', 'apply-safe', 'apply-aggressive'])
            .default('suggest'),
          simpleTier: z.enum(['fast', 'balanced', 'strong', 'max']).default('balanced'),
          mediumTier: z.enum(['fast', 'balanced', 'strong', 'max']).default('strong'),
          hardTier: z.enum(['fast', 'balanced', 'strong', 'max']).default('max'),
          mediumThreshold: z.number().int().nonnegative().default(4),
          hardThreshold: z.number().int().nonnegative().default(7),
        })
        .default({}),
      cursor: z
        .object({
          mode: z.enum(['fixed']).default('fixed'),
          model: z.string().default('Auto'),
        })
        .default({}),
    })
    .default({}),
  ingress: z
    .object({
      /**
       * 启用的入站通道（Gateway / `lwa serve`）。
       * 本地 `lwa` / `lwa chat` 始终只用 CLI，不受此字段影响。
       */
      channels: z.array(z.enum(['lark', 'slack', 'cli'])).optional(),
      /** @deprecated 使用 channels；单通道旧配置会映射到 channels */
      channel: z.enum(['lark', 'slack', 'cli']).optional(),
      slack: z
        .object({
          botToken: z.string().optional(),
          appToken: z.string().optional(),
          signingSecret: z.string().optional(),
        })
        .optional(),
    })
    .default({})
    .transform((v) => {
      const channels =
        v.channels && v.channels.length > 0
          ? v.channels
          : v.channel
            ? [v.channel]
            : (['lark'] as Array<'lark' | 'slack' | 'cli'>);
      return { ...v, channels };
    }),
  lark: z.object({
    appId: z.string().min(1),
    appSecret: z.string().min(1),
  }),
  kiro: z
    .object({
      binPath: z.string().default('kiro-cli'),
      trustedTools: z.array(z.string()).default(['fs_read', 'fs_write', 'grep', 'glob', 'code']),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .default(10 * 60 * 1000),
      /**
       * 默认 idle watchdog（分钟）。0 = 关闭。
       * stdout 连续这么久没新输出就当作 kiro-cli 假死，killTree。
       * /timeout N 可以临时为某个 chat 覆盖。
       */
      idleTimeoutMinutes: z.number().int().nonnegative().default(5),
      model: z.string().optional(),
      agent: z.string().optional(),
      /**
       * 注入到每条 user prompt 之前的"系统级"前缀。
       * 用途：约束 kiro-cli 的工具偏好（比如"优先用系统已装工具，禁止安装大型依赖"），
       * 减少 bot 自己卡在 npm install / playwright install 的概率。
       * 设为空字符串则不注入。
       */
      systemPromptPrefix: z.string().default(''),
      /**
       * Session 自动过期时间（小时）。
       * 超过此时长没有活动的 session 会被自动丢弃，下次消息开新 session。
       * 避免旧对话上下文串台到新话题。默认 4 小时。设为 0 = 永不过期。
       */
      sessionTtlHours: z.number().nonnegative().default(4),
    })
    .default({}),
  workspace: z
    .object({
      defaultCwd: z.string().default('/Users/administrator/PycharmProjects'),
      allowedRoots: z.array(z.string()).default(['/Users/administrator/PycharmProjects']),
    })
    .default({}),
  access: z
    .object({
      allowedUsers: z.array(z.string()).default([]),
      allowedChats: z.array(z.string()).default([]),
      admins: z.array(z.string()).default([]),
    })
    .default({}),
  preferences: z
    .object({
      requireMentionInGroup: z.boolean().default(true),
      cardUpdateIntervalMs: z.number().int().positive().default(800),
      /** 启动时清理多少天之前的日志文件 */
      logRetentionDays: z.number().int().positive().default(7),
    })
    .default({}),
  /**
   * 只读 Web Dashboard：在本机起一个 HTTP server，浏览器看会话/任务/日志。
   * 绑定 127.0.0.1（仅本机）；手机访问用 Tailscale serve 代理该端口。
   */
  dashboard: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().int().positive().default(5180),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * 从磁盘加载配置；不存在则抛错（让 CLI 引导用户跑 init/wizard）。
 */
export function loadConfig(): Config {
  ensureDataDirs();
  if (!existsSync(CONFIG_FILE)) {
    throw new ConfigError(
      `Config file not found at ${CONFIG_FILE}. Run \`${cliCommand('init')}\` to create one.`,
    );
  }
  const raw = readFileSync(CONFIG_FILE, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`Config file is not valid JSON: ${(e as Error).message}`);
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Config validation failed:\n${result.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return result.data;
}

/**
 * 写入配置文件，权限 0600。
 */
export function saveConfig(cfg: Config): void {
  ensureDataDirs();
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
}

/**
 * 把内存里的 Config 应用一个 patch 后落盘。
 * 调用方用 mutator 直接改字段（推荐 immutable 风格：返回新对象也行）。
 *
 * 实现细节：写之前 deep-clone，避免外部 mutator 把传入的 cfg 改坏；
 * 写完用 ConfigSchema 再 parse 一遍兜底，防止 patch 写出非法值。
 */
export function patchAndSaveConfig(cfg: Config, mutator: (draft: Config) => void): Config {
  const draft = JSON.parse(JSON.stringify(cfg)) as Config;
  mutator(draft);
  const validated = ConfigSchema.parse(draft);
  saveConfig(validated);
  return validated;
}

/**
 * 生成最小可用的配置模板，供 init 命令使用。
 */
export function defaultConfig(appId: string, appSecret: string): Config {
  return ConfigSchema.parse({
    lark: { appId, appSecret },
  });
}
