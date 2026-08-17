#!/usr/bin/env node
// 清理内置 Python 环境中的缓存和测试文件，不修改外层 Hermes 源码 checkout。
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { platform as osPlatform, arch as osArch } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')

const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const PY_DIR = resolve(ROOT, 'resources', 'python', `${OS_LABEL}-${TARGET_ARCH}`)
const VENV_DIR = resolve(PY_DIR, 'venv')

if (!existsSync(VENV_DIR)) {
  console.error(`找不到内置 Python 环境：${VENV_DIR}`)
  process.exit(1)
}

const PRUNE_DIR_NAMES = new Set(['__pycache__', 'test', 'tests', 'idle_test', 'idlelib', 'turtledemo', 'tkinter', 'ensurepip'])
const PRUNE_FILE_SUFFIXES = ['.pyc', '.pyo']

let bytesFreed = 0
function walk(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      if (PRUNE_DIR_NAMES.has(name)) {
        bytesFreed += dirSize(p)
        rmSync(p, { recursive: true, force: true })
      } else {
        walk(p)
      }
    } else if (PRUNE_FILE_SUFFIXES.some(s => name.endsWith(s))) {
      bytesFreed += st.size
      rmSync(p, { force: true })
    }
  }
}
function dirSize(dir) {
  let total = 0
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      total += st.isDirectory() ? dirSize(p) : st.size
    }
  } catch {}
  return total
}

walk(VENV_DIR)

// 前端构建依赖可以通过保留的 lockfile 重建，并会由 `hermes update` 刷新；
// 发布包只保留构建后的 TUI 和控制台产物。
for (const nodeModules of [
  join(PY_DIR, 'node_modules'),
  join(PY_DIR, 'ui-tui', 'node_modules'),
  join(PY_DIR, 'web', 'node_modules'),
]) {
  if (!existsSync(nodeModules)) continue
  bytesFreed += dirSize(nodeModules)
  rmSync(nodeModules, { recursive: true, force: true })
}

console.log(`✓ 已从 ${VENV_DIR} 清理约 ${(bytesFreed / 1024 / 1024).toFixed(1)} MB`)
