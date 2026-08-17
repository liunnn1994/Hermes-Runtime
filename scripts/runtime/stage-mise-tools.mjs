#!/usr/bin/env node
// mise 负责安装并校验固定版本的 Node.js 和 Python；本脚本只把已经安装好的
// 工具目录整理为 Runtime 需要的布局，不执行下载或源码编译。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch as osArch, platform as osPlatform } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  bundledBaseHomePath,
  bundledBasePythonPath,
  configWithPythonHome,
  venvPythonPath,
} from './python-runtime-layout.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const PLATFORM = `${OS_LABEL}-${TARGET_ARCH}`
const PY_DIR = resolve(ROOT, 'resources', 'python', PLATFORM)
const VENV_DIR = resolve(PY_DIR, 'venv')
const BASE_DIR = resolve(PY_DIR, 'base')
const NODE_DIR = resolve(ROOT, 'resources', 'node', PLATFORM)

if (TARGET_OS !== osPlatform() || TARGET_ARCH !== osArch()) {
  console.error(
    `mise 必须在目标平台原生安装 Runtime：目标 ${TARGET_OS}-${TARGET_ARCH}，当前 ${osPlatform()}-${osArch()}`,
  )
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf-8' })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || '')
    process.exit(result.status ?? 1)
  }
  return result.stdout.trim()
}

function miseToolPath(tool) {
  const path = output('mise', ['where', tool])
  if (!path || !existsSync(path)) {
    console.error(`mise 没有安装 ${tool}，请先执行 mise install ${tool}`)
    process.exit(1)
  }
  return path
}

const miseNodeDir = miseToolPath('node')
const misePythonDir = miseToolPath('python')

rmSync(NODE_DIR, { recursive: true, force: true })
mkdirSync(dirname(NODE_DIR), { recursive: true })
cpSync(miseNodeDir, NODE_DIR, { recursive: true, verbatimSymlinks: true })

mkdirSync(PY_DIR, { recursive: true })
rmSync(VENV_DIR, { recursive: true, force: true })
rmSync(BASE_DIR, { recursive: true, force: true })

if (TARGET_OS === 'win32') {
  cpSync(misePythonDir, BASE_DIR, { recursive: true, verbatimSymlinks: true })
  const basePython = bundledBasePythonPath(PY_DIR, TARGET_OS)
  run('uv', [
    'venv',
    VENV_DIR,
    '--python', basePython,
    '--relocatable',
    '--no-project',
  ])

  const pyvenvConfig = resolve(VENV_DIR, 'pyvenv.cfg')
  writeFileSync(
    pyvenvConfig,
    configWithPythonHome(
      readFileSync(pyvenvConfig, 'utf-8'),
      bundledBaseHomePath(PY_DIR, TARGET_OS),
    ),
  )
} else {
  // mise 的 Python 使用 python-build-standalone 预编译包；关闭 sysconfig 路径
  // 修补后，复制出来的解释器仍保持上游的可迁移布局。
  cpSync(misePythonDir, VENV_DIR, { recursive: true, verbatimSymlinks: true })
}

const nodeBin = TARGET_OS === 'win32'
  ? resolve(NODE_DIR, 'node.exe')
  : resolve(NODE_DIR, 'bin', 'node')
const pythonBin = venvPythonPath(VENV_DIR, TARGET_OS)

if (!existsSync(nodeBin) || !existsSync(pythonBin)) {
  console.error(`mise Runtime 布局不完整：Node.js=${nodeBin}，Python=${pythonBin}`)
  process.exit(1)
}

const nodeVersion = output(nodeBin, ['--version'])
const pythonVersion = output(pythonBin, ['--version'])
console.log(`✓ 已从 mise 准备 Runtime 工具：Node.js ${nodeVersion}，${pythonVersion}`)
