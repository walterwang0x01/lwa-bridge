/**
 * LWA CLI 入口（主命令 `lwa`；兼容 `lwa-bridge` / `lark-kiro-bridge`）
 *
 * 子命令：
 *   (default) / code  本地 coding REPL（默认）
 *   chat              本地 IM 演练 REPL
 *   serve / run       Gateway：按 ingress.channels 连接飞书/Slack
 *   init / models / plan / service ...
 */
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONFIG_FILE, ensureDataDirs, LOGS_DIR } from './lib/paths.js';
import { CLI_NAME, cliCommand } from './lib/branding.js';
import { defaultConfig, loadConfig, saveConfig } from './lib/config.js';
import { runQrWizard } from './lib/qrWizard.js';
import { runBridge } from './core/bootstrap.js';
import { discoverRuntimeRegistry } from './runtime/registry.js';
import { formatModelTierSummary, suggestFastStrongModels } from './runtime/openaiModels.js';
import { getLogger } from './lib/logger.js';
import { getDaemonAdapter, DaemonError } from './daemon/index.js';
import { listProcesses, findProcess } from './daemon/registry.js';
import { listPlanIds, PLAN_PRESETS, resolvePlanId } from './runtime/planProfiles.js';

const program = new Command();

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')];
    for (const p of candidates) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, 'utf-8')) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    }
  } catch {
    // ignore
  }
  return '0.0.0';
}

async function runLocalRepl(
  mode: 'code' | 'chat' = 'code',
  opts?: { continue?: boolean; resume?: string },
): Promise<void> {
  if (!existsSync(CONFIG_FILE)) {
    console.error(`❌ Missing config at ${CONFIG_FILE}. Run \`${cliCommand('init')}\` first.`);
    process.exit(1);
  }
  // REPL：默认压低日志，避免打断底部输入（可用 LARK_KIRO_LOG_LEVEL=info 打开）
  if (!process.env['LARK_KIRO_LOG_LEVEL']) {
    process.env['LARK_KIRO_LOG_LEVEL'] = 'error';
  }
  await runBridge({
    cliOnly: true,
    cliMode: mode,
    cliContinue: opts?.continue,
    cliResumeId: opts?.resume,
  });
}

async function runGateway(opts: { chat?: boolean }): Promise<void> {
  if (!existsSync(CONFIG_FILE) && process.stdin.isTTY) {
    try {
      const { config } = await runQrWizard();
      saveConfig(config);
      console.log(`✅ 配置已保存到 ${CONFIG_FILE}\n`);
    } catch (e) {
      console.error(`扫码向导失败：${(e as Error).message}`);
      console.error(`改用手动模式：${cliCommand('init --manual')}\n`);
      process.exit(1);
    }
  }
  await runBridge({ attachCliChat: opts.chat });
  await new Promise(() => undefined);
}

program
  .name(CLI_NAME)
  .description('LWA — local multi-agent workbench (code REPL + chat rehearsal + Feishu gateway)')
  .version(readPackageVersion())
  .action(async () => {
    try {
      if (process.stdin.isTTY) {
        await runLocalRepl('code');
        return;
      }
      program.help();
    } catch (e) {
      const err = e as Error;
      console.error(`❌ ${err.message}`);
      if (process.env['LARK_KIRO_DEBUG']) console.error(err.stack);
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Interactive setup: scan QR or enter App ID/Secret')
  .option('--app-id <id>', 'Lark App ID (skip QR + prompts)')
  .option('--app-secret <secret>', 'Lark App Secret (skip QR + prompts)')
  .option('--manual', 'Force manual entry (skip QR wizard)')
  .option('--force', 'Overwrite existing config')
  .action(
    async (opts: { appId?: string; appSecret?: string; manual?: boolean; force?: boolean }) => {
      ensureDataDirs();
      if (existsSync(CONFIG_FILE) && !opts.force) {
        console.error(
          `Config already exists at ${CONFIG_FILE}. Use --force to overwrite, or edit it directly.`,
        );
        process.exit(1);
      }

      if (opts.appId && opts.appSecret) {
        saveConfig(defaultConfig(opts.appId, opts.appSecret));
        console.log(`✅ Wrote config to ${CONFIG_FILE}`);
        console.log(
          `  Code: ${cliCommand('code')}   Chat: ${cliCommand('chat')}   Gateway: ${cliCommand('serve')}`,
        );
        return;
      }

      if (!opts.manual && process.stdin.isTTY) {
        try {
          const { config } = await runQrWizard();
          saveConfig(config);
          console.log(`✅ 配置已保存到 ${CONFIG_FILE}`);
          console.log(`   本地：${cliCommand('code')}   飞书：${cliCommand('serve')}\n`);
          return;
        } catch (e) {
          console.error(`扫码向导失败：${(e as Error).message}`);
          console.error(`改用手动模式：${cliCommand('init --manual')}\n`);
          process.exit(1);
        }
      }

      let appId = opts.appId;
      let appSecret = opts.appSecret;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        if (!appId) appId = (await rl.question('Lark App ID: ')).trim();
        if (!appSecret) appSecret = (await rl.question('Lark App Secret: ')).trim();
      } finally {
        rl.close();
      }
      if (!appId || !appSecret) {
        console.error('App ID and Secret are required.');
        process.exit(1);
      }
      saveConfig(defaultConfig(appId, appSecret));
      console.log(`✅ Wrote config to ${CONFIG_FILE}`);
      console.log(`  Code: ${cliCommand('code')}   Gateway: ${cliCommand('serve')}`);
    },
  );

async function serveAction(opts: { chat?: boolean }): Promise<void> {
  try {
    await runGateway(opts);
  } catch (e) {
    const err = e as Error;
    console.error(`❌ ${err.message}`);
    if (process.env['LARK_KIRO_DEBUG']) console.error(err.stack);
    process.exit(1);
  }
}

program
  .command('code')
  .description('Local coding REPL (default; Kiro-first plan routing)')
  .option('--continue', 'Resume the most recent code session')
  .option('--resume <id>', 'Resume a specific CLI session id')
  .action(async (opts: { continue?: boolean; resume?: string }) => {
    try {
      await runLocalRepl('code', { continue: opts.continue, resume: opts.resume });
    } catch (e) {
      const err = e as Error;
      console.error(`❌ ${err.message}`);
      if (process.env['LARK_KIRO_DEBUG']) console.error(err.stack);
      process.exit(1);
    }
  });

program
  .command('serve')
  .description('Start gateway (Feishu/Slack per ingress.channels); opens Dashboard')
  .option('--chat', 'Also attach local REPL on this TTY')
  .action(serveAction);

program
  .command('run')
  .description('Alias of serve')
  .option('--chat', 'Also attach local REPL on this TTY')
  .action(serveAction);

program
  .command('chat')
  .description('Local IM-style REPL (Feishu persona rehearsal; no WebSocket)')
  .option('--continue', 'Resume the most recent chat session')
  .option('--resume <id>', 'Resume a specific CLI session id')
  .action(async (opts: { continue?: boolean; resume?: string }) => {
    try {
      await runLocalRepl('chat', { continue: opts.continue, resume: opts.resume });
    } catch (e) {
      const err = e as Error;
      console.error(`❌ ${err.message}`);
      if (process.env['LARK_KIRO_DEBUG']) console.error(err.stack);
      process.exit(1);
    }
  });

program
  .command('plan')
  .description('Show harness plan presets (kiro-unlimited+cursor-lite, …)')
  .argument('[id]', 'optional plan id')
  .action((id?: string) => {
    try {
      const cfg = existsSync(CONFIG_FILE) ? loadConfig() : null;
      const current = cfg ? resolvePlanId(cfg) : 'kiro-unlimited+cursor-lite';
      if (id) {
        if (!(id in PLAN_PRESETS)) {
          console.error(`Unknown plan: ${id}. Available: ${listPlanIds().join(', ')}`);
          process.exit(1);
        }
        const p = PLAN_PRESETS[id as keyof typeof PLAN_PRESETS];
        console.log(`## ${p.id}\n${p.label}`);
        console.log(JSON.stringify({ code: p.code, chat: p.chat, lark: p.lark }, null, 2));
        return;
      }
      console.log(`current plan: ${current}`);
      for (const pid of listPlanIds()) {
        const p = PLAN_PRESETS[pid];
        console.log(`- ${pid}: ${p.label}${pid === current ? ' ← current' : ''}`);
      }
      console.log(`\nSet in ~/.lwa/config.json: "runtime": { "plan": "${current}" }`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('models')
  .description('List models from OpenAI-compatible gateway profiles')
  .action(async () => {
    try {
      const cfg = loadConfig();
      const registry = await discoverRuntimeRegistry(cfg);
      const openai = registry.filter((e) => e.profile.kind === 'openai-compatible');
      if (openai.length === 0) {
        console.log('No openai-compatible profiles in config.');
        return;
      }
      for (const entry of openai) {
        console.log(`\n## ${entry.profileName}`);
        console.log(`configured model: ${entry.profile.model ?? '-'}`);
        if (entry.models.length === 0) {
          console.log(`models: ${entry.detail ?? 'unavailable'}`);
          continue;
        }
        const { fast, strong } = suggestFastStrongModels(entry.models);
        console.log(`gateway models (${entry.models.length}):`);
        console.log(formatModelTierSummary(entry.models, 20));
        console.log(`suggested fast: ${fast ?? '-'}`);
        console.log(`suggested strong: ${strong ?? '-'}`);
      }
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('config-show')
  .description('Show current config (with App Secret masked)')
  .action(() => {
    try {
      const cfg = loadConfig();
      const masked = {
        ...cfg,
        lark: {
          ...cfg.lark,
          appSecret: cfg.lark.appSecret ? cfg.lark.appSecret.slice(0, 4) + '****' : '',
        },
      };
      console.log(JSON.stringify(masked, null, 2));
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

async function withDaemon<T>(
  fn: (d: ReturnType<typeof getDaemonAdapter>) => Promise<T>,
): Promise<void> {
  try {
    const adapter = getDaemonAdapter();
    await fn(adapter);
  } catch (e) {
    if (e instanceof DaemonError) {
      console.error(`❌ ${e.message}`);
      console.error(`   Use \`${cliCommand('serve')}\` to start in foreground instead.`);
      process.exit(1);
    }
    throw e;
  }
}

const service = program.command('service').description('Manage background daemon');
service
  .command('install')
  .description('Install platform service definition')
  .action(async () => {
    await withDaemon((d) => d.install());
  });
service
  .command('uninstall')
  .description('Remove platform service definition')
  .action(async () => {
    await withDaemon((d) => d.uninstall());
  });
service
  .command('start')
  .description('Start the daemon')
  .action(async () => {
    await withDaemon((d) => d.start());
  });
service
  .command('stop')
  .description('Stop the daemon')
  .action(async () => {
    await withDaemon((d) => d.stop());
  });
service
  .command('status')
  .description('Show daemon status')
  .action(async () => {
    await withDaemon((d) => d.status());
  });

program
  .command('start')
  .description('Install (if needed) and start the background daemon')
  .action(async () => {
    await withDaemon(async (d) => {
      await d.install().catch((e) => {
        console.error(`(install) ${(e as Error).message}`);
      });
      await d.start();
    });
  });

program
  .command('stop')
  .description('Stop the background daemon')
  .action(async () => {
    await withDaemon((d) => d.stop());
  });

program
  .command('restart')
  .description('Restart the background daemon in place')
  .action(async () => {
    await withDaemon(async (d) => {
      await d.stop().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1500));
      await d.start();
    });
  });

program
  .command('status')
  .description('Show daemon status (alias of `service status`)')
  .action(async () => {
    await withDaemon((d) => d.status());
  });

program
  .command('unregister')
  .description('Remove daemon service definition and stop')
  .action(async () => {
    await withDaemon((d) => d.uninstall());
  });

program
  .command('ps')
  .description('List all running bridge processes on this host')
  .action(async () => {
    const list = await listProcesses();
    if (list.length === 0) {
      console.log('No running bridge processes.');
      console.log(`Logs: ${LOGS_DIR}/`);
      return;
    }
    console.log(`#  PID     SHORT   APP_ID                STARTED              CWD`);
    list.forEach((p, i) => {
      const started = new Date(p.startedAt).toISOString().replace('T', ' ').slice(0, 19);
      const num = String(i + 1).padEnd(2);
      const pid = String(p.pid).padEnd(7);
      const sh = p.shortId.padEnd(7);
      const app = p.appId.padEnd(20).slice(0, 20);
      console.log(`${num} ${pid} ${sh} ${app}  ${started}  ${p.cwd}`);
    });
    console.log(`\nLogs: ${LOGS_DIR}/`);
  });

program
  .command('kill <id>')
  .description('Kill a bridge process by pid / shortId / #N')
  .option('--force', 'Send SIGKILL after 2s if still alive')
  .action(async (id: string, opts: { force?: boolean }) => {
    const target = await findProcess(id);
    if (!target) {
      console.error(`No bridge process matches "${id}". Use \`ps\` to list.`);
      process.exit(1);
    }
    try {
      process.kill(target.pid, 'SIGTERM');
      console.log(`✅ SIGTERM sent to pid ${target.pid} (shortId ${target.shortId})`);
    } catch (e) {
      console.error(`Failed to signal pid ${target.pid}: ${(e as Error).message}`);
      process.exit(1);
    }
    if (opts.force) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        process.kill(target.pid, 0);
        process.kill(target.pid, 'SIGKILL');
        console.log(`✅ SIGKILL sent to pid ${target.pid}`);
      } catch {
        // already dead
      }
    }
  });

program.parseAsync(process.argv).catch((e) => {
  getLogger().child({ module: 'cli' }).error({ err: e }, 'cli error');
  process.exit(1);
});
