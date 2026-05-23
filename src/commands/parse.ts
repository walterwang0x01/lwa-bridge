/**
 * 斜杠命令解析
 *
 * 支持的命令：
 *   /new, /reset           重置当前会话
 *   /cd <path>             切换工作目录
 *   /pwd                   查看当前目录
 *   /ws list               列出所有命名工作区
 *   /ws save <name>        把当前 cwd 存为命名工作区
 *   /ws use <name>         切换到命名工作区
 *   /ws remove <name>      删除命名工作区
 *   /status                查看会话状态
 *   /stop                  停止当前任务
 *   /help                  帮助
 *
 * 不识别的 /xxx 命令会被原样转发给 Kiro（让用户自己定义）。
 */
export type ParsedCommand =
  | { kind: 'new' }
  | { kind: 'cd'; path: string }
  | { kind: 'pwd' }
  | { kind: 'ws-list' }
  | { kind: 'ws-save'; name: string }
  | { kind: 'ws-use'; name: string }
  | { kind: 'ws-remove'; name: string }
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'help' }
  | { kind: 'unknown'; raw: string };

/**
 * 尝试解析为命令。返回 null 表示不是命令（普通消息丢给 Kiro）。
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const rest = trimmed.slice(1);
  const [head, ...tailParts] = rest.split(/\s+/);
  const tail = tailParts.join(' ').trim();

  switch (head) {
    case 'new':
    case 'reset':
      return { kind: 'new' };
    case 'cd':
      if (!tail) return { kind: 'unknown', raw: trimmed };
      return { kind: 'cd', path: tail };
    case 'pwd':
      return { kind: 'pwd' };
    case 'status':
      return { kind: 'status' };
    case 'stop':
      return { kind: 'stop' };
    case 'help':
      return { kind: 'help' };
    case 'ws': {
      const [sub, ...nameParts] = tail.split(/\s+/);
      const name = nameParts.join(' ').trim();
      if (sub === 'list' || sub === '' || sub === undefined) return { kind: 'ws-list' };
      if (sub === 'save' && name) return { kind: 'ws-save', name };
      if (sub === 'use' && name) return { kind: 'ws-use', name };
      if ((sub === 'remove' || sub === 'rm' || sub === 'delete') && name) {
        return { kind: 'ws-remove', name };
      }
      return { kind: 'unknown', raw: trimmed };
    }
    default:
      return { kind: 'unknown', raw: trimmed };
  }
}
