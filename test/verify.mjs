#!/usr/bin/env node
/**
 * 无依赖自检：模块形状 + 配置解析 + 注册行为 + 文本生成。
 * 运行：node test/verify.mjs
 */
import { Config, SECTION_NAME, apply, buildSectionText, inject, name, normalize, pickLanguage } from '../lib/index.js'

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

// ---- 模块形状 ---------------------------------------------------------------
ok('实现 Cordis 插件名', name === 'batch-tool-calls')
ok('只依赖 systemPrompt 服务', Array.isArray(inject) && inject.length === 1 && inject[0] === 'systemPrompt')
ok('apply 是函数', typeof apply === 'function')

// ---- 配置默认值 -------------------------------------------------------------
const defaults = Config({})
ok('默认 enabled=true', defaults.enabled === true)
ok('默认 language=auto', defaults.language === 'auto')
ok('默认 order=100（人格前缀之后、plan:policy 之前）', defaults.order === 100)
ok('默认区间 3–6', defaults.minCalls === 3 && defaults.maxCalls === 6)
ok('默认含 shell 合并那条', defaults.mentionShell === true)
let bad = false
try { Config({ minCalls: -1 }) } catch (_error) { bad = true }
ok('schema 拒绝非法 minCalls', bad)

// ---- 注册行为 ---------------------------------------------------------------
let ctx = makeCtx()
apply(ctx, Config({}))
ok('默认注册恰好一段', ctx.seen.length === 1, ctx.seen.length)
const section = ctx.seen[0]
ok('段名固定为 ' + SECTION_NAME, section.name === SECTION_NAME)
ok('注册到 order=100', section.order === 100)
ok('文本是静态字符串（对提示缓存友好）', typeof section.text === 'string')
ok('文本含「同步发多个调用」的核心规则', /同一个步骤/.test(section.text) || /SAME step/.test(section.text))
ok('文本不含 {{}} 提示变量', section.text.includes('{{') === false)

ctx = makeCtx()
apply(ctx, Config({ enabled: false }))
ok('enabled:false 时不注册', ctx.seen.length === 0)

// ---- 语言 -------------------------------------------------------------------
ok('zh 文本', buildSectionText({ language: 'zh' }).includes('省步数'))
ok('en 文本', buildSectionText({ language: 'en' }).includes('Spend fewer steps'))
const keep = process.env.DSHA_UI_LANGUAGE
process.env.DSHA_UI_LANGUAGE = 'zh-CN'
ok('auto 跟随 DSHA_UI_LANGUAGE=zh-CN', pickLanguage('auto') === 'zh')
process.env.DSHA_UI_LANGUAGE = 'en-US'
ok('auto 跟随 DSHA_UI_LANGUAGE=en-US', pickLanguage('auto') === 'en')
if (keep === undefined) delete process.env.DSHA_UI_LANGUAGE
else process.env.DSHA_UI_LANGUAGE = keep

// ---- 文本细节 ---------------------------------------------------------------
ok('mentionShell:false 去掉 shell 合并那条', buildSectionText({ language: 'zh', mentionShell: false }).includes('a && b') === false)
ok('自定义区间出现在文本里', buildSectionText({ language: 'zh', minCalls: 2, maxCalls: 4 }).includes('2–4'))
ok('maxCalls<minCalls 被夹紧', normalize({ minCalls: 5, maxCalls: 2 }).maxCalls === 5)
ok('extra 追加到末尾', buildSectionText({ language: 'zh', extra: '## 额外约定' }).trim().endsWith('## 额外约定'))
let rejected = false
try { apply(makeCtx(), { extra: '{{cwd}}' }) } catch (_error) { rejected = true }
ok('含 {{}} 的自定义文本被拒绝（否则组装期会整段报错）', rejected)

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
process.exit(fail === 0 ? 0 : 1)
