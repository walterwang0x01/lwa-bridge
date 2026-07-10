/**
 * Windows Task Scheduler 守护
 *
 * 安装目标：
 *   - 任务名: LWA.Bot
 *   - 启动器: %USERPROFILE%\.lwa\daemon-launcher.cmd
 * 兼容旧任务 LarkKiroBridge.Bot
 */
import { execa } from 'execa';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LOGS_DIR, DATA_DIR, ensureDataDirs } from '../lib/paths.js';
import { resolveBridgeBin } from './resolveBin.js';
import { CLI_NEXT_HINT, LEGACY_WINDOWS_TASK_NAME, WINDOWS_TASK_NAME } from './names.js';
import { cliCommand } from '../lib/branding.js';
import type { DaemonAdapter } from './types.js';

const LAUNCHER_PATH = join(DATA_DIR, 'daemon-launcher.cmd');

function buildLauncher(program: string, args: string[]): string {
  const cmdLine = [program, ...args].map((s) => `"${s}"`).join(' ');
  const stdoutLog = join(LOGS_DIR, 'daemon-stdout.log');
  const stderrLog = join(LOGS_DIR, 'daemon-stderr.log');
  return `@echo off
REM LWA daemon launcher (auto-generated, do not edit by hand)
cd /d "${homedir()}"
${cmdLine} >> "${stdoutLog}" 2>> "${stderrLog}"
`;
}

async function deleteTask(name: string): Promise<void> {
  const r = await execa('schtasks', ['/Delete', '/TN', name, '/F'], { reject: false });
  if (r.exitCode === 0) {
    console.log(`✅ Removed scheduled task ${name}`);
  }
}

export const taskSchedulerAdapter: DaemonAdapter = {
  platform: 'win32',

  async install(): Promise<void> {
    ensureDataDirs();
    const { program, args } = await resolveBridgeBin();
    const launcher = buildLauncher(program, args);
    writeFileSync(LAUNCHER_PATH, launcher, 'utf-8');
    const r = await execa(
      'schtasks',
      [
        '/Create',
        '/TN',
        WINDOWS_TASK_NAME,
        '/SC',
        'ONLOGON',
        '/TR',
        LAUNCHER_PATH,
        '/F',
        '/RL',
        'LIMITED',
      ],
      { reject: false },
    );
    if (r.exitCode !== 0) {
      console.error(`Failed to create scheduled task: ${r.stderr || r.stdout}`);
      process.exit(1);
    }
    console.log(`✅ Installed: scheduled task ${WINDOWS_TASK_NAME}`);
    console.log(`    Launcher: ${LAUNCHER_PATH}`);
    console.log(`    Program:  ${program} ${args.join(' ')}`);
    console.log('');
    console.log(CLI_NEXT_HINT);
  },

  async uninstall(): Promise<void> {
    await this.stop().catch(() => undefined);
    await deleteTask(WINDOWS_TASK_NAME);
    await deleteTask(LEGACY_WINDOWS_TASK_NAME);
    if (existsSync(LAUNCHER_PATH)) {
      unlinkSync(LAUNCHER_PATH);
      console.log(`✅ Removed launcher: ${LAUNCHER_PATH}`);
    }
  },

  async start(): Promise<void> {
    if (!existsSync(LAUNCHER_PATH)) {
      console.error(
        `No launcher at ${LAUNCHER_PATH}. Run '${cliCommand('service install')}' first.`,
      );
      process.exit(1);
    }
    const r = await execa('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME], { reject: false });
    if (r.exitCode !== 0) {
      console.error(`Failed to run task: ${r.stderr || r.stdout}`);
      process.exit(1);
    }
    console.log(`✅ Started ${WINDOWS_TASK_NAME}`);
    console.log(`    Logs: ${LOGS_DIR}\\daemon-stdout.log`);
  },

  async stop(): Promise<void> {
    for (const name of [WINDOWS_TASK_NAME, LEGACY_WINDOWS_TASK_NAME]) {
      await execa('schtasks', ['/End', '/TN', name], { reject: false });
    }
    console.log(`✅ Stopped ${WINDOWS_TASK_NAME} (and legacy task if running)`);
  },

  async status(): Promise<void> {
    for (const name of [WINDOWS_TASK_NAME, LEGACY_WINDOWS_TASK_NAME]) {
      const r = await execa('schtasks', ['/Query', '/TN', name, '/V', '/FO', 'LIST'], {
        reject: false,
      });
      if (r.exitCode === 0) {
        const interesting = r.stdout
          .split(/\r?\n/)
          .filter((l) =>
            /^(TaskName|Status|Last Run Time|Last Result|Next Run Time|Run As User):/i.test(l),
          )
          .map((l) => `  ${l.trim()}`);
        console.log(`Status: ${name}`);
        interesting.forEach((l) => {
          console.log(l);
        });
        console.log(`Logs: ${LOGS_DIR}\\`);
        return;
      }
    }
    console.log(`Scheduled task ${WINDOWS_TASK_NAME} not found.`);
    console.log(`Logs: ${LOGS_DIR}\\`);
  },
};
