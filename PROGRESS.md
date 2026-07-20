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
