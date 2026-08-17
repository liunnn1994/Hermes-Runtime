#!/usr/bin/env node
// 在 Runtime 的 python/ 根目录准备干净的 Hermes Agent 浅克隆。发布时保留完整
// Git checkout，使 `hermes update` 可以拉取源码并就地更新 python/venv。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs'
import { arch as osArch, platform as osPlatform } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { hermesSource } from './runtime-config.mjs'
import { venvPythonPath } from './python-runtime-layout.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const SOURCE_DIR = resolve(ROOT, 'resources', 'python', `${OS_LABEL}-${TARGET_ARCH}`)
const VENV_DIR = resolve(SOURCE_DIR, 'venv')
const pyBin = venvPythonPath(VENV_DIR, TARGET_OS)
const source = hermesSource()

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: SOURCE_DIR,
    stdio: 'inherit',
    ...options,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: SOURCE_DIR,
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || '')
    process.exit(result.status ?? 1)
  }
  return result.stdout.trim()
}

if (!existsSync(pyBin)) {
  console.error(`找不到内置 Python：${pyBin}`)
  process.exit(1)
}

mkdirSync(SOURCE_DIR, { recursive: true })

if (!existsSync(resolve(SOURCE_DIR, '.git'))) {
  console.log(`→ 正在 ${SOURCE_DIR} 初始化 Hermes 源码仓库`)
  run('git', ['init'])
  run('git', ['remote', 'add', 'origin', source.repository])
} else {
  const origin = output('git', ['remote', 'get-url', 'origin'])
  if (origin !== source.repository) {
    console.error(`Hermes 源码 origin 不匹配：预期 ${source.repository}，实际 ${origin}`)
    process.exit(1)
  }
}

console.log(`→ 正在拉取 Hermes ${source.ref}（${source.commit.slice(0, 12)}）`)
// 注意：这里用 --depth 1 浅克隆控制体积。下游 `hermes update` 在浅仓库上
// 执行 git pull 时依赖现代 git 的 auto-deepen 补齐共同祖先；如果上游更新器
// 在旧 git 上报 "unrelated histories"，需要改为 fetch 时带足够的深度。
run('git', ['fetch', '--depth', '1', 'origin', source.ref])
// Release ref 可能是附注 tag，因此按名称拉取后必须解析并校验其实际 commit。
const fetchedCommit = output('git', ['rev-parse', 'FETCH_HEAD^{commit}']).toLowerCase()
if (fetchedCommit !== source.commit) {
  console.error(
    `Hermes 源码 commit 不匹配（${source.ref}）：预期 ${source.commit}，实际 ${fetchedCommit}`,
  )
  process.exit(1)
}

// 保留真实的 main 分支，因为上游更新器默认从 main 更新。
run('git', ['checkout', '-B', 'main', fetchedCommit])

const installedCommit = output('git', ['rev-parse', 'HEAD']).toLowerCase()
if (installedCommit !== source.commit) {
  console.error(`Hermes checkout 校验失败：预期 ${source.commit}，实际 ${installedCommit}`)
  process.exit(1)
}

const versionResult = spawnSync(pyBin, [
  '-c',
  [
    'import pathlib, tomllib',
    'data = tomllib.loads(pathlib.Path("pyproject.toml").read_text(encoding="utf-8"))',
    'print(data["project"]["version"])',
  ].join('; '),
], {
  cwd: SOURCE_DIR,
  encoding: 'utf-8',
})
if (versionResult.status !== 0) {
  process.stderr.write(versionResult.stderr || versionResult.stdout || '')
  process.exit(versionResult.status ?? 1)
}
const sourceVersion = versionResult.stdout.trim()
if (sourceVersion !== source.version) {
  console.error(`Hermes 版本不匹配：预期 ${source.version}，源码声明 ${sourceVersion}`)
  process.exit(1)
}

// 这些 Runtime 目录位于源码根目录，但不能污染 checkout，也不能被上游更新器的
// include-untracked 自动暂存逻辑带走。
const excludePath = resolve(SOURCE_DIR, '.git', 'info', 'exclude')
const exclude = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : ''
const runtimeExcludes = ['/base/', '/node/', '/ms-playwright/']
const missingExcludes = runtimeExcludes.filter(pattern => !exclude.split(/\r?\n/).includes(pattern))
if (missingExcludes.length > 0) {
  appendFileSync(excludePath, `${exclude.endsWith('\n') || !exclude ? '' : '\n'}${missingExcludes.join('\n')}\n`)
}

const dirty = output('git', ['status', '--porcelain'])
if (dirty) {
  console.error(`Hermes 源码准备完成后仍有未提交改动：\n${dirty}`)
  process.exit(1)
}

console.log(`✓ Hermes 源码已准备完成：${SOURCE_DIR}（${sourceVersion}，${installedCommit.slice(0, 12)}）`)
