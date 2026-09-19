#!/usr/bin/env node
/**
 * cache-audit —— 读一个 DSH 会话日志，逐请求报告**提示缓存**的命中情况，
 * 并把每次「缓存中断」（上一次请求的整个前缀没被命中、只能重新算）和它前面
 * 刚刚发生的事情列出来，用来回答「是不是某个插件把缓存搞坏了」。
 *
 * 用法：
 *   node scripts/cache-audit.mjs <session.v3.jsonl.zstd|session.jsonl> [--all]
 *
 * 指标口径（与宿主一致）：
 *   命中率 = cacheRead / (inputTokens + cacheRead + cacheWrite)
 *   其中日志里的 `usage.inputTokens` 是**未命中**那部分（宿主 token 表里叫
 *   `uncachedInputTokens`；见 dsh-session-health/lib/usage.js 的注释）。
 *
 * 会标出来的东西：
 *   COMPACT    compaction/start、compaction/summary、compaction/end（带 error 会标 FAIL）
 *   NOTICE     source.plugin 是本插件（或其他插件）注入的 user 消息
 *   SYSMSG     追加/替换了 system/message（系统提示被重新提交 → 前缀会从那里断）
 *   USER       用户自己发的消息
 *   STEP       进入新的一步 / 新一轮
 *
 * 会话日志是「每批事件一个 zstd 帧」的拼接文件，Node 自带的一次性 API 只解第一帧，
 * 所以这里按 DSH 自己的做法先扫描帧边界，再逐帧解压（与 step-report.mjs 同一套）。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/** 扫描拼接 zstd 流的帧边界（与 dsh-session-persistence-jsonl 的扫描规则一致）。 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 读出会话日志里的全部 JSONL 记录（帧不完整时保留已解析部分）。 */
function readRecords(file) {
  const bytes = readFileSync(file)
  if (bytes.length === 0) return []
  const records = []
  const push = (text) => {
    for (const line of text.split('\n')) if (line.trim().length > 0) records.push(JSON.parse(line))
  }
  if (bytes.readUInt32LE(0) === ZSTD_MAGIC) {
    const { frames } = scanZstdFrames(bytes)
    for (const frame of frames) push(zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8'))
    return records
  }
  push(bytes.toString('utf8'))
  return records
}

const compact = (value) => {
  if (value === undefined || value === null) return '-'
  if (value < 10000) return String(value)
  return (value / 1000).toFixed(value < 100000 ? 1 : 0) + 'k'
}
const clock = (time) => (typeof time === 'number' ? new Date(time).toISOString().slice(11, 19) : '-')

/** 一条 usage 记录 → 命中率与总前缀压力。 */
function bucketsOf(usage) {
  const uncached = usage.inputTokens ?? 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const denominator = uncached + cacheRead + cacheWrite
  return { uncached, cacheRead, cacheWrite, pressure: denominator, hitRate: denominator > 0 ? cacheRead / denominator : null }
}

/** 标记一条事件（只保留判断缓存中断需要的种类）。 */
function markOf(record, state) {
  const type = record.type
  if (type === 'compaction/start') return 'COMPACT-start'
  if (type === 'compaction/summary') return 'COMPACT-summary'
  if (type === 'compaction/end') return record.data?.error === undefined ? 'COMPACT-end' : 'COMPACT-FAIL'
  if (type === 'system/message') return record.data?.message?.content?.length === 0 ? 'SYSMSG-empty' : 'SYSMSG'
  if (type === 'session/end-seed') return 'SEED'
  if (type === 'agent-preset/selected') return 'PRESET'
  if (type === 'request/header') return 'HEADER'
  if (type === 'request/context') {
    const route = String(record.data?.provider ?? '?') + '/' + String(record.data?.model ?? '?')
    const change = state.route !== undefined && state.route !== route ? 'ROUTE-CHANGE:' + state.route + '→' + route : undefined
    state.route = route
    const update = record.data?.systemPromptUpdate
    return change ?? (update === undefined ? undefined : 'CTX:systemPromptUpdate=' + String(update))
  }
  if (type === 'user/message') {
    const source = record.data?.source ?? record.data?.message?.source
    const kind = source?.kind
    if (kind === 'plugin') return 'NOTICE:' + String(source?.plugin ?? '?')
    if (kind === 'user') return 'USER'
    return 'MSG:' + String(kind ?? '?')
  }
  if (type === 'turn/start') return 'TURN'
  return undefined
}

/**
 * 把一次缓存中断归因到最可能的原因。
 * 顺序即优先级：压缩必然重写历史，重启/换模型/改系统提示都会让前缀变化，
 * 都不是本插件造成的；只有「什么都没发生」才需要继续看内容。
 */
function breakCause(marks, gapMs) {
  const list = marks.map((entry) => entry.mark)
  if (list.some((mark) => mark.startsWith('COMPACT'))) return '压缩上下文（checkpoint 替换旧历史，固有代价）'
  if (list.includes('SEED')) return '进程/会话重启（session/end-seed）'
  if (list.some((mark) => mark.startsWith('ROUTE-CHANGE'))) return '模型路由变化'
  if (list.includes('HEADER')) return '请求头/路由配置变化'
  if (list.some((mark) => mark.startsWith('SYSMSG'))) return '系统提示被重新提交'
  if (list.includes('PRESET')) return '切换 Agent 预设'
  if (gapMs > 10 * 60 * 1000) return '空闲超过 10 分钟（服务端缓存过期）'
  return '无标记（需要看这一段具体内容）'
}

function audit(file, options) {
  const records = readRecords(file)
  const rows = []
  let pending = []
  let first = true
  const state = {}
  for (const record of records) {
    const mark = markOf(record, state)
    if (mark !== undefined) pending.push({ mark, seq: record.seq })
    if (record.type !== 'assistant/message') continue
    const usage = record.data?.usage
    if (usage === undefined) continue
    const buckets = bucketsOf(usage)
    rows.push({
      seq: record.seq,
      time: record.time,
      turn: record.data?.turn,
      step: record.data?.step,
      ...buckets,
      marks: pending,
      firstOfProcess: first,
    })
    pending = []
    first = false
  }

  console.log(`session: ${file}`)
  console.log(`带 usage 的响应数: ${rows.length}`)
  if (rows.length === 0) return

  // 请求头（tools + 路由配置）提交次数：工具清单一旦变化，整条前缀都要重算，
  // 这是实测里最大的一类缓存中断来源（动态注册/注销工具就会触发）。
  const headerCount = records.filter((record) => record.type === 'request/header').length
  const sysCount = records.filter((record) => record.type === 'system/message').length
  const seedCount = records.filter((record) => record.type === 'session/end-seed').length
  console.log(`request/header 提交 ${headerCount} 次 | system/message 提交 ${sysCount} 次 | session/end-seed ${seedCount} 次`)

  const total = rows.reduce((sum, row) => ({
    uncached: sum.uncached + row.uncached,
    cacheRead: sum.cacheRead + row.cacheRead,
    cacheWrite: sum.cacheWrite + row.cacheWrite,
  }), { uncached: 0, cacheRead: 0, cacheWrite: 0 })
  const denominator = total.uncached + total.cacheRead + total.cacheWrite
  console.log(`总计：未命中 ${total.uncached} / 命中读 ${total.cacheRead} / 写入 ${total.cacheWrite}`
    + `  → 整体命中率 ${denominator > 0 ? ((total.cacheRead / denominator) * 100).toFixed(1) : '-'}%`)

  // 缓存中断：这一次能命中的前缀明显小于上一次的整体前缀，说明前面某处变了。
  const breaks = []
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]
    const row = rows[index]
    if (previous.pressure < 20000) continue
    if (row.cacheRead >= previous.pressure * 0.5) continue
    const gapMs = (row.time ?? 0) - (previous.time ?? 0)
    breaks.push({ index, row, previous, gapMs, cause: breakCause(row.marks, gapMs) })
  }
  console.log(`\n缓存中断（本次命中读 < 上次前缀的一半，且上次前缀 >20k）：${breaks.length} 次`)
  for (const item of breaks) {
    const marks = item.row.marks.map((entry) => entry.mark).join(',') || '(无标记)'
    console.log(`  #${item.index} seq=${item.row.seq} ${clock(item.row.time)} 间隔 ${Math.round(item.gapMs / 1000)}s`
      + ` 未命中 ${compact(item.row.uncached)} 命中读 ${compact(item.row.cacheRead)}（上次前缀 ${compact(item.previous.pressure)}）`)
    console.log(`      原因：${item.cause}`)
    console.log(`      期间事件：${marks}`)
  }

  const byCause = new Map()
  for (const item of breaks) {
    const entry = byCause.get(item.cause) ?? { count: 0, uncached: 0 }
    entry.count += 1
    entry.uncached += item.row.uncached
    byCause.set(item.cause, entry)
  }
  if (byCause.size > 0) {
    console.log('\n按原因汇总：')
    for (const [cause, entry] of [...byCause.entries()].sort((a, b) => b[1].uncached - a[1].uncached)) {
      console.log(`  ${entry.count}×  ${cause}  → 未命中合计 ${entry.uncached} token`)
    }
  }

  // 本插件注入的提醒，和它所在那一次请求的缓存表现
  const noticeRows = rows.filter((row) => row.marks.some((entry) => entry.mark === 'NOTICE:batch-tool-calls'))
  console.log(`\n本插件注入的提醒所在请求：${noticeRows.length} 次`)
  for (const row of noticeRows) {
    const coLocated = row.marks.some((entry) => entry.mark.startsWith('COMPACT')) ? '与压缩同批（压缩本身就会重写前缀）' : '未与压缩同批'
    console.log(`  seq=${row.seq} ${clock(row.time)} 未命中 ${compact(row.uncached)} 命中读 ${compact(row.cacheRead)}`
      + ` 命中率 ${row.hitRate === null ? '-' : (row.hitRate * 100).toFixed(1) + '%'} — ${coLocated}`)
    console.log(`      期间事件：${row.marks.map((entry) => entry.mark).join(',')}`)
  }
  const bareNotice = rows.filter((row) => row.marks.some((entry) => entry.mark === 'NOTICE:batch-tool-calls')
    && !row.marks.some((entry) => entry.mark.startsWith('COMPACT')))
  console.log(`其中「没有压缩、只有提醒」的请求：${bareNotice.length} 次`
    + `（这些才是提醒单独造成的代价，正常情况下应为 0 或只有几十 token 未命中）`)

  const limit = options.all ? rows.length : 40
  console.log(`\n逐请求时间线（最后 ${Math.min(limit, rows.length)} 条）：`)
  console.log('  #     seq   时刻      间隔   未命中  命中读  写入   命中率  刚发生')
  for (let index = Math.max(0, rows.length - limit); index < rows.length; index += 1) {
    const row = rows[index]
    const gap = index === 0 ? '-' : String(Math.round(((row.time ?? 0) - (rows[index - 1].time ?? 0)) / 1000)) + 's'
    const marks = row.marks.map((entry) => entry.mark).join(',')
    console.log(`  ${String(index).padStart(4)}  ${String(row.seq).padStart(5)} ${clock(row.time)}`
      + ` ${gap.padStart(6)} ${compact(row.uncached).padStart(7)} ${compact(row.cacheRead).padStart(7)} ${compact(row.cacheWrite).padStart(6)}`
      + `  ${row.hitRate === null ? '  -  ' : (row.hitRate * 100).toFixed(1).padStart(5) + '%'}  ${marks}`)
  }
}

const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/cache-audit.mjs <session.v3.jsonl.zstd|session.jsonl> [--all]')
  process.exit(2)
}
audit(target, { all: process.argv.includes('--all') })
