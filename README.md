# dsh-batch-tool-calls

> DSH（DeepSeek Harness）插件：让 Agent 在**一个步骤**里批量发起互不依赖的工具调用 —— 步数更少，
> 提示缓存重读量更小，同样的任务更省钱。

仓库：<https://github.com/liancha22/dsh-batch-tool-calls>

一个步骤 = 一次模型调用。每一步都会把整个对话上下文重新发一遍（**命中提示缓存同样计费**），
所以「一步多做几件事」直接决定的不是速度，而是账单。

## 问题（实测，不是感觉）

用仓库自带的 `scripts/step-report.mjs` 读真实会话日志：

| 会话（standard 预设） | 步数 | 工具调用 | 平均/步 | 每步 1 次调用的步数 | 单条命令独占一步 |
| --- | --- | --- | --- | --- | --- |
| 初始化仓库技能配置与标签调色盘（4 轮） | 60 | 90 | **1.50** | 27 | 26 |
| 一个长编码会话 | 244 | 307 | **1.26** | 172 | 136 |

同一批会话的 token 账（会话投影里的 `tokenUsage`）：第一个会话 **缓存命中读 5,664,640 token**、
未命中输入 82,149、输出 92,174 —— 平均 **94,411 token/步**。步数就是钱。

这些单调用步骤里，绝大多数是彼此独立的侦查动作（`read` / `grep` / 只读 `bash`），
本可以放进同一个步骤一起发出去。

## 这个插件做什么

**通道 1：往宿主 systemPrompt 注册一段静态提示段**（默认 `order: 9500`，位于工具说明之后、
`deployment:persona-suffix` 之前 —— 越靠近对话越不容易被忽略），告诉 Agent：

- 互不依赖的侦查调用一次发齐（默认建议 3–6 个），不要一个一个来；
- 多条独立 shell 命令合并成一次 `bash`（`a && b`；都要跑用 `a; b`）；
- 只有后一个调用需要前一个的结果时才拆到下一步；
- 同一文件的多次 `edit`、「先 read 再 edit」必须串行；
- 依赖链 / 破坏性操作 / 需要用户确认的动作照旧一步一步来，不为省步数牺牲正确性；
- **每步自检**：一步只发一个调用之前，先问「还有哪个互不依赖的调用可以并进来」。

**通道 2：上下文压缩之后再提醒一次**（v1.1.0 新增，见下一节）。

**不改变工具清单、不改变并发上限、不碰缓存策略** —— 只是在提示里把「一步多发」写成明确规则。

## 压缩几次以后就不听劝了？（v1.1.0 的主要修复）

真实的抱怨是：「前面挺守规矩，**压缩过几次上下文之后就难遵守了**。」

原因是机制性的，不是模型健忘：

1. 上下文压缩（compaction）会把旧历史换成**一条 checkpoint 摘要**（一条 user 消息）。
   提示段本身还在系统提示里，但对话里最有分量的东西变成了那份摘要 + 保留的最近几段历史，
   模型的模仿对象从「规则」偏向「最近看到的例子」。摘要越厚，规则越像背景噪音。
2. 规则原本只是系统提示里的一段话，**没有任何东西在压缩之后把它重新推到台前**。

所以 v1.1.0 加了两件事：

- **压缩后补一条短提醒**：插件监听会话的 `compaction/end`（日志事件，成功才不带 `error`），
  在**下一次** `agent/pre-step` 往这一步的已认领用户消息之后插入一条几十 token 的
  `notice` 消息（来源标成 `plugin`，不会在历史里被当成用户说的话）。
  这就是模型被压缩打断后恢复工作的那一步 —— 提醒正好落在它眼前。同一次压缩只提醒一次。
  这是本插件**唯一**会往对话里写消息的动作；设 `reassertAfterCompaction: false` 即可完全关闭
  （关掉后插件就退化成 v1.0.0 的纯静态提示段，不注册任何监听）。
- **让规则自己活过压缩**：提示段文本里明确要求「若本会话被压缩成 checkpoint，
  checkpoint 的 `## Critical Context` 必须原样保留本节规则」。这不是空话：宿主为了复用前缀缓存，
  会把**整个系统提示连同对话前缀一起重放给写摘要的模型**，所以这句话就是写给摘要模型的。
  短提醒文本里也带了同样的要求，于是规则可以在多次压缩之间一路传下去。

可选再加一层：`reassertEverySteps: 20` 表示每 20 步补一条同样的短提醒。
默认 `0`（关闭）—— 先只靠上面两条，如果还是漂移再打开它。

## 为什么是宿主平面 + 静态段

- `systemPrompt` 是进程级注册表。注册在**宿主组合**（host composition）意味着
  **所有预设（standard / ptc / minimal / cordis）的所有 Agent，含子代理**都带上这段约定，装一次就够。
- 段文本是**常量**：内容稳定 → 提示前缀不变 → 缓存命中率不受影响（每步只多约 250 token）。
  用动态文本（按会话拼接）反而会把缓存前缀打散，得不偿失。
- 不发布任何服务、只消费 `systemPrompt`，所以不存在「预设里裸放服务」的 realm 问题，也不需要隔离域。
- 预设若想用自己的措辞替换它，注册同名 section `batch-tool-calls:policy` 即可覆盖（scoped 覆盖 global）。

## 安装

**A. 从 GitHub（已发布，推荐）**

```bash
# 应用内：插件页 → 从 GitHub 安装 → 填 liancha22/dsh-batch-tool-calls
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-batch-tool-calls
# 装完重启该 profile 生效
```

仓库根就是插件根（`package.json` 里声明 `dsh.bundle.patch`），安装器会把该 ref 解析成
commit SHA 后下载，装到的是**固定版本**；换版本时重跑一次上面的命令即可。

> ⚠️ 在本机那份带 `.git` 的开发目录上跑这条命令，会把它整体替换成下载版（`.git` 随之消失）。
> 本机自测请用下面的 C，或先把开发目录另存一份。

**B. 从 npm（发布后）**

```bash
dsh plugin --profile <profile> add dsh-batch-tool-calls
# 重启该 profile 生效
```

包内声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把下面这行插进 profile 组合，`remove` 自动移除：

```yaml
- insert:
    - id: batch-tool-calls
      name: 'dsh-batch-tool-calls'
      config:
        enabled: true
        language: auto
```

**C. 本地目录（开发 / 未发布）**

```bash
git clone <this-repo> ~/.dsh/plugin-src/dsh-batch-tool-calls
ln -s ~/.dsh/plugin-src/dsh-batch-tool-calls <profile>/node_modules/dsh-batch-tool-calls
# 然后在 <profile>/package.json 里加：
#   dependencies:  "dsh-batch-tool-calls": "link:/abs/path/to/dsh-batch-tool-calls"
#   dsh.profile.bundles: [ ..., "dsh-batch-tool-calls" ]
```

`@deepseek-ai/schemastery` 由 DSH 运行时提供（profile 的共享 node_modules 里就有），无需自己安装依赖。

**D. 手工合并**：把 `cordis.patch.yml` 里的 `insert` 段落合并进 profile 的 `cordis.patch.yml`（用户补丁层在 bundle 层之后生效）。

## 配置

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | `false` = 完全不注册这一段 |
| `language` | `auto`\|`zh`\|`en` | `auto` | `auto` 跟随部署语言（`DSH_UI_LANGUAGE` / `DSHA_UI_LANGUAGE` / `LC_ALL` / `LANG`） |
| `order` | number | `9500` | 提示段排序：工具说明 `1000–2900` / `TOOLS_SDK` `5000` 之后，`STRUCTURED_OUTPUT` `9900`、`persona-suffix` `10200` 之前（v1.0.0 是 `100`，想放回最前面就写 `100`） |
| `minCalls` / `maxCalls` | number | `3` / `6` | 写进提示的「每步几个」区间（`maxCalls < minCalls` 时自动夹紧） |
| `mentionShell` | boolean | `true` | 是否包含「独立 shell 命令合并成一次 bash」这条 |
| `extra` | string | `''` | 追加自己的约定（另起一段；不能含 `{{...}}`，那是提示变量语法） |
| `reassertAfterCompaction` | boolean | `true` | 上下文压缩后，在下一次 `agent/pre-step` 补一条短提醒（唯一会往对话写消息的动作） |
| `reassertEverySteps` | number | `0` | 另外每 N 步补一条同样的短提醒；`0` = 关闭 |

## 验证

```bash
npm install                               # 唯一依赖：@deepseek-ai/schemastery（插件配置 schema）
npm test                                  # verify(57 项) + integration(真实 systemPrompt 服务 + 真实事件总线，16 项)
node test/verify.mjs                      # 模块形状 / 配置解析 / 注册行为 / 文本生成 / 压缩后提醒的接线
node test/integration.mjs                 # 在真实 systemPrompt 上注册 → 组装 → 断言段落出现且顺序正确
node scripts/step-report.mjs <会话日志>    # 装前装后对比：步数、每步调用数分布、单调用步数
```

`verify.mjs` 用**假的事件总线**跑插件逻辑：构造 `compaction/end` → 调 `agent/pre-step` →
断言插了一条 `notice`、同一次压缩只插一次、压缩失败（带 `error`）不插、本步被取消时不插且留到
下一步、`reassertEverySteps` 按步数触发。

`integration.mjs` 更进一步，用**真的 Cordis 上下文**（拉起真实的 `dsh-system-prompt` 服务）：
`ctx.emit('session/event', …, {type:'compaction/end'})` → `ctx.waterfall('agent/pre-step', …)`
走宿主自己的 dispatch，断言消息被插进来、第二次不再插、`error` 事件不插、下游 decision 结构没被
改坏、`await scope.dispose()` 之后监听器一并撤销。

`integration.mjs` 在没有 DSH 运行时包的机器上会打印 `SKIP` 并以 0 退出（`npm test` 因此可移植）。
`step-report.mjs` 需要带 zstd 的 Node（22.15+ / 23+），只用 `node:zlib`，无第三方依赖。
会话日志路径形如 `~/.dsh/sessions/<workspace>/session-<id>/session.v3.jsonl.zstd`；
它自己扫描 zstd 帧边界（Node 一次性 API 只解第一帧，拼接日志必须逐帧解）。

装进 profile 后还可以用部署自带的启动观察器做静态校验（不启动服务、不建会话）：

```bash
DSHA_STARTUP_PROFILE=<profile> DSH_HOME=$DSH_HOME node $DSH_HOME/startup-observer.cjs
# 期望：插件清单里出现 dsh-batch-tool-calls，且没有任何 issue 行
```

## 常见误解

- **「设置里的『并行工具调用数』太小了」**：那个是 `agent-loop` 的 `maxParallelToolCalls`（默认 10），
  只限制**同一步内同时运行**几个调用，不限制模型一步**发起**几个。默认值通常不是瓶颈，
  本插件也不改它。
- **「某个模式限制了一步只能调两个工具」**：标准/PTC/极简预设都只是工具清单 + 人格，
  没有每步调用数限制。一步发几个是模型自己的决定 —— 这正是本插件要影响的。
- **「有 `~/.dsh/AGENTS.md` 就够了」**：那是「工作区指令」，属于软提示、按会话注入；
  本插件走系统提示的固定段落，随插件生命周期管理、可被预设覆盖、对所有预设一致生效。
  两者可以叠加，也可以只留一个。注意：工作区指令虽然也会在压缩后重新注入一次，
  但它跟系统提示里的段落一样，都只是「上下文里的又一坨字」—— 所以 v1.1.0 才额外加了
  压缩后那一条贴着当前步骤的短提醒。

## 局限（诚实说明）

- 这是**提示层**的约束：模型仍可能不照做。它提高概率，不做强制。
- 不会替模型判断哪些调用真的独立 —— 规则写在提示里，判断仍由模型完成。
- 压缩后提醒依赖宿主发出 `compaction/end`（`@deepseek-ai/dsh-compaction-basic` 默认装）；
  组合里没有压缩后端时，这条通道自然从不触发，静态提示段照常工作。
- 只提供 `systemPrompt`、没有事件总线的宿主上，插件只注册静态提示段（不会报错）。
- 想把「一步顶很多步」做成硬机制，看上层的 PTC 模式（用一个 TypeScript 程序组合多步操作）。

## 卸载

```bash
dsh plugin --profile <profile> remove dsh-batch-tool-calls
```

提示段与两个事件监听都随这一行卸载自动撤销（`systemPrompt.section()` 与 `ctx.on()` 返回的
disposer 由 Cordis 生命周期接管）。

## 更新记录

### 1.1.1

- 测试增强：新增「真实 Cordis 事件总线」上的全链路断言（emit `compaction/end` → waterfall
  `agent/pre-step` → 断言 `notice` 插入、只插一次、失败不插、卸载后撤销）。
- 没开 `reassertEverySteps` 时不再维护每会话步数（少一点每步开销与状态）。
- 运行时行为与 1.1.0 相同。

### 1.1.0

- 修复「压缩几次上下文后就不守规矩」：压缩后在下一次 `agent/pre-step` 补一条短 `notice` 提醒
  （`reassertAfterCompaction`，默认开）；提示段与提醒文本都要求 checkpoint 原样保留规则。
- 提示段默认位置从 `order: 100` 移到 `order: 9500`（工具说明之后、靠近对话），提高每步可见度。
- 文本加入「每步自检」和「与是否压缩无关」的明确措辞。
- 新增 `reassertEverySteps`（默认 0）。
- 测试：verify 25 → 57 项，integration 6 → 16 项（新增真 Cordis 事件总线上的压缩→插消息全链路；
  auto 语言断言在无语言环境变量的机器上也能通过）。

### 1.0.0

- 首个版本：静态 systemPrompt 提示段。

## License

MIT
