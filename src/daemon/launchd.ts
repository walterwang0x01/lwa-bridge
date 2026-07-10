/**
 * macOS launchd 守护进程支持
 *
 * 安装目标：~/Library/LaunchAgents/ai.lwa.bot.plist
 * 兼容旧标签 ai.lark-kiro-bridge.bot（stop/uninstall 会尝试卸载）
 */
import { execa } from 'execa';
import { writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LOGS_DIR, ensureDataDirs } from '../lib/paths.js';
import { resolveBridgeBin } from './resolveBin.js';
import { CLI_NEXT_HINT, LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL } from './names.js';
import { cliCommand } from '../lib/branding.js';
import type { DaemonAdapter } from './types.js';

const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const LEGACY_PLIST_PATH = join(
  homedir(),
  'Library',
  'LaunchAgents',
  `${LEGACY_LAUNCHD_LABEL}.plist`,
);

function uid(): number {
  return (process.getuid?.() ?? 0) | 0;
}

function buildPlist(label: string, program: string, args: string[]): string {
  const programArgsXml = [program, ...args]
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
${programArgsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOGS_DIR}/daemon-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOGS_DIR}/daemon-stderr.log</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}</string>
        <key>HOME</key>
        <string>${homedir()}</string>
    </dict>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function bootoutLabel(label: string): Promise<void> {
  await execa('launchctl', ['bootout', `gui/${uid()}/${label}`], { reject: false });
}

export const launchdAdapter: DaemonAdapter = {
  platform: 'darwin',

  async install(): Promise<void> {
    ensureDataDirs();
    const { program, args } = await resolveBridgeBin();
    const plist = buildPlist(LAUNCHD_LABEL, program, args);
    writeFileSync(PLIST_PATH, plist, { mode: 0o644 });
    chmodSync(PLIST_PATH, 0o644);
    console.log(`✅ Installed: ${PLIST_PATH}`);
    console.log(`    Program: ${program} ${args.join(' ')}`);
    console.log('');
    console.log(CLI_NEXT_HINT);
  },

  async uninstall(): Promise<void> {
    await this.stop().catch(() => undefined);
    for (const path of [PLIST_PATH, LEGACY_PLIST_PATH]) {
      if (existsSync(path)) {
        unlinkSync(path);
        console.log(`✅ Removed: ${path}`);
      }
    }
  },

  async start(): Promise<void> {
    if (!existsSync(PLIST_PATH)) {
      console.error(`No plist at ${PLIST_PATH}. Run '${cliCommand('service install')}' first.`);
      process.exit(1);
    }
    await execa('launchctl', ['bootstrap', `gui/${uid()}`, PLIST_PATH], { reject: false });
    await execa('launchctl', ['kickstart', '-k', `gui/${uid()}/${LAUNCHD_LABEL}`], {
      reject: false,
    });
    console.log(`✅ Started ${LAUNCHD_LABEL}`);
    console.log(`    Logs: ${LOGS_DIR}/daemon-stdout.log`);
  },

  async stop(): Promise<void> {
    await bootoutLabel(LAUNCHD_LABEL);
    await bootoutLabel(LEGACY_LAUNCHD_LABEL);
    console.log(`✅ Stopped ${LAUNCHD_LABEL} (and legacy label if loaded)`);
  },

  async status(): Promise<void> {
    for (const label of [LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL]) {
      const r = await execa('launchctl', ['print', `gui/${uid()}/${label}`], { reject: false });
      if (r.exitCode === 0) {
        const lines = r.stdout.split('\n');
        const interesting = lines.filter((l) =>
          /^\s*(state|pid|last exit code|program|stdout|stderr)/i.test(l),
        );
        console.log(`Status: ${label}`);
        interesting.forEach((l) => {
          console.log(`  ${l.trim()}`);
        });
        console.log(`Logs: ${LOGS_DIR}/`);
        return;
      }
    }
    console.log(`Service ${LAUNCHD_LABEL} not loaded.`);
    console.log(`Logs: ${LOGS_DIR}/`);
  },
};
