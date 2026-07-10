/**
 * Linux systemd 用户单元守护
 *
 * 安装目标：~/.config/systemd/user/lwa.service
 * 兼容旧单元 lark-kiro-bridge.service
 */
import { execa } from 'execa';
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LOGS_DIR, ensureDataDirs } from '../lib/paths.js';
import { resolveBridgeBin } from './resolveBin.js';
import { CLI_NEXT_HINT, LEGACY_SYSTEMD_SERVICE_NAME, SYSTEMD_SERVICE_NAME } from './names.js';
import { cliCommand } from '../lib/branding.js';
import type { DaemonAdapter } from './types.js';

const UNIT_DIR = join(homedir(), '.config', 'systemd', 'user');
const UNIT_FILE_NAME = `${SYSTEMD_SERVICE_NAME}.service`;
const UNIT_PATH = join(UNIT_DIR, UNIT_FILE_NAME);
const LEGACY_UNIT_FILE_NAME = `${LEGACY_SYSTEMD_SERVICE_NAME}.service`;
const LEGACY_UNIT_PATH = join(UNIT_DIR, LEGACY_UNIT_FILE_NAME);

function buildUnit(program: string, args: string[]): string {
  const execStart = [program, ...args]
    .map((s) => (s.includes(' ') ? `"${s.replaceAll('"', '\\"')}"` : s))
    .join(' ');

  return `[Unit]
Description=LWA — Lark Local Agent Workbench gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
StandardOutput=append:${LOGS_DIR}/daemon-stdout.log
StandardError=append:${LOGS_DIR}/daemon-stderr.log
Environment=HOME=${homedir()}
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
    await execa('systemctl', ['--user', 'daemon-reload'], { reject: false });
    console.log(`✅ Installed: ${UNIT_PATH}`);
    console.log(`    Program: ${program} ${args.join(' ')}`);
    console.log('');
    console.log(CLI_NEXT_HINT);
    console.log('');
    console.log('💡 To survive logout (recommended for servers):');
    console.log(`    loginctl enable-linger ${process.env['USER'] ?? '$USER'}`);
  },

  async uninstall(): Promise<void> {
    await this.stop().catch(() => undefined);
    for (const unitName of [UNIT_FILE_NAME, LEGACY_UNIT_FILE_NAME]) {
      await execa('systemctl', ['--user', 'disable', unitName], { reject: false });
    }
    for (const path of [UNIT_PATH, LEGACY_UNIT_PATH]) {
      if (existsSync(path)) {
        unlinkSync(path);
        console.log(`✅ Removed: ${path}`);
      }
    }
    await execa('systemctl', ['--user', 'daemon-reload'], { reject: false });
  },

  async start(): Promise<void> {
    if (!existsSync(UNIT_PATH)) {
      console.error(`No unit at ${UNIT_PATH}. Run '${cliCommand('service install')}' first.`);
      process.exit(1);
    }
    const r = await execa('systemctl', ['--user', 'enable', '--now', UNIT_FILE_NAME], {
      reject: false,
    });
    if (r.exitCode !== 0) {
      console.error(`Failed to start: ${r.stderr || r.stdout}`);
      process.exit(1);
    }
    console.log(`✅ Started ${SYSTEMD_SERVICE_NAME}`);
    console.log(`    Logs: ${LOGS_DIR}/daemon-stdout.log`);
    console.log(`    Inspect: systemctl --user status ${SYSTEMD_SERVICE_NAME}`);
  },

  async stop(): Promise<void> {
    for (const unitName of [UNIT_FILE_NAME, LEGACY_UNIT_FILE_NAME]) {
      await execa('systemctl', ['--user', 'stop', unitName], { reject: false });
    }
    console.log(`✅ Stopped ${SYSTEMD_SERVICE_NAME} (and legacy unit if loaded)`);
  },

  async status(): Promise<void> {
    for (const unitName of [UNIT_FILE_NAME, LEGACY_UNIT_FILE_NAME]) {
      const r = await execa('systemctl', ['--user', 'status', unitName, '--no-pager'], {
        reject: false,
      });
      if (r.exitCode === 0 || r.stdout) {
        console.log(r.stdout);
        console.log(`Logs: ${LOGS_DIR}/`);
        return;
      }
    }
    console.log(`Service ${SYSTEMD_SERVICE_NAME} not loaded.`);
    console.log(`Logs: ${LOGS_DIR}/`);
  },
};
