#!/usr/bin/env node
/**
 * 集成自检：在**真实的** systemPrompt 服务上注册本插件的段落，再组装一次系统提示，
 * 断言段落确实出现、且顺序落在人格前缀之后。
 *
 * 需要能解析 DSH 运行时包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-system-prompt`）：
 * 在 DSH 部署里跑（profile 的共享 node_modules 在解析路径上）即可；解析不到时打印 SKIP
 * 并以 0 退出，方便在没有 DSH 的机器上跑测试。
 *
 * 运行：node test/integration.mjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

let Context
let SystemPromptModule
try {
  const systemPromptEntry = require.resolve('@deepseek-ai/dsh-system-prompt')
  // 用 systemPrompt 包自己的解析路径取 cordis，确保两边是同一份 Service 基类。
  const fromSystemPrompt = createRequire(systemPromptEntry)
  const cordisEntry = fromSystemPrompt.resolve('@deepseek-ai/cordis')
  ;({ Context } = await import(pathToFileURL(cordisEntry).href))
  SystemPromptModule = await import(pathToFileURL(systemPromptEntry).href)
} catch (error) {
  console.log('SKIP integration: DSH runtime packages not resolvable here (' + (error.code ?? error.message) + ')')
  console.log('     hint: run this inside a DSH deployment (profile node_modules must be on the resolution path)')
  process.exit(0)
}

const { apply, Config } = await import('../lib/index.js')
const { renderPrompt } = SystemPromptModule
const SystemPrompt = SystemPromptModule.default

let pass = 0
let fail = 0
const ok = (title, condition, extra) => {
  if (condition) { pass += 1; console.log('  PASS ' + title) }
  else { fail += 1; console.log('  FAIL ' + title + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))) }
}

/** 服务的激活是异步的：等到它出现（最多 1s）。 */
async function boot(config) {
  const ctx = new Context()
  ctx.plugin(SystemPrompt, config)
  for (let i = 0; i < 100; i += 1) {
    const service = ctx.get('systemPrompt')
    if (service !== undefined) return { ctx, service }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return { ctx, service: undefined }
}

const booted = await boot({ includeHarnessIdentity: true, includeRuntimeContext: false, personaPrefix: 'PERSONA_PREFIX_MARKER' })
ok('真实 systemPrompt 服务可用', typeof booted.service?.section === 'function')

if (booted.service !== undefined) {
  // 摆一个 order=1000（工具说明的位置）的段落，验证本插件现在落在它之后。
  booted.service.section({ name: 'test:tool-policy', order: 1000, text: 'TOOL_SECTION_MARKER' })
  const events = []
  apply(
    { systemPrompt: booted.service, on: (event) => { events.push(event); return () => {} } },
    Config({ language: 'zh', minCalls: 3, maxCalls: 6 }),
  )
  const prompt = renderPrompt(await booted.service.assemble({}))
  ok('组装出的系统提示里出现本插件的段落', prompt.includes('省步数：一步之内多发几个工具调用'), prompt.slice(0, 100))
  ok('段落排在人格前缀之后', prompt.indexOf('省步数') > prompt.indexOf('PERSONA_PREFIX_MARKER'), {
    personaAt: prompt.indexOf('PERSONA_PREFIX_MARKER'),
    sectionAt: prompt.indexOf('省步数'),
  })
  ok('段落排在工具说明之后（默认 order 9500）', prompt.indexOf('省步数') > prompt.indexOf('TOOL_SECTION_MARKER'), {
    toolAt: prompt.indexOf('TOOL_SECTION_MARKER'),
    sectionAt: prompt.indexOf('省步数'),
  })
  ok('段落带上配置的调用数区间', prompt.includes('3–6'))
  ok('段落带上 shell 合并规则', prompt.includes('a && b'))
  ok('段落含每步自检与 checkpoint 保留要求', prompt.includes('每步自检') && prompt.includes('Critical Context'))
  ok('在真实 ctx 上注册了压缩后提醒的两个监听', events.includes('session/event') && events.includes('agent/pre-step'), events)
}

const off = await boot({ includeHarnessIdentity: true, includeRuntimeContext: false })
if (off.service !== undefined) {
  apply({ systemPrompt: off.service, on: () => () => {} }, Config({ enabled: false }))
  const prompt = renderPrompt(await off.service.assemble({}))
  ok('enabled:false 时系统提示里没有该段落', prompt.includes('省步数') === false)
}

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
process.exit(fail === 0 ? 0 : 1)
