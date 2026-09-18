#!/usr/bin/env node
/**
 * 无依赖自检：模块形状 + 配置解析 + 注册行为 + 文本生成 + 压缩后提醒的接线。
 * 运行：node test/verify.mjs
 */
import {
  Config,
  SECTION_NAME,
  apply,
  buildReassertMessage,
  buildReassertSummary,
  buildReassertText,
  buildSectionText,
  inject,
  name,
  normalize,
  pickLanguage,
} from '../lib/index.js'

let pass = 0
let fail = 0
const ok = (title, condition, extra) => {
  if (condition) {
    pass += 1
    console.log('  PASS ' + title)
  } else {
    fail += 1
    console.log('  FAIL ' + title + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)))
  }
}
const makeCtx = () => {
  const seen = []
  return { seen, systemPrompt: { section(section) { seen.push(section); return () => {} } } }
}
/** 带事件总线的假 ctx：my apply 只会用到 systemPrompt.section / ctx.on / ctx.logger。 */
const makeFullCtx = () => {
  const seen = []
  const handlers = new Map()
  const warnings = []
  return {
    seen,
    handlers,
    warnings,
    systemPrompt: { section(section) { seen.push(section); return () => {} } },
    logger: { warn(...args) { warnings.push(args) } },
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event) },
  }
}
/** 跑一次 pre-step waterfal：默认下一步决定是「进入这一步」。 */
const runPreStep = (ctx, payload, decision = { kind: 'enter', messages: [] }) => {
  const handler = ctx.handlers.get('agent/pre-step')
  if (handler === undefined) throw new Error('agent/pre-step 未注册')
  return handler({ messages: [], signal: { aborted: false }, ...payload }, async () => decision)
}
const compactedEnd = () => [{ type: 'compaction/end' }, { type: 'compaction/end', data: { compactionId: 'c1', turn: 1 } }]

// ---- 模块形状 ---------------------------------------------------------------
ok('实现 Cordis 插件名', name === 'batch-tool-calls')
ok('只依赖 systemPrompt 服务', Array.isArray(inject) && inject.length === 1 && inject[0] === 'systemPrompt')
ok('apply 是函数', typeof apply === 'function')

// ---- 配置默认值 -------------------------------------------------------------
const defaults = Config({})
ok('默认 enabled=true', defaults.enabled === true)
ok('默认 language=auto', defaults.language === 'auto')
ok('默认 order=9500（工具说明之后、persona-suffix 之前）', defaults.order === 9500)
ok('默认区间 3–6', defaults.minCalls === 3 && defaults.maxCalls === 6)
ok('默认含 shell 合并那条', defaults.mentionShell === true)
ok('默认压缩后补提醒', defaults.reassertAfterCompaction === true)
ok('默认不做周期性提醒', defaults.reassertEverySteps === 0)
let bad = false
try { Config({ minCalls: -1 }) } catch (_error) { bad = true }
ok('schema 拒绝非法 minCalls', bad)

// ---- 注册行为 ---------------------------------------------------------------
let ctx = makeCtx()
apply(ctx, Config({}))
ok('默认注册恰好一段', ctx.seen.length === 1, ctx.seen.length)
const section = ctx.seen[0]
ok('段名固定为 ' + SECTION_NAME, section.name === SECTION_NAME)
ok('注册到 order=9500', section.order === 9500)
ok('文本是静态字符串（对提示缓存友好）', typeof section.text === 'string')
ok('文本含「同步发多个调用」的核心规则', /同一个步骤/.test(section.text) || /SAME step/.test(section.text))
// language=auto：本机可能解析成 zh 或 en，断言必须两种都认（CI 上没有语言环境变量，会走 en）
ok('文本含每步自检', /每步自检/.test(section.text) || /Per-step check/.test(section.text), section.text.slice(0, 40))
ok('文本要求 checkpoint 保留本节规则', section.text.includes('Critical Context'))
ok('文本不含 {{}} 提示变量', section.text.includes('{{') === false)

ctx = makeCtx()
apply(ctx, Config({ enabled: false }))
ok('enabled:false 时不注册', ctx.seen.length === 0)

// ---- 压缩后提醒的接线 -------------------------------------------------------
ctx = makeFullCtx()
apply(ctx, Config({}))
ok('注册了 session/event 监听', typeof ctx.handlers.get('session/event') === 'function')
ok('注册了 agent/pre-step 监听', typeof ctx.handlers.get('agent/pre-step') === 'function')

ctx = makeFullCtx()
apply(ctx, Config({ reassertAfterCompaction: false, reassertEverySteps: 0 }))
ok('两个开关都关掉时不注册事件监听', ctx.handlers.size === 0)

const session = { id: 's1' }
ctx = makeFullCtx()
apply(ctx, Config({ language: 'zh' }))
let decision = await runPreStep(ctx, { agent: { session }, step: 2 })
ok('没有压缩时不插消息', decision.messages.length === 0, decision.messages.length)

for (const event of compactedEnd()) ctx.handlers.get('session/event')(session, event)
decision = await runPreStep(ctx, { agent: { session }, step: 3 })
ok('压缩后下一步插入一条消息', decision.messages.length === 1, decision.messages.length)
const notice = decision.messages[0]
ok('插入的是 user 角色的 notice', notice.role === 'user' && notice.source.kind === 'plugin' && notice.source.form === 'notice')
ok('来源标了插件名（否则会渲染成用户提示）', notice.source.plugin === 'batch-tool-calls')
ok('摘要在上限内', typeof notice.source.summary === 'string' && notice.source.summary.length <= 120)
ok('正文含「批次提醒」', notice.content[0].text.includes('批次提醒'))
ok('正文要求 checkpoint 保留这条提醒', notice.content[0].text.includes('Critical Context'))
ok('消息是冻结的（与宿主 createUserMessage 一致）', Object.isFrozen(notice) && Object.isFrozen(notice.content))

decision = await runPreStep(ctx, { agent: { session }, step: 4 })
ok('同一次压缩只提醒一次', decision.messages.length === 0, decision.messages.length)

for (const event of [{ type: 'compaction/end', data: { compactionId: 'c2', error: 'summarization produced no text' } }]) {
  ctx.handlers.get('session/event')(session, event)
}
decision = await runPreStep(ctx, { agent: { session }, step: 5 })
ok('压缩失败（带 error）时不提醒', decision.messages.length === 0, decision.messages.length)

// 插到「本步已认领的用户消息」之后，而不是无脑追加到最前
const claimed = { id: 'm1', role: 'user', content: [{ type: 'text', text: '用户消息' }], source: { kind: 'user' } }
const other = { id: 'm2', role: 'user', content: [{ type: 'text', text: '另一条' }], source: { kind: 'user' } }
ctx = makeFullCtx()
apply(ctx, Config({}))
ctx.handlers.get('session/event')(session, { type: 'compaction/end', data: { compactionId: 'c3', turn: 1 } })
decision = await runPreStep(
  ctx,
  { agent: { session }, messages: [claimed], step: 6 },
  { kind: 'enter', messages: [claimed, other] },
)
ok('插在已认领消息之后', decision.messages.length === 3 && decision.messages[1].source.form === 'notice', decision.messages.map((m) => m.source.form ?? m.source.kind))

ctx = makeFullCtx()
apply(ctx, Config({}))
ctx.handlers.get('session/event')(session, { type: 'compaction/end', data: { compactionId: 'c4', turn: 1 } })
decision = await runPreStep(ctx, { agent: { session }, signal: { aborted: true }, step: 7 })
ok('本步已取消时不插消息', decision.messages.length === 0)
decision = await runPreStep(ctx, { agent: { session }, step: 8 })
ok('取消后提醒仍留到下一步（没被吃掉）', decision.messages.length === 1)

ctx = makeFullCtx()
apply(ctx, Config({}))
ctx.handlers.get('session/event')(session, { type: 'compaction/end', data: { compactionId: 'c5', turn: 1 } })
decision = await runPreStep(ctx, { agent: { session }, step: 9 }, { kind: 'reject' })
ok('这一步被拒绝时原样返回', decision.kind === 'reject' && decision.messages === undefined)

ctx = makeFullCtx()
apply(ctx, Config({ reassertEverySteps: 2 }))
const periodicSession = { id: 's2' }
const periodic = []
for (let step = 1; step <= 5; step += 1) {
  const result = await runPreStep(ctx, { agent: { session: periodicSession }, step })
  periodic.push(result.messages.length)
}
ok('每 N 步提醒一次（N=2 → 第 2、4 步）', JSON.stringify(periodic) === JSON.stringify([0, 1, 0, 1, 0]), periodic)

// ---- 语言 -------------------------------------------------------------------
ok('zh 文本', buildSectionText({ language: 'zh' }).includes('省步数'))
ok('en 文本', buildSectionText({ language: 'en' }).includes('Spend fewer steps'))
ok('en 文本含每步自检', buildSectionText({ language: 'en' }).includes('Per-step check'))
ok('zh 提醒文本', buildReassertText({ language: 'zh' }).includes('批次提醒'))
ok('en 提醒文本', buildReassertText({ language: 'en' }).includes('Batching reminder'))
ok('zh 摘要很短', buildReassertSummary({ language: 'zh' }).length <= 120)
const keep = process.env.DSHA_UI_LANGUAGE
process.env.DSHA_UI_LANGUAGE = 'zh-CN'
ok('auto 跟随 DSHA_UI_LANGUAGE=zh-CN', pickLanguage('auto') === 'zh')
process.env.DSHA_UI_LANGUAGE = 'en-US'
ok('auto 跟随 DSHA_UI_LANGUAGE=en-US', pickLanguage('auto') === 'en')
if (keep === undefined) delete process.env.DSHA_UI_LANGUAGE
else process.env.DSHA_UI_LANGUAGE = keep
// 没有任何语言环境变量时（CI 就是这样）auto 必须落到 en，否则同一份测试在不同机器上结果不同
const LANGUAGE_KEYS = ['DSH_UI_LANGUAGE', 'DSHA_UI_LANGUAGE', 'LC_ALL', 'LANG']
const keptLanguage = Object.fromEntries(LANGUAGE_KEYS.map((key) => [key, process.env[key]]))
for (const key of LANGUAGE_KEYS) delete process.env[key]
ok('auto 在没有任何语言环境变量时落到 en', pickLanguage('auto') === 'en')
ok('同一环境下 auto 文本是英文', buildSectionText({ language: 'auto' }).includes('Spend fewer steps'))
for (const key of LANGUAGE_KEYS) {
  if (keptLanguage[key] === undefined) delete process.env[key]
  else process.env[key] = keptLanguage[key]
}

// ---- 文本细节 ---------------------------------------------------------------
ok('mentionShell:false 去掉 shell 合并那条', buildSectionText({ language: 'zh', mentionShell: false }).includes('a && b') === false)
ok('mentionShell:false 也影响提醒文本', buildReassertText({ language: 'zh', mentionShell: false }).includes('bash') === false)
ok('自定义区间出现在文本里', buildSectionText({ language: 'zh', minCalls: 2, maxCalls: 4 }).includes('2–4'))
ok('自定义区间出现在提醒文本里', buildReassertText({ language: 'zh', minCalls: 2, maxCalls: 4 }).includes('2–4'))
ok('maxCalls<minCalls 被夹紧', normalize({ minCalls: 5, maxCalls: 2 }).maxCalls === 5)
ok('reassertEverySteps 负数归零', normalize({ reassertEverySteps: -3 }).reassertEverySteps === 0)
ok('extra 追加到末尾', buildSectionText({ language: 'zh', extra: '## 额外约定' }).trim().endsWith('## 额外约定'))
let rejected = false
try { apply(makeCtx(), { extra: '{{cwd}}' }) } catch (_error) { rejected = true }
ok('含 {{}} 的自定义文本被拒绝（否则组装期会整段报错）', rejected)
const built = buildReassertMessage({ language: 'zh' })
ok('buildReassertMessage 每次都是新 id', built.id !== buildReassertMessage({ language: 'zh' }).id)

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
process.exit(fail === 0 ? 0 : 1)
