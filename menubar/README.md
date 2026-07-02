# Lark-Kiro-Bridge 菜单栏工具

Mac 顶部菜单栏图标，替代"开终端敲命令"这一步。不是完整桌面 App——没有 Dock 图标、没有独立窗口，只是给已有的 CLI + Web Dashboard 加一个更方便的入口。

## 功能

- 🌉 菜单栏图标，点开显示当前 bridge 是否在跑（轮询 Dashboard `/api/overview`）
- 启动 / 停止 Bridge（调用 `lark-kiro-bridge start`/`stop`，走 launchd 守护）
- 一键打开 Dashboard 网页

## 构建

```bash
cd menubar
swift build -c release
```

产物在 `.build/release/LarkKiroMenuBar`。

## 运行

```bash
.build/release/LarkKiroMenuBar
```

## 设置成登录时自动启动（可选）

把编译好的二进制拖进「系统设置 → 通用 → 登录项」，或者写一个 launchd plist（跟 `lark-kiro-bridge service install` 生成的模式一致）。

## 依赖

只用系统自带的 AppKit + Foundation，不引入任何第三方包，不需要 Xcode 项目、不需要签名（本机自用够用；要分发给别人用需要额外做 codesign + notarize，不在本工具范围内）。

## 前提

- 已经跑过 `lark-kiro-bridge init` 完成飞书配置
- `lark-kiro-bridge` 命令在 PATH 上，或装在 `~/.npm-global/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 之一（`main.swift` 里 `resolveBridgeBin()` 的查找顺序）
