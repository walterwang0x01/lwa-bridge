const MARK_PATTERN = /^\p{Mark}+$/u;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
const REGIONAL_PATTERN = /\p{Regional_Indicator}/u;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function stripAnsi(text: string): string {
  let output = '';
  let index = 0;
  while (index < text.length) {
    if (text.charCodeAt(index) !== 0x1b) {
      output += text[index]!;
      index += 1;
      continue;
    }

    const kind = text[index + 1];
    if (kind === '[') {
      index += 2;
      while (index < text.length) {
        const code = text.charCodeAt(index);
        index += 1;
        if (code >= 0x40 && code <= 0x7e) break;
      }
      continue;
    }

    if (kind === ']') {
      index += 2;
      while (index < text.length) {
        if (text.charCodeAt(index) === 0x07) {
          index += 1;
          break;
        }
        if (text.charCodeAt(index) === 0x1b && text[index + 1] === '\\') {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }

    index += Math.min(2, text.length - index);
  }
  return output;
}

export function splitGraphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), ({ segment }) => segment);
}

function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isZeroWidth(codePoint: number, char: string): boolean {
  return (
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0x2060 ||
    codePoint === 0xfe0e ||
    codePoint === 0xfe0f ||
    MARK_PATTERN.test(char)
  );
}

function isFullwidth(codePoint: number): boolean {
  if (codePoint < 0x1100) return false;
  return (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3040 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function graphemeWidth(grapheme: string): number {
  if (!grapheme) return 0;
  if (
    EMOJI_PATTERN.test(grapheme) ||
    REGIONAL_PATTERN.test(grapheme) ||
    grapheme.includes('\u20e3')
  ) {
    return 2;
  }

  let width = 0;
  for (const char of grapheme) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isControl(codePoint) || isZeroWidth(codePoint, char)) continue;
    width += isFullwidth(codePoint) ? 2 : 1;
  }
  return width;
}

export function displayWidth(text: string): number {
  const plain = stripAnsi(text);
  let width = 0;
  for (const grapheme of splitGraphemes(plain)) width += graphemeWidth(grapheme);
  return width;
}

export function truncateDisplay(text: string, columns: number, suffix = '…'): string {
  if (columns <= 0) return '';
  if (displayWidth(text) <= columns) return text;

  const plain = stripAnsi(text);
  const suffixWidth = Math.min(columns, displayWidth(suffix));
  const budget = Math.max(0, columns - suffixWidth);
  let result = '';
  let width = 0;
  for (const grapheme of splitGraphemes(plain)) {
    const next = graphemeWidth(grapheme);
    if (width + next > budget) break;
    result += grapheme;
    width += next;
  }
  return `${result}${truncateDisplaySuffix(suffix, columns - width)}`;
}

function truncateDisplaySuffix(suffix: string, columns: number): string {
  let result = '';
  let width = 0;
  for (const grapheme of splitGraphemes(stripAnsi(suffix))) {
    const next = graphemeWidth(grapheme);
    if (width + next > columns) break;
    result += grapheme;
    width += next;
  }
  return result;
}

export function padToDisplayWidth(text: string, columns: number): string {
  return `${text}${' '.repeat(Math.max(0, columns - displayWidth(text)))}`;
}

export function centerDisplay(text: string, columns: number): string {
  const clipped = truncateDisplay(text, columns);
  const left = Math.max(0, Math.floor((columns - displayWidth(clipped)) / 2));
  return `${' '.repeat(left)}${clipped}`;
}

export function takeDisplayTail(text: string, columns: number, prefix = '…'): string {
  if (columns <= 0) return '';
  if (displayWidth(text) <= columns) return text;
  const prefixWidth = Math.min(columns, displayWidth(prefix));
  const budget = Math.max(0, columns - prefixWidth);
  const graphemes = splitGraphemes(stripAnsi(text));
  const kept: string[] = [];
  let width = 0;
  for (let i = graphemes.length - 1; i >= 0; i--) {
    const grapheme = graphemes[i]!;
    const next = graphemeWidth(grapheme);
    if (width + next > budget) break;
    kept.unshift(grapheme);
    width += next;
  }
  return `${truncateDisplaySuffix(prefix, columns - width)}${kept.join('')}`;
}
