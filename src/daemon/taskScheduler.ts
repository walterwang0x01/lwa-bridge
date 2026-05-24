/**
 * Windows Task Scheduler 守护
 *
 * 安装目标：
 *   - 任务名: LarkKiroBridge.Bot
 *   - 触发条件: ONLOGON（用户登录时启动）
 *   - 启动器: %USERPROFILE%\.lark-kiro-bridge\daemon-launcher.cmd
 *
 * 为什么要包一层 .cmd 启动器？
 *   schtasks 的 /TR 字段不擅长处理多参数 + 输出重定向；用 .cmd 包起来更可靠：
 *   .cmd 里能写 cd / 重定向 / 错误处理等。还能让用户随时手动双击运行调试。
 *
 * 关键命令：
 *   schtasks /Create /TN LarkKiroBridge.Bot /SC ONLOGON /TR "..." /F
 *   schtasks /Run    /TN LarkKiroBridge.Bot
 *   schtasks /End    /TN LarkKiroBridge.Bot
 *   schtasks /Delete /TN LarkKiroBridge.Bot /F
 *   schtasks /Query  /TN LarkKiroBridge.Bot /V /FO LIST
 */
import { execa } from 'execa';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LOGS_DIR, DATA_DIR, ensureDataDirs } from '../lib/paths.js';
import { resolveBridgeBin } from './resolveBin.js';
import type { DaemonAdapter } from './types.js';

const TASK_NAME = 'LarkKiroBridge.Bot';
const LAUNCHER_PATH = join(DATA_DIR, 'daemon-launcher.cmd');

function buildLauncher(program: string, args: string[]): string {
  // .cmd 里转义：双引号包参数 + 把 stdout/stderr 同时重定向。
  // %~dp0 表示脚本所在目录；这里直接用绝对路径更稳。
  const cmdLine = [program, ...args].map((s) => `"${s}"`).join(' ');
  const stdoutLog = join(LOGS_DIR, 'daemon-stdout.log');
  const stderrLog = join(LOGS_DIR, 'daemon-stderr.log');
  return `@echo off
REM lark-kiro-bridge daemon launcher (auto-generated, do not edit by hand)
REM 由 schtasks ONLOGON 任务触发；包一层 .cmd 让重定向 + 多参数更可靠
cd /d "${homedir()}"
${cmdLine} >> "${stdoutLog}" 2>> "${stderrLog}"
`;
}

export const taskSchedulerAdapter: DaemonAdapter = {
  platform: 'win32',

  async install(): Promise<void> {
    ensureDataDirs();
    const { program, args } = await resolveBridgeBin();
    const launcher = buildLauncher(program, args);
    writeFileSync(LAUNCHER_PATH, launcher, 'utf-8');
    // 创建/覆盖 ONLOGON 任务；/F 强制覆盖现有
    const r = await execa(
      'schtasks',
      ['/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/TR', LAUNCHER_PATH, '/F', '/RL', 'LIMITED'],
      { reject: false },
    );
    if (r.exitCode !== 0) {
      console.error(`Failed to create scheduled task: ${r.stderr || r.stdout}`);
      process.exit(1);
    }
    console.log(`✅ Installed: scheduled task ${TASK_NAME}`);
    console.log(`    Launcher: ${LAUNCHER_PATH}`);
    console.log(`    Program:  ${program} ${args.join(' ')}`);
    console.log('');
    console.log('Next: lark-kiro-bridge start');
  },

  async uninstall(): Promise<void> {
    await this.stop().catch(() => undefined);
    const r = await execa('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { reject: false });
    if (r.exitCode === 0) {
      console.log(`✅ Removed scheduled task ${TASK_NAME}`);
    } else if (/cannot find/i.test(r.stderr) || /not exist/i.test(r.stderr)) {
      console.log(`Already removed: ${TASK_NAME}`);
    } else {
      console.error(`Failed to delete task: ${r.stderr || r.stdout}`);
    }
    if (existsSync(LAUNCHER_PATH)) {
      unlinkSync(LAUNCHER_PATH);
      console.log(`✅ Removed launcher: ${LAUNCHER_PATH}`);
    }
  },

  async start(): Promise<void> {
    if (!existsSync(LAUNCHER_PATH)) {
      console.error(`No launcher at ${LAUNCHER_PATH}. Run 'lark-kiro-bridge install' first.`);
      process.exit(1);
    }
    const r = await execa('schtasks', ['/Run', '/TN', TASK_NAME], { reject: false });
    if (r.exitCode !== 0) {
      console.error(`Failed to run task: ${r.stderr || r.stdout}`);
      process.exit(1);
    }
    console.log(`✅ Started ${TASK_NAME}`);
    console.log(`    Logs: ${LOGS_DIR}\\daemon-stdout.log`);
  },

  async stop(): Promise<void> {
    // /End 让任务停止，但 schtasks /End 实际上是 "stop running instance"
    await execa('schtasks', ['/End', '/TN', TASK_NAME], { reject: false });
    console.log(`✅ Stopped ${TASK_NAME}`);
  },

  async status(): Promise<void> {
    const r = await execa('schtasks', ['/Query', '/TN', TASK_NAME, '/V', '/FO', 'LIST'], {
      reject: false,
    });
    if (r.exitCode === 0) {
      // /V 输出超长，挑关键字段展示
      const interesting = r.stdout
        .split(/\r?\n/)
        .filter((l) =>
          /^(TaskName|Status|Last Run Time|Last Result|Next Run Time|Run As User):/i.test(l),
        )
        .map((l) => `  ${l.trim()}`);
      console.log(`Status: ${TASK_NAME}`);
      interesting.forEach((l) => {
        console.log(l);
      });
    } else {
      console.log(`Scheduled task ${TASK_NAME} not found.`);
    }
    console.log(`Logs: ${LOGS_DIR}\\`);
  },
};
