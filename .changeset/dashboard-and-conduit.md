---
"lark-kiro-bridge": minor
---

新增只读 Web Dashboard + `/conduit` 串联 kiro-conduit 多 agent 并行编排

- Web Dashboard：bridge 启动时自动在本机起一个只读 HTTP server（默认
  `http://127.0.0.1:5180`），Vue 3 + Vite 构建，展示会话 / 定时任务 / 进程 /
  `~/.kiro/skills` 技能清单 / 最近日志，5 秒自动刷新。默认开启，
  `dashboard.enabled: false` 可关闭，端口可配。绑定 `127.0.0.1`，纯只读，
  不暴露任何写操作；配合 `tailscale serve` 可从手机访问。
- `/conduit run [--merge]` `/conduit plan <spec.md>`：把
  [kiro-conduit](https://github.com/walterwang0x01/lwa-conduit)（多 agent
  DAG 并行编排器）串进飞书交互。`run` 默认不合并（只产出分支供 review）；
  `--merge` 会先弹二次确认卡片（合并是不可逆操作）。执行走 ChatPipeline，
  可被新消息 / `/stop` 打断，中止时通过 AbortSignal 真正终止 conduit 子进程
  （而不是只是卡片显示中止、进程仍在跑）。
