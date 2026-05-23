/**
 * 帮助文本（Markdown 格式，直接当作 done 状态卡片正文）
 */
export function helpMarkdown(): string {
  return [
    '**🤖 lark-kiro-bridge** — 在飞书里调用本地 Kiro CLI',
    '',
    '**会话**',
    '`/new` 或 `/reset` — 重置当前会话',
    '`/status` — 查看当前 cwd / session / 工作区',
    '`/stop` — 停止正在跑的任务',
    '',
    '**工作目录**',
    '`/cd <path>` — 切换到指定目录（必须在白名单内）',
    '`/pwd` — 查看当前目录',
    '',
    '**命名工作区**',
    '`/ws list` — 列出所有命名工作区',
    '`/ws save <name>` — 把当前 cwd 存为工作区',
    '`/ws use <name>` — 切到命名工作区',
    '`/ws remove <name>` — 删除工作区',
    '',
    '**其他**',
    '`/help` — 显示这条帮助',
    '其他斜杠命令会被原样转发给 Kiro（你可以自己定义）',
    '',
    '**直接发文字** — 转发给 Kiro CLI 当作问题处理。',
    '群里需要 @机器人 才会响应；私聊任何消息都会触发。',
  ].join('\n');
}
