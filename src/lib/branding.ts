/**
 * LWA 产品命名与 CLI 品牌常量。
 *
 * 主命令：`lwa`；`lwa-bridge` / `lark-kiro-bridge` 为兼容别名。
 * npm 包名暂保留 `lark-kiro-bridge`，避免 registry 断裂。
 */
export const CLI_NAME = 'lwa';

export const CLI_BIN_ALIASES = ['lwa-bridge', 'lark-kiro-bridge'] as const;

/** 按优先级尝试的 CLI 可执行名（全局安装 / PATH 探测） */
export const CLI_BIN_NAMES = [CLI_NAME, ...CLI_BIN_ALIASES] as const;

export const NPM_PACKAGE_NAME = 'lark-kiro-bridge';

export const DATA_DIR_NAME = '.lwa';
export const LEGACY_DATA_DIR_NAME = '.lark-kiro-bridge';

export const PRODUCT_TITLE = 'LWA';
export const PRODUCT_SUBTITLE = 'Lark Local Agent Workbench';

export function cliCommand(subcommand: string): string {
  return `${CLI_NAME} ${subcommand}`;
}

export function dataDirTilde(): string {
  return `~/${DATA_DIR_NAME}`;
}

export function configPathTilde(): string {
  return `${dataDirTilde()}/config.json`;
}
