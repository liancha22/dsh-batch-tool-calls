#!/usr/bin/env node
// 一条命令完成一次发布：改版本号 -> 提交 -> 打标签 -> 推送。
// 推送标签后 GitHub Actions（.github/workflows/publish.yml）会自动发 npm 并建 Release。
//
// 用法：
//   node scripts/release.mjs patch          # 1.0.0 -> 1.0.1
//   node scripts/release.mjs minor|major
//   node scripts/release.mjs 1.4.0          # 直接指定版本
//   node scripts/release.mjs patch --dry-run # 只检查、只打印，不动仓库
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(root, 'package.json')

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options }).trim()
}

function fail(message) {
  console.error('✗ ' + message)
  process.exit(1)
}

function bump(version, kind) {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(kind)) return kind
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const kind = args.find((arg) => arg !== '--dry-run')

if (!kind || !/^(patch|minor|major|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(kind)) {
  console.error('用法：node scripts/release.mjs patch|minor|major|<x.y.z> [--dry-run]')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const next = bump(pkg.version, kind)
const tag = 'v' + next

if (git(['status', '--porcelain'])) fail('工作区不干净，先提交或撤销改动再发布')
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') fail(`当前分支是 ${branch}，发布请在 main 上做`)
if (!git(['remote']).split('\n').includes('origin')) fail('没有配置 origin 远程仓库')
if (git(['tag', '--list', tag])) fail(`标签 ${tag} 已经存在`)

const ahead = git(['rev-list', '--count', '@{u}..HEAD'])
if (ahead !== '0') console.warn(`! 本地比远端多 ${ahead} 个提交，它们会一起被推上去`)

console.log(`${pkg.name}：${pkg.version} -> ${next}（标签 ${tag}）`)
if (dryRun) {
  console.log('--dry-run：只检查到这里，没有改动仓库。')
  process.exit(0)
}

execFileSync('npm', ['version', kind, '-m', 'chore(release): v%s'], { cwd: root, stdio: 'inherit' })
execFileSync('git', ['push', '--follow-tags'], { cwd: root, stdio: 'inherit' })

const remote = git(['remote', 'get-url', 'origin'])
const slug = remote.replace(/^git@github\.com:/, '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
console.log(`✓ 已推送 ${tag}，Actions 正在发布：https://github.com/${slug}/actions`)
