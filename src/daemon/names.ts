/**
 * 守护进程服务名：新名 + 旧名兼容（stop/uninstall 会尝试两者）
 */
import { cliCommand } from '../lib/branding.js';

export const LAUNCHD_LABEL = 'ai.lwa.bot';
export const LEGACY_LAUNCHD_LABEL = 'ai.lark-kiro-bridge.bot';

export const SYSTEMD_SERVICE_NAME = 'lwa';
export const LEGACY_SYSTEMD_SERVICE_NAME = 'lark-kiro-bridge';

export const WINDOWS_TASK_NAME = 'LWA.Bot';
export const LEGACY_WINDOWS_TASK_NAME = 'LarkKiroBridge.Bot';

export const CLI_NEXT_HINT = `Next: ${cliCommand('start')}`;
