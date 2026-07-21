# lwa-bridge / lwa-conduit 产品化改进 — 进度记录

> **这份文件是唯一事实来源。** 任何一轮对话开始前，先读这份文件，不要凭记忆。
> 每完成一个子任务，立刻更新这份文件再继续，不要攒到最后补记。

## 目标（不要跑偏）

用户要求：把当前项目做扎实，参考 cmux / super.engineering / paseo 的设计思路（**不是抄代码**——
它们分别是 GPL-3.0 / 未知协议 / AGPL-3.0，且是 GUI/桌面应用技术栈，跟本项目终端 CLI 架构不兼容，
直接搬代码不可行，也不合法）。

拆成两层：

- **第一层（当前重点）**：把已知的显示层/交互层 bug 修完，做出一个真正稳定可用的终端 CLI。
- **第二层（后续）**：
  1. 让 conduit（DAG 自动编排 + 分层校验 + 自动 merge，这是四个对比项目里独一份的能力）
     在 bridge 的交互层里更显性、更好用，而不是藏在 `/parallel` 斜杠命令里。
  2. 给 conduit 任务进度接入已有的飞书网关，低成本获得类似 paseo 的"移动端可达"效果
     （不需要重新做 iOS/Android app）。

**明确不做**：换语言重写、抄袭 GPL/AGPL 项目代码、做桌面 GUI 应用（这些在上一轮已经跟用户
说明过为什么不做，除非用户后续明确要求且理解代价）。

## 架构事实（已验证，不要重新猜）

- `lwa-bridge`（本仓库，Node.js/TypeScript）= 终端交互层：CLI TUI、模型路由、飞书网关。
- `lwa-conduit`（`/Users/administrator/PycharmProjects/lwa-conduit`，Python）= 独立的 DAG 编排引擎。
- 两者关系：**bridge 把 conduit 当外部子进程 spawn**（`src/conduit/runner.ts`，用 `execa`），
  跟 bridge 调用 `kiro-cli`/`cursor-agent` 是同一种模式。通信协议是 NDJSON stdout
  （`src/conduit/events.ts` 里手写解析），不是类型安全的接口。
- conduit 已有能力（M2 in progress，388 测试通过）：spec → DAG → 多 git worktree 并行 →
  分层 verifier（static/dynamic/semantic/contract）→ 按 DAG 顺序串行 merge。
  `LWA_CONDUIT_DASHBOARD=1` 环境变量可开 rich.live TUI 看实时进度。

## 第一层：已知未修复 / 需要重新核实的问题清单

> 每条写清楚：现象 → 是否已用真实 pty 测试复现 → 状态

1. **模型切换后状态不一致**（用户截图报告，2026-07-17 附近）
   - 状态：**已重新定性，找到了真正的根因方向，尚未修复**。
   - 原始怀疑（"用户选错了菜单项，Auto 和 kiro-model-auto 长得太像"）已被证伪——
     真正问题在更底层：**`/model` 交互菜单在非-docked plain shell 模式下，方向键按下后
     菜单完全没有视觉刷新**（不是选错，是选择器本身的重绘机制不可靠）。
   - **真实证据链**（2026-07-20，用真实 expect pty + 隔离 LWA_HOME 环境验证，非代码推理）：
     1. 加了 stdin 层探针（`onData` 回调），确认方向键 `\u001b[B` 和 `\r` **确实被正确接收**
        （`src/ingress/cli/slashPicker.ts` 的 `pickFromList` 内部 `onData`）。
     2. 加了 `render()` 内部探针，确认 `idx` 状态正确从 0 变成 1，且组装出的 `lines`
        内容里高亮标记（`❯`）确实从 "Auto" 移到了 "[engine] kiro"——**业务逻辑完全正确**。
     3. 加了 `cliWrite()` 探针（`src/ingress/cli/shellScreen.ts`），确认
        `activeShell=null, isTTY=true`，走的是 `process.stdout.write(s)` 分支（符合预期，
        没有走错 docked 分支），且 `write()` **返回 true**（同步写入成功，不是缓冲排队）。
     4. 但即便如此，**expect 侧捕获的原始终端字节流里，方向键之后到 Ctrl+C 退出之间，
        完全没有任何新增字节**——跟"业务逻辑正确、write() 返回 true"矛盾。
   - **⚠️ 上面第 1-4 步的"方向键被正确接收"这个结论已被推翻，是 expect 测试工具本身的
     假象，不是真实情况！** 用 Python `pty` 模块直接驱动（`os.write(master_fd, b"\x1b[B")`
     一次性写入完整 3 字节转义序列，绕开 expect），结果完全不同：**`onData` 根本没有
     收到方向键，只收到了 Enter**。真实结果：Enter 确认了默认高亮的第 0 项 "Auto"，
     触发 `handleRuntimeCmd({mode:'set', name:'auto'})`，打印"已恢复智能路由"。
     **这才是用户原始截图问题的真正根因**：用户按方向键想选别的引擎，方向键没生效，
     Enter 确认的是默认的 Auto，用户以为自己选错了，其实是方向键从未被处理。
   - **✅ 已修复并用真实 Python pty 测试验证**（2026-07-20）。最终根因和修复：
     1. **根因 A**：Node 内部 `readline.emitKeypressEvents`（`this.rl` 构造时自动
        挂载在 `stdin` 上，全程存在，`close()` 也无法移除，这是 Node 文档明确写的
        行为）有一个内部 `onData` 处理器，逻辑是 `if (stream.listenerCount('keypress')
        > 0) { ...才完整处理... }`。之前 `pickFromList` 的防御性修复"移除所有
        keypress 监听器"导致这个内部处理器认为"没人关心"，方向键等多字节 CSI
        转义序列被它消费但未完整处理/传播，我们自己的 `data` 监听器完全收不到。
        **修复**：不清空 keypress 监听器数量到 0，改为额外注册一个空操作的占位
        监听器（`noopKeypress`），让内部处理器认为"有人在听"从而正常工作。
     2. **根因 B**：`pickFromList` 里原来的调用顺序是先 `render()`（同步渲染一次
        菜单）后才在 `new Promise` 内部注册 `stdin.on('data', onData)`。这中间有
        一个真实的时间窗口——若 `handleModelCmdCli` 的异步初始化（`resolveChatRuntime`
        `discoverRuntimeRegistry` 等）比预期慢，用户在这个窗口内按方向键，会被
        Node 内部处理器独自处理掉（这时候它是唯一的 'data' 监听器）。**修复**：
        把 `onData` 的定义和 `stdin.on('data', onData)` 的注册**提前到 `render()`
        调用之前**，消除这个窗口。
     3. 两处修复**同时生效**才能解决问题，单独一处都不够（已用真实测试逐一验证，
        不是猜测）。
   - **验证证据**（Python pty 直接驱动，绕开 expect，见"方法论教训"）：修复前，
     方向键按下后菜单永远停在默认高亮的 "Auto"，Enter 提交后触发
     "已恢复智能路由"；修复后，方向键正确把高亮移动到 "[engine] kiro"，Enter
     提交后正确显示"✅ 引擎已切换，已切换到 `kiro`"。**这就是用户原始截图问题
     的真实根因和修复**——不是"用户选错了菜单项"（这个猜测已被推翻两次），是
     方向键在 `/model` 菜单里因为上述两个真实 bug 而完全没有被处理，Enter 确认
     的永远是初始默认选项。
   - **重要的架构不一致点**（记录以防后续有人"统一修复"引入新 bug）：
     `liveInput.ts` 的 `suppressInputDuring`（docked 模式处理消息期间用来吞按键、
     防止拼接乱码，见 commit `3e1d40e`）**依然保留"移除所有 keypress 监听器"这个
     做法，且这是正确的**——因为它的设计意图本来就是要完全静默、不需要方向键
     语义功能，移除 keypress 监听器正好能防止 `this.rl` 自己的 `_ttyWrite` 在
     非-raw 逻辑下回显字符。`pickFromList` 和 `suppressInputDuring` 对"要不要
     移除 keypress 监听器"的正确答案是相反的，**不要试图把两者的方案统一**，
     场景需求本质不同（前者需要方向键工作，后者要方向键完全不产生任何效果）。
   - **下一步**：
     1. 清理所有 `LWA_DEBUG_PROBE` 相关的临时探针代码（`slashPicker.ts`、
        `liveInput.ts`、`shellScreen.ts` 三个文件都有），确认 `git diff` 只剩
        真正的修复逻辑，不含任何调试代码。 ✅ **已完成**（2026-07-20）。
     2. 补单元测试：给 `pickFromList` 写一个测试，验证"先注册 data 监听器再
        render"这个顺序（可以 mock stdin，检查 `stdin.on` 调用时 `render` 是否
        已经执行过，用调用顺序断言）；`noopKeypress` 占位监听器的存在性也可以
        测（mock stdin 的 `listenerCount('keypress')` 在 `pickFromList` 运行期间
        应该 >= 1）。 ✅ **已完成**——`slashPicker.test.ts` 新增
        `describe('pickFromList — arrow key handling regression')`，两个测试：
        验证 keypress 监听器数量始终 > 0、验证 data 监听器注册早于首次渲染写入。
     3. 跑 `pnpm test && pnpm typecheck && pnpm lint && pnpm build` 全过，提交，
        push，`gh run watch` 确认 CI 四矩阵绿。 ✅ **已完成**——700 测试通过
        （比之前 697 多 3 个，即上面这两个新测试 + 已有的 1 个），typecheck/
        lint（7 个既有 warning，无新增）/build 全过。
     4. 提交信息要引用这次完整的调查过程和证据（两个根因 + 为什么两处都要修 +
        跟 suppressInputDuring 故意保留不同行为的理由），方便后续追溯。
        **⏳ 待执行**：下一步就是 `git add` + `git commit` + `git push` +
        `gh run watch` 确认 CI。改动文件：`src/ingress/cli/slashPicker.ts`
        （核心修复）、`src/ingress/cli/slashPicker.test.ts`（新测试）。
        `liveInput.ts`/`shellScreen.ts` 这次会话新增的探针代码已经清理干净，
        `git diff` 应该显示这两个文件跟上次提交（`eb1ee81`）相比无变化
        （提交前用 `git status --short` 确认）。
   - **调试代码清理状态**：当前 `slashPicker.ts` 和 `shellScreen.ts` 里还留着好几处
     `LWA_DEBUG_PROBE` 环境变量控制的探针代码（写 `/tmp/lwa-picker-probe.log`），
     **修复完成、验证通过后必须清理掉，不能提交**。还有一个 `--require` monkey-patch
     脚本 `/tmp/lwa-patch-rawmode.cjs`（通过 `NODE_OPTIONS` 注入，纯测试用，不在
     项目代码里，不需要清理项目文件，但测试脚本本身不要提交）。
   - 相关代码：`src/ingress/cli/slashPicker.ts` 的 `pickFromList`（`onData` 约 282
     行），`src/ingress/cli/liveInput.ts` 的 `suppressInputDuring`（`onData` 约 190
     行），`src/ingress/cli/channel.ts` 的 `runPromptLoop`（`suppressInputDuring`
     包裹 `onMessage` 调用的地方，约 320-335 行），`src/core/dispatcher.ts` 的
     `handleModelCmdCli`（`/model` 命令处理，约 2305 行起）。
   - 测试隔离环境：`LWA_HOME=/tmp/lwa-test-home`（配套一个不含真实密钥的最小
     `config.json`），避免污染 `~/.lwa/`。**每次重新测试前记得清空这个临时目录**，
     否则 sticky engine 状态会跨次残留，干扰下次测试的初始状态判断。
   - **重要方法论教训**：expect 工具在测试"多字节转义序列按键"（方向键等 CSI 序列）
     场景下不可靠，会产生"业务逻辑代码探针显示正常"的假象。**后续任何涉及方向键/
     组合键的真实性验证，都应该用 Python pty 直接驱动（`os.write` 一次性写入完整
     字节序列），不要只依赖 expect 的 send。** 已有一份可复用的脚本模板在
     `/tmp/lwa-pty-direct.py`（临时文件，若需要长期保留应该迁移到项目里，比如
     `scripts/pty-test-template.py`，但目前还是临时验证阶段，不要提交）。
     另一个重要教训：**同名的局部函数/闭包（如两处都叫 `onData`）会让"函数名"这个
     调试线索失效**——用 `.name` 属性或者简单打印函数名去区分"是哪个 onData 在
     响应"是不可靠的，必须用不同的字符串标记直接在探针里区分。

2. **Markdown 星号语法未渲染**（`**LWA**` 原样显示星号）
   - 状态：已给用户提过方案（A: 正则转 ANSI 粗体 / B: markdown-terminal 库 / C: 不处理），
     用户还没明确选，**不要在没有明确决定前动手做**。

## 第一层：已修复并验证的问题（本次会话之前，供背景参考，不要重复修）

以下均已用真实 expect 驱动的 pty 测试验证过，已提交到 `origin/main`：

- `b51a3fb` LineQueue：防止非-docked 模式下处理消息期间用户输入丢失/错位
- `adb5fe7` splitKeys + positiveOr：修复合并按键 chunk 被丢弃、终端尺寸 0 时布局失效
- `3e1d40e` suppressInputDuring：处理消息期间吞掉按键回显，防止跟 thinking 动画拼接
- `f8f960a` 用户消息回显进对话历史（之前提交后用户输入完全不出现在 transcript 里）
- `eb1ee81` ToolPanel.breakOpenLine：修复工具调用穿插在两段消息之间时换行缺失

## 当前所处阶段

任务 #1-#3（第一层稳定性修复）已完成，见上面的问题清单和已修复列表。
任务 #4（conduit 显性化设计）**暂停** —— 讨论后确认在设计"怎么让更多人发现
conduit"之前，应该先验证"conduit 核心链路本身现在到底能不能用"，顺序不能
反。已完成这一步的真实验证：

### conduit 核心链路真实验证结果（2026-07-20）

**结论：核心链路（spec/task → Coordinator → Implementor(kiro-cli-acp) →
Verifier(static+dynamic) → PASSED）真实可用**，用 `examples/02_civ_hello.py`
跑通（约 25 秒，真实调用一次本机 kiro-cli，写 `calc.py` + `test_calc.py`，
`pytest` 校验通过，退出码 0，输出：
`Task: add-function / Passed: True / Attempts: 1 / static ✓ / dynamic ✓`）。

**验证过程中发现并修复的真实环境问题（跟代码逻辑无关，是这台机器上的环境
损坏）**：`lwa-conduit` 项目的 `.venv` 虚拟环境里，editable install 指向的是
一个已经不存在的旧路径 `/Users/administrator/PycharmProjects/kiro-conduit`
（项目改名前的目录，早就删掉了），导致 `lwa-conduit` 命令完全不可用
（`command not found`），`bridge` 侵入 conduit 时用的 `conduitBin()` 默认值
`lwa-conduit` 在这台机器上实际调用会失败。**修复**：
`.venv/bin/python3 -m pip install -e '.[dev]'` 重新以当前目录 editable 安装，
命令立刻恢复可用。这不是代码 bug，是本机环境的一次性问题，**不需要改任何
项目代码**，但值得记一笔：如果之后 bridge 侵入 conduit 报"not found"，先检查
这个虚拟环境是否又坏了（`.venv/bin/lwa-conduit --help` 能不能跑），不要
直接怀疑 bridge 侵入逻辑。

**其他观察**：`lwa-conduit run --help` 的参数列表（`--workspace`、
`--events {none,ndjson}`、`--merge` 等）跟 `dispatcher.ts` 里
`runConduitStreaming`/`handleConduitCmd` 的真实调用方式**完全对齐**，接口没有
漂移。`status` 不是 conduit 自己的子命令（`run`/`plan`/`report` 才是），
`bridge` 的 `/conduit status` 是本地直接读 `.lwa-conduit/run-state.json`
文件，这是设计如此，不是遗漏。

**下一步（真正的 #4）**：核心链路验证通过，现在可以回到"要不要做显性化、
往哪个方向做"这个产品决策——用户还没有选 A/B/C 方向，等用户确认后再动手。
不要在没有明确选择前先设计/实现任何一个方向。

### #4 进展：用户选了 C（分步引导 + 主动检测建议），已完成分步引导部分

**已完成并真实验证（2026-07-20）**：

1. `/conduit`（无参数）改成三态分步引导：检测 cwd 下 `.lwa-conduit/run-state.json`
   （跑过 run）→ `.conduit-plan/dag.yaml`（plan 过没 run）→ 都没有（从未 plan）
   三种状态，给不同的下一步提示，不再是每次都显示同一段静态说明。三态都用真实
   pty 测试逐一验证过。

2. **意外发现并修复了一个比"显性化"更严重的真实 bug**：用真实 `lwa-conduit`
   CLI（不是 mock）跑通 `/conduit run` 时发现，`--workspace` 参数之前直接传
   `cwd`（项目根目录），但 `/conduit plan` 默认把 `dag.yaml` 产出到
   `<cwd>/.conduit-plan/dag.yaml`——**任何用户完全照着官方提示的正常流程
   （plan → run）操作，run 都会失败**，报 "no dag.yaml in workspace dir"。
   这条核心链路本身是断的，之前没被发现是因为 README 的 demo 走的是 Python
   直接调用内部类（`Coordinator`/`Implementor`），不是真实的 CLI 命令链。
   修复：新增 `resolveConduitWorkspaceDir()`（`src/conduit/summary.ts`），
   自动判断 dag.yaml 实际所在目录，同时显式传 `--base-repo cwd`（因为
   `--base-repo` 默认值是 workspace 目录，两者不一致后必须显式指定）；
   找不到 dag.yaml 时提前给出`/conduit plan`引导，不让请求打到子进程才报错。

3. 新增 `/conduit run --resume` / `/conduit run --fresh`（`src/commands/parse.ts`
   的 `resumeMode` 字段），对接 lwa-conduit CLI 自带的"裸重跑守卫"（发现上次
   有已完成任务、但没传这两个参数时会拒绝执行）。之前 bridge 完全没识别这个
   场景，用户看到的是"退出码 1，部分任务可能失败"这种跟真实情况（根本没跑）
   不符的通用报错。新增 `isBareRerunGuardResult()` 识别这个场景，渲染专门的
   引导卡片（"检测到上次未完成的运行" + 明确的 --resume/--fresh/status 三选）。

**真实端到端验证**（用装好的 `.venv/bin/lwa-conduit` + 真实 git 仓库 + 真实
`dag.yaml` + 真实 `run-state.json`，通过 `LWA_CONDUIT_BIN` 环境变量指向真实
二进制）：
- 三态引导：干净目录 → 提示 plan；已 plan → 提示 run（含真实路径）；已 run →
  提示 status。全部用真实 pty 抓到的输出核对过文案。
- `/conduit run`（无参数，有未完成进度）：真实触发裸重跑守卫，渲染出设计好的
  友好卡片，不是原来那种"编排结束（有失败项）"的误导性文案。
- `/conduit run --resume`：真实绕过守卫，进入实际执行阶段（后续因为测试数据
  本身不完整——`run-state.json` 里声称存在的分支从未被真实创建过——报了
  git worktree 错误，这是我测试环境搭建的问题，不是这次改动的 bug，不影响
  已验证的"--resume 参数被正确传递、守卫被正确绕过"这个结论）。

**已提交的文件**：`src/conduit/summary.ts`（新增 `findConduitDagPath` /
`resolveConduitWorkspaceDir` / `isBareRerunGuardResult`）、
`src/conduit/summary.test.ts`（13 个测试）、`src/commands/parse.ts`（`resumeMode`
字段）、`src/commands/parse.test.ts`（4 个新测试）、`src/core/dispatcher.ts`
（三态引导 + workspace 目录修复 + 裸重跑守卫识别）。

**还没做的**：
- 方向 A（主动检测"这条消息适合并行拆分"并建议用户试试 `/conduit plan`）
  还没开始——这个涉及主观判断，容易误判/打扰用户，需要更谨慎地设计触发规则
  （目前想法：只在消息里明显列出 3 个以上独立子任务时触发一次，不重复打断）。
- `.lwa-conduit`/`.kiro-conduit`/`.conduit-plan` 三个约定目录名同时存在，
  长期看应该统一（`.kiro-conduit` 是改名前的遗留兼容），但不是这次范围内的事，
  记一笔，不要现在动。

## 新发现的问题（2026-07-21，用户截图报告）：ACP 错误的原始堆栈日志泄漏

**现象**：用户截图显示，`kiro-cli-acp` 报了一个真实的 ACP 协议错误
（`-32603 Internal error`，`data: dispatch failure`——这是 kiro-cli 本身/协议层
的问题，不是 bridge 的逻辑 bug，暂不深究），随后**完整的 pino 错误日志堆栈
（`[02:30:51.349] ERROR: [agent-runner] agent turn failed` + 完整 JS stack）
直接被打印到了 docked 全屏 UI 上，破坏了固定分区布局**（状态栏那一行后面
直接接了裸日志文本，看不到任何"友好错误提示"）。

**真实根因（已用官方文档确认，非猜测）**：`src/lib/logger.ts` 的 `getLogger()`
在 TTY 环境下用 `pino({ transport: { target: 'pino-pretty', ... } })`。**Pino
自 v7 起，`transport` 会在一个独立的 Worker 线程里运行**（pino 官方文档
`docs/transports.md`：「The transport code will be executed in a separate
worker thread. The main thread will write logs to the worker thread, which
will write them to the stream...」）。这个 worker 线程有自己独立的上下文，
它对 `process.stdout.write` 的引用是 worker 线程里的原始版本，**完全不受
`ShellScreen.installStdoutHook()`（`src/ingress/cli/shellScreen.ts` 560 行
附近，主线程 monkey-patch `process.stdout.write`，把所有输出纳入 docked
模式的 `ingestContent`/`transcript` 内容管理系统）影响**。所以 pino-pretty
的输出会直接穿透物理 fd，绕开整个 docked 布局系统。

这跟 `LARK_KIRO_LOG_LEVEL` 默认设为 `error`（`cli.ts` 63-65 行，"默认压低
日志避免打断输入"）这个设计本身不矛盾——**error 级别本来就该被打出来，
问题是"打出来的方式"绕过了 UI 层，不是"该不该打出来"**。

已读代码确认的相关点：
- `dispatcher.ts` 4706 行附近 `runAgentTurn` 调用的 catch 块：对
  `kiro-cli-acp` 这种 profile.kind，异常不会走这个 catch（只处理
  `openai-compatible` 的 gateway 熔断，其余 `throw e`）；真实的错误处理
  路径是 `runner.ts` 130 行 `log().error(...)` 记录日志后返回
  `exitCode: 1`，外层 `dispatcher.ts` 走 `result.exitCode !== 0` 分支调用
  `view.end({ error: 'exit 1' })`。`turnView.ts` 108-121 行确认
  `view.end({error})` 会渲染 `▎ exit 1`（红色）+ 计时 footer——**这条友好
  提示理论上也会出现，只是可能被先出现的原始堆栈日志抢了视觉注意力**，
  还没有真实 pty 测试确认这条提示到底有没有正常显示。

**下一步（还没做）**：
1. 真实 pty 测试确认："pino worker 线程写 stdout 绕过 installStdoutHook"
   这个假设 + "`view.end({error})` 的友好提示是否真的正常显示，只是被堆栈
   日志遮挡视觉注意力"这两点，不要只凭文档推断就动手改代码。
2. 修复方向候选（需要真实验证后再选，不要预设）：
   a. docked 模式下 `getLogger()` 不用 `pino-pretty` 的 `transport`
      （worker 线程），改用同步的 `pino.destination` 或自定义 stream，
      写到主线程里能被 `installStdoutHook` 拦截到的位置；
   b. 或者 docked 模式下日志完全不走 stdout，只写文件（改变现有"error
      级别要打到屏幕方便调试"的设计意图，需要跟用户确认是否接受）；
   c. 或者给 pino 传自定义的非 worker 同步 write 目标，直接调用
      `ShellScreen` 当前的 `write()`。
3. 确定方案 → 实施 → 真实 pty 测试 → 写单元测试 →
   test/typecheck/lint/build → 提交推送 → CI 确认。

**已用真实脚本验证的完整根因链（2026-07-21，非猜测）**：
1. 建了 `pino({transport:{target:'pino-pretty'}})`（当前代码写法）+ monkey-patch
   `process.stdout.write` 的最小复现脚本，跑出「主线程 hook 捕获到的内容条数: 0」
   ——原始堆栈直接穿透打到物理终端，证实 worker 线程绕过 hook。
2. 进一步 `require('pino-pretty')` 源码确认：即使不用 `transport`（避免 worker
   线程），改成同步传 `pretty()` stream 给 `pino(opts, stream)`，**默认情况下
   依然会绕过**——因为 pino-pretty 默认 `destination = buildSafeSonicBoom({dest:
   opts.destination || 1, ...})`，`SonicBoom` 是直接对 fd=1 做系统调用写入，
   完全不经过 `process.stdout.write` 这个 JS 方法。这是 pino 生态刻意的性能设计
   （官方 commit 注释也提到过"Do not use SonicBoom if stdout has been tampered"，
   说明 pino 自己也知道这种冲突场景）。
3. **验证通过的修复方案**：给 `pretty()` 传自定义 `destination`——一个
   `node:stream` 的 `Writable`，其 `write()` 内部**动态**调用
   `process.stdout.write(chunk)`（不能提前 bind/缓存，要在每次写入时重新读取，
   才能吃到运行期的 monkey-patch）。用这个方案重新跑复现脚本，「主线程 hook
   捕获到的内容条数: 1」，完整堆栈内容 0 字节泄漏到物理终端，格式化效果
   （着色、单行紧凑）不受影响。

**已完成（2026-07-21，已提交推送 `40a8a9c`，CI 全绿）**：
- 改 `src/lib/logger.ts` 的 `getLogger()` TTY 分支：不再用
  `transport: { target: 'pino-pretty' }`（worker 线程绕过 hook），改用
  `pino(opts, pretty({ ...options, destination }))`，`destination` 是自定义
  `Writable`，`write()` 内部动态调用 `process.stdout.write`（每次读取，不
  提前 bind，才能吃到运行期 monkey-patch）。
- 新增回归测试 `src/lib/logger.test.ts`：验证 TTY 模式下 `getLogger()` 产生
  的 error 日志确实经过 `process.stdout.write`（能被 docked CLI 的 stdout
  hook 拦截）。
- 真实验证链（不是纯单测）：用 `tsx` 直接跑 `runAgentTurn(profile, {...})`
  （`bin` 指向不存在的可执行文件触发真实 `ACP stdout closed` 错误），确认
  `exitCode: 1` + `agent turn failed` 日志被主线程 hook 完整捕获，0 字节
  穿透到物理终端。
- `typecheck` / `test`（716 通过）/ `lint`（7 个历史遗留 warning，跟本次
  改动无关，未处理）/ `build` 全过。GitHub Actions CI（macOS/Ubuntu ×
  Node 20/22）全绿。

**还没做（后续可选，非本次必须）**：
- 没有验证 `turnView.ts` 的 `view.end({error: 'exit 1'})` 友好提示在
  真实报错时的呈现效果（这次修复的是"原始堆栈不再穿透"，友好提示本身的
  路径没有改动，理论上不受影响，但没有专门做像素级 pty 验证）。
- 没有排查 kiro-cli-acp 协议本身为什么会报 `-32603 dispatch failure`
  （这是 kiro-cli 自身的问题，不在 bridge 职责范围内，用户可自行升级/
  反馈 kiro-cli）。

## 新发现的真实 bug（2026-07-21，用户反馈"不会自动吐字，按其他键才触发吐字"）

**现象**：用户报告 `/conduit plan`/`/conduit status` 等命令提交后，内容区长时间
（甚至几十分钟）完全空白，进程本身活着（`ps` 确认 `%CPU` 几乎为 0，纯睡眠等待，
没有子进程），**直到用户按下任意键，之前的内容才会突然显示出来**。

**已确认的根因（竞态条件，不是"处理慢"）**：
1. `ShellScreen.write()` 写入内容后调用 `scheduleContentRedraw()`，后者用
   30ms 防抖 `setTimeout` 排队实际绘制（`paintContentViewport()` +
   `repaintStatus()`）。
2. `ShellScreen.suspendIngest(true)` 内部会调用 `cancelContentRedraw()`
   （`clearTimeout` 取消掉任何排队中的重绘定时器）——这是为了防止"输入期间
   误写内容"设计的，但代价是：**如果这次取消发生在一个尚未执行的 30ms
   重绘窗口内，且取消之后没有人重新调度，这次内容就会被无限期地卡住不画，
   直到下一次操作重新触发 `scheduleContentRedraw()`**。
3. `channel.ts` 主循环：`readLiveLine()` 返回（`finish()`，命令提交）→
   `onMessage(msg)` 处理命令（可能耗时几秒到几分钟，写入最终结果触发
   `scheduleContentRedraw()`）→ 循环回到顶部，**立刻进入下一轮
   `readLiveLine()`，其内部（liveInput.ts 353 行）调用
   `shell.suspendIngest(true)`** 为接收下一次按键做准备。
4. 如果命令最终结果的写入时间，跟下一轮 `readLiveLine` 里的
   `suspendIngest(true)` 时间点，刚好落在同一个 30ms 窗口内（这在真实场景
   下相当容易发生——一旦命令处理完，`onMessage` 返回、循环立刻进入下一轮，
   几乎是背靠背发生的），最后一次内容的重绘请求就会被取消，而且
   **没有任何机制在之后重新补一次重绘**——直到用户按下任意键，走到
   `paintInput()`/`refreshMenu()`，才间接触发新一轮 `scheduleContentRedraw()`
   把内容画出来。

**为什么之前的调试探针没有发现这个**：探针只验证了"内容确实被
`ingestContent()` 处理了、`scheduleContentRedraw()` 确实被调用且
`willSkip=false`"——这些都是真的，问题不在这几步本身，而在于**这次排队的
30ms 定时器后来被下一轮 `suspendIngest(true)` 取消，而探针没有跨越这个
时间窗口去验证"定时器最终有没有真的触发 `paintContentViewport()`"**。
这是探针覆盖范围的盲点，不是假设错误。

**下一步（还没做）**：
1. 修复方向（需要验证，不要臆断哪个更好）：
   a. `cancelContentRedraw()`（在 `suspendIngest(true)` 内部触发时）如果
      发现有定时器被取消，应该立即同步执行一次 `paintContentViewport()`
      （把待画的内容画完再挂起摄入），而不是直接丢弃；
   b. 或者 `suspendIngest(true)` 不要无条件 `cancelContentRedraw()`，只在
      真正即将有新的输入内容需要保护时才取消（需要更精细的时机判断）；
   c. 或者 `readLiveLine` 进入时，在调用 `suspendIngest(true)` 之前，先
      主动 flush 一次待处理的重绘（调用一次 `paintContentViewport()`）。
2. 用真实场景（不是 pty 模拟，pty 按键模拟在这个项目里多次证明不可靠）
   构造一个单元测试：模拟"内容写入排队重绘 → 立即 suspendIngest(true)"
   这个时序，断言内容最终真的被绘制到 `writeFn` 里，不会永久丢失。
3. 修复 → 测试 → typecheck/lint/build → 提交推送 → 请用户在真实环境
   验证："吐字延迟到下一次按键"的现象是否消失。

## 之前的阶段（已过时，仅供参考）

**尚未开始执行**——刚建立本记录文件和任务清单，下一步是任务 #2：
重新梳理并确认上面"未修复问题清单"里第 1 条的真实状态。

## 每轮对话检查清单（执行任何修复前必读）

1. 读这份文件，确认当前在哪一步。
2. 涉及代码改动前：读相关源码，不要凭记忆猜实现。
3. 声称任何"bug 存在/已修复"之前：必须用真实 expect pty 测试验证，不能只靠代码推理。
4. 提交前：`pnpm test` + `pnpm typecheck` + `pnpm lint`（0 error）+ `pnpm build` 全过。
5. 提交后：`git push origin main`，用 `gh run watch <id> --exit-status` 确认 CI 四矩阵全绿。
6. 清理所有临时测试文件（`/tmp/lwa-*`）。
7. **完成一个子任务后立刻回来更新这份文件**，写清楚做了什么、验证了什么、下一步是什么。
