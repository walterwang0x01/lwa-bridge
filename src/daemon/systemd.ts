/**
 * Linux systemd 用户单元守护
 *
 * 安装目标：~/.config/systemd/user/lark-kiro-bridge.service
 *
 * 用 systemd --user 而不是 system unit：
 *   - 不需要 sudo
 *   - 装在用户家目录，跟数据目录一起
 *   - 缺点：用户登出后默认会停。要让 daemon 在登出后还跑，
 *     用户需要执行一次 `loginctl enable-linger $USER`（README 里提示）
 *
 * 关键 systemctl 命令（都加 --user 标志）：
 *   daemon-reload          重新加载 unit 文件
 *   enable --now           开机自启 + 立刻启动
 *   start / stop           启停
 *   status                 看状态
 *   disable                取消开机自启
 */
import { execa } from 'execa';
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LOGS_DIR, ensureDataDirs } from '../lib/paths.js';
import { resolveBridgeBin } from './resolveBin.js';
import type { DaemonAdapter } from './types.js';

const SERVICE_NAME = 'lark-kiro-bridge';
const UNIT_FILE_NAME = `${SERVICE_NAME}.service`;
const UNIT_DIR = join(homedir(), '.config', 'systemd', 'user');
const UNIT_PATH = join(UNIT_DIR, UNIT_FILE_NAME);

function buildUnit(program: string, args: string[]): string {
  // ExecStart 要求绝对路径；shell 转义用空格分隔已足够（我们的路径不含空格）
  // 如果 program 含空格，用引号包起来。
  const execStart = [program, ...args]
    .map((s) => (s.includes(' ') ? `"${s.replaceAll('"', '\\"')}"` : s))
    .join(' ');

  return `[Unit]
Description=Lark Kiro Bridge — Feishu/Lark to local Kiro CLI bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
# 把 stdout/stderr 同时写文件 + journal
StandardOutput=append:${LOGS_DIR}/daemon-stdout.log
StandardError=append:${LOGS_DIR}/daemon-stderr.log
Environment=HOME=${homedir()}
# 继承当前 PATH，不强制覆盖；用户的 nvm/asdf 等也能找到 node
Environment=PATH=${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}

[Install]
WantedBy=default.target
`;
}

export const systemdAdapter: DaemonAdapter = {
  platform: 'linux',

  async install(): Promise<void> {
    ensureDataDirs();
    if (!existsSync(UNIT_DIR)) mkdirSync(UNIT_DIR, { recursive: true });
    const { program, args } = await resolveBridgeBin();
    const unit = buildUnit(program, args);
    writeFileSync(UNIT_PATH, unit, { mode: 0o644 });
    // 让 systemd 看到新 unit
    await execa('systemctl', ['--user', 'daemon-reload'], { reject: false });
    console.log(`✅ Installed: ${UNIT_PATH}`);
    console.log(`    Program: ${program} ${args.join(' ')}`);
    console.log('');
    console.log('Next: lark-kiro-bridge start');
    console.log('');
    console.log('💡 To survive logout (recommended for servers):');
    console.log(`    loginctl enable-linger ${process.env['USER'] ?? '$USER'}`);
  },

  async uninstall(): Promise<void> {
    await this.stop().catch(() => undefined);
    // 取消开机自启
    await execa('systemctl', ['--user', 'disable', UNIT_FILE_NAME], { reject: false });
    if (existsSync(UNIT_PATH)) {
      unlinkSync(UNIT_PATH);
      console.log(`✅ Removed: ${UNIT_PATH}`);
    } else {
      console.log(`Already removed: ${UNIT_PATH}`);
    }
    await execa('systemctl', ['--user', 'daemon-reload'], { reject: false });
  },

  async start(): Promise<void> {
    if (!existsSync(UNIT_PATH)) {
      console.error(`No unit at ${UNIT_PATH}. Run 'lark-kiro-bridge install' first.`);
      process.exit(1);
    }
    // enable --now = 开机自启 + 立刻启动；如果已经 enable 过会幂等
    const r = await execa('systemctl', ['--user', 'enable', '--now', UNIT_FILE_NAME], {
      reject: false,
    });
    if (r.exitCode !== 0) {
      console.error(`Failed to start: ${r.stderr || r.stdout}`);
      process.exit(1);
    }
    console.log(`✅ Started ${SERVICE_NAME}`);
    console.log(`    Logs: ${LOGS_DIR}/daemon-stdout.log`);
    console.log(`    Inspect: systemctl --user status ${SERVICE_NAME}`);
  },

  async stop(): Promise<void> {
    await execa('systemctl', ['--user', 'stop', UNIT_FILE_NAME], { reject: false });
    console.log(`✅ Stopped ${SERVICE_NAME}`);
  },

  async status(): Promise<void> {
    const r = await execa('systemctl', ['--user', 'status', UNIT_FILE_NAME, '--no-pager'], {
      reject: false,
    });
    // status 在服务停了的时候 exitCode = 3，正常运行 = 0；其他都打印
    if (r.stdout) {
      console.log(r.stdout);
    } else {
      console.log(`Service ${SERVICE_NAME} not loaded.`);
    }
    console.log(`Logs: ${LOGS_DIR}/`);
  },
};
