import {
  centerDisplay,
  displayWidth,
  padToDisplayWidth,
  stripAnsi,
  truncateDisplay,
} from './terminalWidth.js';

export type ThemeMode = 'light' | 'dark';

type ThemePalette = {
  brand: string;
  brandBright: string;
  accent: string;
  text: string;
  muted: string;
  inputBg: string;
  inputFg: string;
  ok: string;
  warn: string;
  err: string;
  run: string;
};

const PALETTES: Record<ThemeMode, ThemePalette> = {
  light: {
    brand: '\x1b[38;2;13;116;110m',
    brandBright: '\x1b[38;2;15;118;110m',
    accent: '\x1b[38;2;180;83;9m',
    text: '\x1b[38;2;15;23;42m',
    muted: '\x1b[38;2;100;116;139m',
    inputBg: '\x1b[48;2;248;250;252m',
    inputFg: '\x1b[38;2;30;41;59m',
    ok: '\x1b[38;2;5;150;105m',
    warn: '\x1b[38;2;180;83;9m',
    err: '\x1b[38;2;220;38;38m',
    run: '\x1b[38;2;2;132;199m',
  },
  dark: {
    brand: '\x1b[38;2;13;148;136m',
    brandBright: '\x1b[38;2;45;212;191m',
    accent: '\x1b[38;2;245;158;11m',
    text: '\x1b[38;2;226;232;240m',
    muted: '\x1b[38;2;148;163;184m',
    inputBg: '\x1b[48;2;23;31;42m',
    inputFg: '\x1b[38;2;226;232;240m',
    ok: '\x1b[38;2;52;211;153m',
    warn: '\x1b[38;2;251;191;36m',
    err: '\x1b[38;2;248;113;113m',
    run: '\x1b[38;2;56;189;248m',
  },
};

export function resolveThemeMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ThemeMode {
  const explicit = env['LWA_THEME']?.trim().toLowerCase();
  if (explicit === 'light' || explicit === 'dark') return explicit;

  const background = env['COLORFGBG']?.split(';').at(-1);
  const color = background === undefined ? Number.NaN : Number.parseInt(background, 10);
  if (color === 7 || color === 15) return 'light';
  return 'dark';
}

export function paletteFor(mode: ThemeMode = resolveThemeMode()): ThemePalette {
  return PALETTES[mode];
}

const activePalette = paletteFor();

export const T = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  ...activePalette,
} as const;

const NO_COLOR = process.env['NO_COLOR'] != null || process.env['LWA_NO_COLOR'] === '1';

export function paint(color: string, text: string): string {
  if (NO_COLOR || !process.stdout.isTTY) return text;
  return `${color}${text}${T.reset}`;
}

export function brand(text: string): string {
  return paint(T.brandBright, text);
}

export function muted(text: string): string {
  return paint(T.muted, text);
}

export function accent(text: string): string {
  return paint(T.accent, text);
}

/** 输入 pane 一行：按终端显示宽度铺满，并使用与终端主题匹配的轻量表面。 */
export function formatInputPaneLine(
  text: string,
  cols: number,
  opts?: { colored?: boolean; theme?: ThemeMode },
): string {
  const colored = opts?.colored ?? (!NO_COLOR && Boolean(process.stdout.isTTY));
  const palette = paletteFor(opts?.theme);
  const plain = truncateDisplay(stripAnsi(text), Math.max(0, cols));
  const line = padToDisplayWidth(plain, Math.max(0, cols));
  if (!colored) return line;
  return `${palette.inputBg}${palette.inputFg}${line}${T.reset}`;
}

const WIDE_LOGO = [
  '██╗     ██╗    ██╗ █████╗ ',
  '██║     ██║ █╗ ██║██╔══██╗',
  '██║     ██║███╗██║███████║',
  '███████╗╚███╔███╔╝██║  ██║',
  '╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝',
];

/** 启动 hero：宽屏展示品牌字标，窄屏退化为紧凑标题，始终水平居中。 */
export function formatShellBanner(opts: {
  title: string;
  subtitle: string;
  hint: string;
  cols?: number;
  colored?: boolean;
}): string {
  const cols = Math.max(20, opts.cols ?? process.stdout.columns ?? 80);
  const colored = opts.colored ?? (!NO_COLOR && Boolean(process.stdout.isTTY));
  const color = (code: string, text: string) => (colored ? `${code}${text}${T.reset}` : text);
  const center = (text: string) => centerDisplay(text, cols);
  const lines: string[] = [];

  if (cols >= 54) {
    lines.push(...WIDE_LOGO.map((line) => center(color(T.brandBright, line))));
  } else {
    lines.push(center(color(`${T.bold}${T.brandBright}`, '◆ LWA')));
  }

  lines.push('');
  lines.push(center(color(`${T.bold}${T.text}`, `LWA · ${opts.title}`)));
  lines.push(center(color(T.muted, opts.subtitle)));
  lines.push('');
  lines.push(center(color(T.accent, opts.hint)));
  return lines.join('\n');
}

/** 输入前状态（soft / plain 模式）。 */
export function formatShellStatusBlock(primary: string, secondary?: string): string {
  const rail = paint(T.brand, '▌');
  const lines = [`${rail} ${paint(T.bold + T.brandBright, primary)}`];
  if (secondary) lines.push(`${rail} ${muted(secondary)}`);
  return `\n${lines.join('\n')}\n`;
}

/** 固定底栏：主状态高亮，补充状态弱化，审批模式靠右。 */
export function formatDockedStatusLine(opts: {
  primary: string;
  secondary?: string;
  approval?: string;
  cols: number;
}): string {
  const cols = Math.max(1, opts.cols);
  const rail = paint(T.brand, '▌');
  const approvalText = opts.approval?.trim() ?? '';
  const right = approvalText ? paint(T.ok, approvalText) : '';
  const rightWidth = displayWidth(approvalText);
  const leftBudget = Math.max(1, cols - (right ? rightWidth + 1 : 0));
  const prefixWidth = displayWidth('▌ ');
  const primaryBudget = Math.max(1, leftBudget - prefixWidth);
  const primaryText = truncateDisplay(opts.primary || 'Auto', primaryBudget);

  let left = `${rail} ${paint(T.bold + T.brandBright, primaryText)}`;
  const secondary = opts.secondary?.trim();
  if (secondary) {
    const remaining = leftBudget - displayWidth(left) - displayWidth(' · ');
    if (remaining >= 8) {
      left += `${muted(' · ')}${muted(truncateDisplay(secondary, remaining))}`;
    }
  }

  if (!right) return truncateDisplay(left, cols);
  const gap = Math.max(1, cols - displayWidth(left) - rightWidth);
  return `${left}${' '.repeat(gap)}${right}`;
}

export function shellPrompt(): string {
  return accent('❯ ');
}

export function turnRail(): string {
  return paint(T.brand, '▎');
}

export function formatTurnHeader(opts: {
  routeMode: string;
  engine: string;
  model?: string;
  cwd: string;
}): string {
  const rail = turnRail();
  const route =
    opts.routeMode === 'Auto'
      ? `${paint(T.bold + T.brandBright, 'Auto')}${muted(` → ${opts.engine}`)}`
      : paint(T.bold + T.brandBright, opts.routeMode);
  const model = opts.model ? muted(` · ${opts.model}`) : '';
  return `\n${rail} ${route}${model}  ${muted(opts.cwd)}\n`;
}

export function formatThinkingLine(snippet?: string): string {
  const rail = turnRail();
  const body = snippet
    ? `${muted('thinking')} ${paint(T.dim, snippet.slice(0, 48))}`
    : muted('thinking…');
  return `\r${rail} ${body}\x1b[K`;
}

export function formatTurnFooter(opts: { secs: string; toolCount: number }): string {
  const rail = turnRail();
  const tools =
    opts.toolCount > 0 ? ` · ${opts.toolCount} tool${opts.toolCount === 1 ? '' : 's'}` : '';
  // 末尾多留一个空行：非 docked 简化模式没有清屏重绘能力，
  // 这里是"本轮回复结束"与"下一轮状态栏/输入提示"之间唯一的视觉分隔。
  return `${rail} ${muted(`done · ${opts.secs}s${tools}`)}\n\n`;
}
