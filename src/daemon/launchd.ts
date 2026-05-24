/**
 * macOS launchd 守护进程支持
 *
 * 安装目标：~/Library/LaunchAgents/ai.lark-kiro-bridge.bot.plist
 *
 * install   生成 plist（指向 process.execPath + bin 路径）
 * uninstall 移除 plist 并 unload
 * start     bootstrap + kickstart
 * stop      bootout
 * status    打印 PID / 上次退出码 / 日志路径
 */
import { execa } from 'execa';
import { writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LOGS_DIR, ensureDataDirs } from '../lib/paths.js';
import { resolveBridgeBin } from './resolveBin.js';
import type { DaemonAdapter } from './types.js';

const LABEL = 'ai.lark-kiro-bridge.bot';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

/** UID for `launchctl bootstrap gui/<uid>` */
function uid(): number {
  // process.getuid 在 darwin 一定有
  return (process.getuid?.() ?? 0) | 0;
}

function buildPlist(program: string, args: string[]): string {
  const programArgsXml = [program, ...args]
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
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

export const launchdAdapter: DaemonAdapter = {
  platform: 'darwin',

  async install(): Promise<void> {
    ensureDataDirs();
    const { program, args } = await resolveBridgeBin();
    const plist = buildPlist(program, args);
    writeFileSync(PLIST_PATH, plist, { mode: 0o644 });
    chmodSync(PLIST_PATH, 0o644);
    console.log(`✅ Installed: ${PLIST_PATH}`);
    console.log(`    Program: ${program} ${args.join(' ')}`);
    console.log('');
    console.log('Next: lark-kiro-bridge start');
  },

  async uninstall(): Promise<void> {
    await this.stop().catch(() => undefined);
    if (existsSync(PLIST_PATH)) {
      unlinkSync(PLIST_PATH);
      console.log(`✅ Removed: ${PLIST_PATH}`);
    } else {
      console.log(`Already removed: ${PLIST_PATH}`);
    }
  },

  async start(): Promise<void> {
    if (!existsSync(PLIST_PATH)) {
      console.error(`No plist at ${PLIST_PATH}. Run 'lark-kiro-bridge install' first.`);
      process.exit(1);
    }
    await execa('launchctl', ['bootstrap', `gui/${uid()}`, PLIST_PATH], { reject: false });
    await execa('launchctl', ['kickstart', '-k', `gui/${uid()}/${LABEL}`], { reject: false });
    console.log(`✅ Started ${LABEL}`);
    console.log(`    Logs: ${LOGS_DIR}/daemon-stdout.log`);
  },

  async stop(): Promise<void> {
    await execa('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], { reject: false });
    console.log(`✅ Stopped ${LABEL}`);
  },

  async status(): Promise<void> {
    const r = await execa('launchctl', ['print', `gui/${uid()}/${LABEL}`], { reject: false });
    if (r.exitCode === 0) {
      const lines = r.stdout.split('\n');
      const interesting = lines.filter((l) =>
        /^\s*(state|pid|last exit code|program|stdout|stderr)/i.test(l),
      );
      console.log(`Status: ${LABEL}`);
      interesting.forEach((l) => {
        console.log(`  ${l.trim()}`);
      });
    } else {
      console.log(`Service ${LABEL} not loaded.`);
    }
    console.log(`Logs: ${LOGS_DIR}/`);
  },
};
