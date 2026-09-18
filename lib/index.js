/**
 * dsh-batch-tool-calls —— 让 Agent 在**一个步骤**里批量发起互不依赖的工具调用。
 *
 * 为什么值得装：每一步都会把整个对话上下文重新发一遍（命中提示缓存同样计费）。
 * 实测一个 standard 预设的会话：4 轮 / 60 步 / 90 次工具调用（平均 1.5 次/步），
 * 其中 26 个步骤各自只跑了一条 shell 命令；该会话缓存命中读 5,664,640 token
 * （≈ 94,411 token/步）。把这些彼此独立的单调用步骤合并，步数直接下降，
 * 缓存重读按比例下降。
 *
 * 怎么生效（两条通道）：
 * 1) 静态提示段：向宿主 systemPrompt 注册**一段静态**提示段（默认 order 9500，
 *    落在工具说明之后、`deployment:persona-suffix` 之前，靠近对话起点）。
 *    静态文本对提示缓存友好：内容稳定 → 前缀命中率不受影响。
 * 2) 压缩后再提醒：上下文被压缩（compaction）后，旧历史被一条 checkpoint 摘要取代，
 *    提示段虽然还在，但注意力会被摘要占满 —— 表现出来就是「前面很守规矩、压缩几次后
 *    又开始一条命令一步」。所以本插件监听 `compaction/end`，在下一次 `agent/pre-step`
 *    追加一条很短的 `notice` 提醒，位置正好在模型恢复工作的那一步。
 *    这是本插件**唯一**会往对话里写消息的动作，可用 `reassertAfterCompaction: false` 关掉。
 *
 * 另外提示段文本自身要求：若本会话被压缩成 checkpoint，checkpoint 的
 * `## Critical Context` 必须原样保留本节规则。压缩请求会把系统提示整段重放给摘要模型
 * （宿主为了让摘要复用前缀缓存而这么做），所以这句话就是写给摘要模型的：
 * 即使之后又压了几次，规则仍在上下文里。
 *
 * 平面：systemPrompt 注册表属于宿主组合；本插件不发布任何服务，只消费它，
 * 因此对所有预设的所有 Agent（含子代理）生效。预设可用同名 section 覆盖。
 *
 * 配置（见 cordis.patch.yml）：
 *   enabled                 boolean  默认 true；false = 完全不注册
 *   language                'auto' | 'zh' | 'en'  默认 auto（跟随部署语言）
 *   order                   number   默认 9500
 *   minCalls                number   默认 3   提示里的「每步几个」下限
 *   maxCalls                number   默认 6   提示里的上限
 *   mentionShell            boolean  默认 true  是否包含「独立 shell 命令合并成一次 bash」
 *   extra                   string   默认 ''    追加自定义文本（另起一段）
 *   reassertAfterCompaction boolean  默认 true  上下文压缩后补一条短提醒
 *   reassertEverySteps      number   默认 0     每 N 步补一条短提醒（0 = 关闭）
 */
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

/** Cordis 插件名（诊断与日志里可见）。 */
const name = 'batch-tool-calls'
/** 必需服务：只读注册表，缺失时本行等待而不是报错。 */
const inject = ['systemPrompt']

/** 段名固定：预设若要用自己的文本替换它，注册同名 section 即可（scoped 覆盖 global）。 */
const SECTION_NAME = 'batch-tool-calls:policy'
/**
 * 默认落点：工具说明（1000–2900）与 `TOOLS_SDK`（5000）之后，
 * `STRUCTURED_OUTPUT`（9900）与 `deployment:persona-suffix`（10200）之前。
 * 取靠后的位置是因为这条规则要在**每一步**被想起来：越靠近对话，越不容易被忽略。
 */
const DEFAULT_ORDER = 9500
const DEFAULT_MIN_CALLS = 3
const DEFAULT_MAX_CALLS = 6
/** `notice` 形式要求的单行摘要上限（与宿主 CONTEXT_SUMMARY_MAX_CHARS 一致）。 */
const SUMMARY_MAX_CHARS = 120
/** 注入消息的来源标签：没有它，注入内容在历史里会被当成用户提示渲染。 */
const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin', plugin: name })
const ZH_SUMMARY = '上下文已压缩：批量调用规则不变'
const EN_SUMMARY = 'context was compacted: batching rule still applies'

const Config = z.object({
  enabled: z.boolean().default(true),
  language: z.union([z.const('auto'), z.const('zh'), z.const('en')]).default('auto'),
  order: z.number().default(DEFAULT_ORDER),
  minCalls: z.natural().min(1).default(DEFAULT_MIN_CALLS),
  maxCalls: z.natural().min(1).default(DEFAULT_MAX_CALLS),
  mentionShell: z.boolean().default(true),
  extra: z.string().default(''),
  reassertAfterCompaction: z.boolean().default(true),
  reassertEverySteps: z.natural().default(0),
})

/** `auto` 时跟随部署语言：先看 DSH/DSHA 的语言环境变量，再看 LANG/LC_ALL。 */
function pickLanguage(configured) {
  if (configured === 'zh' || configured === 'en') return configured
  let raw = ''
  try {
    raw = String(process.env.DSH_UI_LANGUAGE || process.env.DSHA_UI_LANGUAGE || process.env.LC_ALL || process.env.LANG || '')
  } catch (_error) {
    raw = ''
  }
  return /^zh/i.test(raw) ? 'zh' : 'en'
}

/** 归一化配置：既支持经 schema 解析后的对象，也支持直接调用 apply 时传入的部分配置。 */
function normalize(config) {
  const raw = config === undefined || config === null ? {} : config
  const min = Number.isInteger(raw.minCalls) && raw.minCalls >= 1 ? raw.minCalls : DEFAULT_MIN_CALLS
  const maxRaw = Number.isInteger(raw.maxCalls) && raw.maxCalls >= 1 ? raw.maxCalls : DEFAULT_MAX_CALLS
  return {
    enabled: raw.enabled !== false,
    language: raw.language === 'zh' || raw.language === 'en' ? raw.language : 'auto',
    order: Number.isFinite(raw.order) ? raw.order : DEFAULT_ORDER,
    minCalls: min,
    maxCalls: Math.max(min, maxRaw),
    mentionShell: raw.mentionShell !== false,
    extra: typeof raw.extra === 'string' ? raw.extra.trim() : '',
    reassertAfterCompaction: raw.reassertAfterCompaction !== false,
    reassertEverySteps: Number.isInteger(raw.reassertEverySteps) && raw.reassertEverySteps > 0 ? raw.reassertEverySteps : 0,
  }
}

function zhText(min, max, mentionShell) {
  const lines = [
    '## 省步数：一步之内多发几个工具调用',
    '',
    '每一步都会把整个对话上下文重新发一遍（命中缓存同样计费），所以把互不依赖的调用放在**同一个步骤**里一次发完：',
    '',
    '- 互不依赖的侦查调用（`read` / `grep` / `glob` / 搜索 / 只读命令）一次发齐，通常 ' + min + '–' + max + ' 个。',
  ]
  if (mentionShell) lines.push('- 多条独立的 shell 命令合并成一次 `bash`（`a && b`；都要跑用 `a; b`），不要一条命令占一个步骤。')
  lines.push(
    '- 只有后一个调用需要前一个的结果时（先定位、再读那个文件），才拆到下一步。',
    '- 同一个文件的多次 `edit`、以及「先 read 再 edit」必须串行。',
    '- 依赖链、破坏性操作、需要用户确认的动作照旧一步一步来；不要为了省步数牺牲正确性。',
    '',
    '每步自检：**打算让一步只发一个工具调用之前，先问「还有哪个互不依赖的调用可以并进来」**；答不上来才单发。',
    '',
    '本规则对每一步都有效，与上下文是否被压缩无关；即使前面的对话已经被压缩成 checkpoint，也照上面的方式批量调用。'
      + '若本会话被压缩成 checkpoint，checkpoint 的 `## Critical Context` 必须原样保留本节规则。',
  )
  return lines.join('\n')
}

function enText(min, max, mentionShell) {
  const lines = [
    '## Spend fewer steps: batch independent tool calls',
    '',
    'Every step resends the whole conversation context (cache hits are still billed), so issue independent calls in the SAME step:',
    '',
    '- Fire independent inspection calls (`read` / `grep` / `glob` / web search / read-only commands) together, typically ' + min + '-' + max + ' at once.',
  ]
  if (mentionShell) lines.push('- Merge independent shell commands into one `bash` call (`a && b`; use `a; b` to run both) instead of one command per step.')
  lines.push(
    '- Split into a later step only when a call needs the previous result (locate first, then read that file).',
    '- Multiple `edit`s of the same file, and "read then edit", must stay sequential.',
    '- Dependent chains, destructive operations, and anything needing user confirmation stay step-by-step; never trade correctness for fewer steps.',
    '',
    'Per-step check: **before you let a step carry a single tool call, ask "which independent call could join it?"** Only single-call when nothing can.',
    '',
    'This rule holds for every step regardless of context compaction: even when earlier history has been condensed into a checkpoint, batch as described above.'
      + ' When this session is condensed into a checkpoint, that checkpoint\'s `## Critical Context` must carry this section verbatim.',
  )
  return lines.join('\n')
}

/** 组装最终段落文本（导出仅供测试与自定义复用）。 */
function buildSectionText(config) {
  const cfg = normalize(config)
  const base = pickLanguage(cfg.language) === 'zh'
    ? zhText(cfg.minCalls, cfg.maxCalls, cfg.mentionShell)
    : enText(cfg.minCalls, cfg.maxCalls, cfg.mentionShell)
  return cfg.extra ? base + '\n\n' + cfg.extra : base
}

/** 压缩后那条短提醒的正文（导出仅供测试与自定义复用）。 */
function buildReassertText(config) {
  const cfg = normalize(config)
  if (pickLanguage(cfg.language) === 'zh') {
    return [
      '批次提醒（上下文刚被压缩）：批量规则不变 —— 本步先把互不依赖的调用一次发齐（侦查类 ' + cfg.minCalls + '–' + cfg.maxCalls + ' 个）'
        + (cfg.mentionShell ? '，多条独立 shell 命令合并成一次 `bash`' : '')
        + '；只有下一步需要上一步的结果时才拆步。',
      '若本会话再次被压缩，请把这条提醒一并保留在 checkpoint 的 `## Critical Context` 里。',
    ].join('\n')
  }
  return [
    'Batching reminder (context was just condensed): the batching rule still holds — issue independent calls together in this step (typically '
      + cfg.minCalls + '-' + cfg.maxCalls + ' inspection calls)'
      + (cfg.mentionShell ? ', and merge independent shell commands into one `bash` call' : '')
      + '; split only when the next call needs the previous result.',
    'If this session is condensed again, keep this reminder in the checkpoint\'s `## Critical Context`.',
  ].join('\n')
}

/** 单行摘要（`notice` 形式用它渲染折叠行），截断到宿主的上限。 */
function buildReassertSummary(config) {
  const summary = pickLanguage(normalize(config).language) === 'zh' ? ZH_SUMMARY : EN_SUMMARY
  return summary.length <= SUMMARY_MAX_CHARS ? summary : summary.slice(0, SUMMARY_MAX_CHARS - 1) + '…'
}

/** 递归冻结（消息在发布前必须是不可变的，与宿主 createUserMessage 的行为一致）。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

/**
 * 造一条 user 角色的注入消息。
 *
 * 宿主没有对外暴露 `createUserMessage`，而 `@deepseek-ai/dsh-llm` 在 npm 上的公开版本
 * 落后于运行时（0.0.1-rc.1 vs 0.1.5-rc.2），直接依赖它会把插件装挂；所以这里按宿主
 * 实现的语义自带一份最小版本（`id` = brandString(randomUUID())，运行时就是普通字符串）——
 * 与官方 `@deepseek-ai/dsh-repeat-tool-reminder` 自带一份的做法一致。
 * @param text - 模型可见的正文。
 * @param summary - `notice` 形式的单行摘要。
 * @returns 冻结后的 user 消息。
 */
function createNoticeMessage(text, summary) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { ...PLUGIN_SOURCE, form: 'notice', summary },
  })
}

/** 本插件写进对话的那条提醒消息（导出仅供测试复用）。 */
function buildReassertMessage(config) {
  const cfg = normalize(config)
  return createNoticeMessage(buildReassertText(cfg), buildReassertSummary(cfg))
}

/**
 * 安装提示段与压缩后提醒。
 * @param ctx - Cordis 上下文；两处注册都随本行卸载自动撤销。
 * @param config - {@link Config} 解析后的配置。
 */
function apply(ctx, config) {
  const cfg = normalize(config)
  if (!cfg.enabled) return
  const text = buildSectionText(cfg)
  // 提示段支持 {{变量}} 插值，未注册的变量会在组装时抛错；这里提前挡住，避免整段被吃掉。
  if (text.includes('{{')) throw new Error('batch-tool-calls: section text must not contain "{{...}}" prompt variables')
  ctx.systemPrompt.section({ name: SECTION_NAME, order: cfg.order, text })

  const wantsReassert = cfg.reassertAfterCompaction || cfg.reassertEverySteps > 0
  // 只提供 systemPrompt 的宿主（例如无事件总线的小 ctx）就只留提示段。
  if (!wantsReassert || typeof ctx.on !== 'function') return

  /** 刚压缩完、还没补过提醒的会话。 */
  const compacted = new WeakSet()
  /** 每个会话已经过的步数（`reassertEverySteps` 用）。 */
  const stepsSeen = new WeakMap()
  let reportedFailure = false

  // compaction/end 是会话日志事件（log-only）；压缩成功才不带 error 字段。
  ctx.on('session/event', (session, event) => {
    if (event === null || typeof event !== 'object' || event.type !== 'compaction/end') return
    const data = event.data
    if (data !== null && typeof data === 'object' && data.error !== undefined) return
    compacted.add(session)
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
    if (payload === null || typeof payload !== 'object') return decision
    if (payload.signal !== undefined && payload.signal.aborted === true) return decision
    const session = payload.agent === undefined || payload.agent === null ? undefined : payload.agent.session
    if (session === undefined || session === null) return decision

    const count = (stepsSeen.get(session) ?? 0) + 1
    stepsSeen.set(session, count)
    const periodic = cfg.reassertEverySteps > 0 && count % cfg.reassertEverySteps === 0
    if (compacted.has(session) === false && periodic === false) return decision

    let notice
    try {
      notice = buildReassertMessage(cfg)
    } catch (error) {
      if (!reportedFailure) {
        reportedFailure = true
        if (typeof ctx.logger?.warn === 'function') {
          ctx.logger.warn('batch-tool-calls: cannot build the post-compaction reminder: %o', error)
        }
      }
      return decision
    }
    compacted.delete(session)

    // 插到本步「已认领的用户消息」之后（没有认领消息时放末尾），保持对话顺序自然。
    const claimed = Array.isArray(payload.messages) ? payload.messages : []
    const index = decision.messages.findLastIndex((message) => claimed.includes(message))
    const messages = index < 0
      ? [...decision.messages, notice]
      : [...decision.messages.slice(0, index + 1), notice, ...decision.messages.slice(index + 1)]
    return { ...decision, messages }
  })
}

export {
  Config,
  SECTION_NAME,
  apply,
  buildReassertMessage,
  buildReassertSummary,
  buildReassertText,
  buildSectionText,
  createNoticeMessage,
  inject,
  name,
  normalize,
  pickLanguage,
}
