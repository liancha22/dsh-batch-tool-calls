#!/usr/bin/env node
/**
 * step-report —— 读一个 DSH 会话日志，报告「每步几个工具调用」，用来看
 * dsh-batch-tool-calls 装前装后的差别。
 *
 * 用法：
 *   node scripts/step-report.mjs <session.v3.jsonl.zstd|session.jsonl>
 *   node scripts/step-report.mjs "$HOME/.dsh/sessions/--sdcard-demo--/"session-XXXX/session.v3.jsonl.zstd
 *
 * 会话日志是「每批事件一个 zstd 帧」的拼接文件，Node 自带的一次性 API 只解第一帧，
 * 所以这里按 DSH 自己的做法先扫描帧边界，再逐帧解压。
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

/** 读出会话日志里的全部 JSONL 记录。 */
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

const READ_ONLY_HINT = new Set(['read', 'grep', 'glob', 'web_search', 'web_fetch', 'bash'])

function report(file) {
  const records = readRecords(file)
  const steps = []
  let current = null
  for (const record of records) {
    if (record.type === 'step/start') current = []
    else if (record.type === 'tool/call' && current !== null) current.push(record.data?.name ?? '(unknown)')
    else if (record.type === 'step/end' && current !== null) {
      steps.push(current)
      current = null
    }
  }
  const calls = steps.reduce((total, step) => total + step.length, 0)
  const distribution = new Map()
  for (const step of steps) distribution.set(step.length, (distribution.get(step.length) ?? 0) + 1)
  const single = steps.filter((step) => step.length === 1 && READ_ONLY_HINT.has(step[0])).length
  const toolCount = new Map()
  for (const step of steps) for (const tool of step) toolCount.set(tool, (toolCount.get(tool) ?? 0) + 1)

  console.log(`session: ${file}`)
  console.log(`steps=${steps.length}  tool_calls=${calls}  avg_calls_per_step=${steps.length === 0 ? '0' : (calls / steps.length).toFixed(2)}`)
  const table = [...distribution.entries()].sort((a, b) => a[0] - b[0]).map(([n, count]) => `${n}→${count}`).join('  ')
  console.log(`calls_per_step distribution: ${table || '(none)'}`)
  console.log(`single read-only/command step (mergeable in principle): ${single} / ${steps.length}`)
  const top = [...toolCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tool, count]) => `${tool}×${count}`).join('  ')
  console.log(`tool usage: ${top}`)
}

const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/step-report.mjs <session.v3.jsonl.zstd|session.jsonl>')
  process.exit(2)
}
report(target)
