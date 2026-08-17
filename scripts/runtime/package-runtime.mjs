#!/usr/bin/env node
// 把准备完成的 Python、Node.js 和 Git 打包为 Release 资产。
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { arch as osArch, platform as osPlatform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { hermesSource } from './runtime-config.mjs'
import {
  bundledBaseHomePath,
  configWithPythonHome,
  makeBundledBaseConfigPortable,
  venvPythonPath,
  windowsBatchCommandArgs,
} from './python-runtime-layout.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const PLATFORM = `${OS_LABEL}-${TARGET_ARCH}`
const OUT_DIR = resolve(ROOT, 'release', 'runtime')

const PY_DIR = resolve(ROOT, 'resources', 'python', PLATFORM)
const VENV_DIR = resolve(PY_DIR, 'venv')
const NODE_DIR = resolve(ROOT, 'resources', 'node', PLATFORM)
const GIT_DIR = resolve(ROOT, 'resources', 'git', PLATFORM)
const pyBin = venvPythonPath(VENV_DIR, TARGET_OS)
const configuredSource = hermesSource()

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result
}

function output(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf-8', ...options })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || '')
    process.exit(result.status ?? 1)
  }
  return result.stdout.trim()
}

async function sha256File(file) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(file)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', resolvePromise)
    stream.on('error', rejectPromise)
  })
  return hash.digest('hex')
}

for (const dir of [PY_DIR, NODE_DIR]) {
  if (!existsSync(dir)) {
    console.error(`缺少 Runtime 目录：${dir}`)
    process.exit(1)
  }
}

const hermesAgentVersion = output(pyBin, [
  '-c',
  'import importlib.metadata as m; print(m.version("hermes-agent"))',
])
if (hermesAgentVersion !== configuredSource.version) {
  console.error(
    `已安装的 Hermes 版本不匹配：预期 ${configuredSource.version}，实际 ${hermesAgentVersion}`,
  )
  process.exit(1)
}
if (!existsSync(join(PY_DIR, '.git'))) {
  console.error(`缺少 Hermes Git 元数据：${join(PY_DIR, '.git')}`)
  process.exit(1)
}
const sourceCommit = output('git', ['rev-parse', 'HEAD'], { cwd: PY_DIR }).toLowerCase()
const sourceBranch = output('git', ['branch', '--show-current'], { cwd: PY_DIR })
const sourceRepository = output('git', ['remote', 'get-url', 'origin'], { cwd: PY_DIR })
const dirtySource = output('git', ['status', '--porcelain'], { cwd: PY_DIR })
if (sourceCommit !== configuredSource.commit) {
  console.error(`Hermes 源码 commit 不匹配：预期 ${configuredSource.commit}，实际 ${sourceCommit}`)
  process.exit(1)
}
if (sourceRepository !== configuredSource.repository) {
  console.error(`Hermes 源码仓库不匹配：预期 ${configuredSource.repository}，实际 ${sourceRepository}`)
  process.exit(1)
}
if (sourceBranch !== 'main') {
  console.error(`Hermes 源码必须从更新分支 main 打包，当前为 ${sourceBranch || '分离 HEAD'}`)
  process.exit(1)
}
if (dirtySource) {
  console.error(`打包前 Hermes 源码 checkout 必须保持干净：\n${dirtySource}`)
  process.exit(1)
}
const assetName = `hermes-runtime-hermes-agent-${hermesAgentVersion}-${PLATFORM}.tar.gz`
const manifestName = `hermes-runtime-${PLATFORM}.json`

mkdirSync(OUT_DIR, { recursive: true })
const stage = mkdtempSync(join(tmpdir(), `hermes-runtime-${PLATFORM}-`))

try {
  cpSync(PY_DIR, join(stage, 'python'), { recursive: true, force: true, verbatimSymlinks: true })
  cpSync(NODE_DIR, join(stage, 'node'), { recursive: true, force: true, verbatimSymlinks: true })
  if (existsSync(GIT_DIR)) {
    cpSync(GIT_DIR, join(stage, 'git'), { recursive: true, force: true, verbatimSymlinks: true })
  } else {
    mkdirSync(join(stage, 'git'), { recursive: true })
    writeFileSync(join(stage, 'git', '.placeholder'), 'Git for Windows is only bundled on Windows.\n')
  }

  // 把 checkout 移入暂存目录后再次运行 Python 并导入 Hermes，防止把包含构建机
  // 绝对 editable 路径的损坏压缩包上传到 GitHub Actions。
  const stagedSource = join(stage, 'python')
  const stagedVenv = join(stagedSource, 'venv')
  const stagedPython = venvPythonPath(stagedVenv, TARGET_OS)
  const stagedPyvenvConfig = join(stagedVenv, 'pyvenv.cfg')
  if (TARGET_OS === 'win32') {
    writeFileSync(
      stagedPyvenvConfig,
      configWithPythonHome(
        readFileSync(stagedPyvenvConfig, 'utf-8'),
        bundledBaseHomePath(stagedSource, TARGET_OS),
      ),
    )
  }
  const stagedVersion = output(stagedPython, [
    '-c',
    [
      'import importlib.metadata as metadata',
      'from pathlib import Path',
      'import hermes_cli',
      `source = Path(${JSON.stringify(stagedSource)}).resolve()`,
      'module = Path(hermes_cli.__file__).resolve()',
      'assert module.is_relative_to(source), (module, source)',
      'print(metadata.version("hermes-agent"))',
    ].join('; '),
  ])
  if (stagedVersion !== hermesAgentVersion) {
    console.error(`迁移后的 Hermes 版本不匹配：预期 ${hermesAgentVersion}，实际 ${stagedVersion}`)
    process.exit(1)
  }
  const stagedCommit = output('git', ['rev-parse', 'HEAD'], { cwd: stagedSource }).toLowerCase()
  const stagedDirtySource = output('git', ['status', '--porcelain'], { cwd: stagedSource })
  if (stagedCommit !== sourceCommit || stagedDirtySource) {
    console.error(
      `暂存 Hermes checkout 校验失败：commit=${stagedCommit}，状态=${stagedDirtySource || '干净'}`,
    )
    process.exit(1)
  }
  if (TARGET_OS === 'win32') {
    // 归档中使用可移植相对路径；Windows 启动脚本会在运行前恢复为绝对路径。
    writeFileSync(
      stagedPyvenvConfig,
      makeBundledBaseConfigPortable(
        readFileSync(stagedPyvenvConfig, 'utf-8'),
        TARGET_OS,
      ),
    )
    const stagedHermes = join(stage, 'python', 'venv', 'Scripts', 'hermes.cmd')
    const wrapperVersion = output(
      'cmd.exe',
      windowsBatchCommandArgs(stagedHermes, ['--version']),
    )
    if (!wrapperVersion.includes(hermesAgentVersion)) {
      console.error(`Windows 可迁移启动器版本校验失败：${wrapperVersion}`)
      process.exit(1)
    }
    // 校验启动器时会写入暂存目录的绝对路径，归档前重新恢复为相对路径。
    writeFileSync(
      stagedPyvenvConfig,
      makeBundledBaseConfigPortable(
        readFileSync(stagedPyvenvConfig, 'utf-8'),
        TARGET_OS,
      ),
    )
  }

  const runtimeManifest = {
    schema: 2,
    platform: PLATFORM,
    targetOs: TARGET_OS,
    targetArch: TARGET_ARCH,
    hermesAgentVersion,
    hermesSource: {
      repository: sourceRepository,
      ref: configuredSource.ref,
      commit: sourceCommit,
      installMethod: 'git',
    },
    asset: {
      name: assetName,
    },
  }
  writeFileSync(join(stage, 'runtime-manifest.json'), JSON.stringify(runtimeManifest, null, 2) + '\n')

  const assetPath = resolve(OUT_DIR, assetName)
  rmSync(assetPath, { force: true })
  run('tar', ['-czf', assetPath, '-C', stage, '.'])

  const sha256 = await sha256File(assetPath)
  writeFileSync(`${assetPath}.sha256`, `${sha256}  ${assetName}\n`)

  const platformManifest = {
    ...runtimeManifest,
    createdAt: new Date().toISOString(),
    asset: {
      name: assetName,
      sha256,
      size: statSync(assetPath).size,
    },
  }
  writeFileSync(resolve(OUT_DIR, manifestName), JSON.stringify(platformManifest, null, 2) + '\n')

  console.log(`Runtime 资产：${assetPath}`)
  console.log(`Runtime 清单：${resolve(OUT_DIR, manifestName)}`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
