#!/usr/bin/env node
// 在构建 Release 前读取对应 Hermes Agent commit 的安装脚本，并用 mise 把
// Runtime 工具更新到上游声明版本线中的最新正式补丁版本。
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MISE_CONFIG = resolve(ROOT, 'mise.toml')
const MISE_LOCK = resolve(ROOT, 'mise.lock')
const LOCK_PLATFORMS = 'windows-x64,macos-x64,macos-arm64,linux-x64,linux-arm64'

function requiredMatch(source, pattern, label) {
  const value = String(source).match(pattern)?.[1]
  if (!value) throw new Error(`无法从 Hermes Agent ${label} 中读取工具版本`)
  return value
}

export function parsePosixInstaller(source) {
  return {
    python: requiredMatch(source, /^\s*PYTHON_VERSION\s*=\s*["']([0-9]+(?:\.[0-9]+){0,2})["']/m, 'install.sh'),
    node: requiredMatch(source, /^\s*NODE_VERSION\s*=\s*["']([0-9]+(?:\.[0-9]+){0,2})["']/m, 'install.sh'),
  }
}

export function parseWindowsInstaller(source) {
  return {
    python: requiredMatch(source, /^\s*\$PythonVersion\s*=\s*["']([0-9]+(?:\.[0-9]+){0,2})["']/mi, 'install.ps1'),
    node: requiredMatch(source, /^\s*\$NodeVersion\s*=\s*["']([0-9]+(?:\.[0-9]+){0,2})["']/mi, 'install.ps1'),
  }
}

function compareVersionChannels(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export function selectHermesToolChannels(posix, windows) {
  if (posix.python !== windows.python) {
    throw new Error(
      `Hermes Agent 的 Python 版本声明不一致：install.sh=${posix.python}，install.ps1=${windows.python}`,
    )
  }
  return {
    python: posix.python,
    // 注意：上游偶尔会先更新一个平台的安装器，导致两边的 Node 版本线分歧
    // （例如 v2026.8.16 时 install.sh 为 26、install.ps1 为 22）。这里刻意
    // 取较新的版本线用于全平台 Runtime，依赖 Hermes 对 Node 大版本的前向
    // 兼容；若上游 Windows 安装器钉旧版本是绕开某个 Windows 特有 bug，
    // 该决策需要重新评估，届时可改为按平台分别锁定的 mise 配置。
    node: compareVersionChannels(posix.node, windows.node) >= 0 ? posix.node : windows.node,
  }
}

export function updateMiseConfig(source, versions) {
  let updated = String(source).replace(
    /^node\s*=\s*"[^"]+"$/m,
    `node = "${versions.node}"`,
  )
  updated = updated.replace(
    /^python\s*=\s*\{\s*version\s*=\s*"[^"]+"\s*,\s*patch_sysconfig\s*=\s*false\s*\}$/m,
    `python = { version = "${versions.python}", patch_sysconfig = false }`,
  )
  if (!updated.includes(`node = "${versions.node}"`)) {
    throw new Error('mise.toml 中缺少可更新的 Node.js 配置')
  }
  if (!updated.includes(`python = { version = "${versions.python}", patch_sysconfig = false }`)) {
    throw new Error('mise.toml 中缺少可更新的 Python 配置')
  }
  return updated
}

async function fetchGithubFile(repository, commit, path, token, fetchImpl = fetch) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/contents/${path}?ref=${commit}`,
    {
      headers: {
        Accept: 'application/vnd.github.raw+json',
        'User-Agent': 'Hermes-Runtime-tool-sync',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  )
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`读取 ${repository}@${commit}:${path} 失败（${response.status}）：${body.slice(0, 500)}`)
  }
  return response.text()
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf-8' })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || '')
    throw new Error(`${command} ${args.join(' ')} 执行失败`)
  }
  return result.stdout.trim()
}

function resolveLatestVersion(tool, channel) {
  const version = output('mise', ['latest', `${tool}@${channel}`])
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`mise 返回了无效的 ${tool} 版本：${version}`)
  }
  return version
}

function refreshMiseLock() {
  const result = spawnSync('mise', ['lock', '--platform', LOCK_PLATFORMS], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error('mise 无法生成五平台锁文件')

  const generated = readFileSync(MISE_LOCK, 'utf-8')
  writeFileSync(
    MISE_LOCK,
    generated.replace(
      /^# @generated.*$/m,
      '# 此文件由 mise lock 自动生成，用于锁定各平台工具来源和校验和。',
    ),
  )
}

function emitOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return
  for (const [key, value] of Object.entries(values)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  }
}

async function main() {
  const repository = process.env.HERMES_UPSTREAM_REPOSITORY || 'NousResearch/hermes-agent'
  const commit = String(process.env.HERMES_SOURCE_COMMIT || '').trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('HERMES_SOURCE_COMMIT 必须是 40 位完整 Git commit')
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  const [posixSource, windowsSource] = await Promise.all([
    fetchGithubFile(repository, commit, 'scripts/install.sh', token),
    fetchGithubFile(repository, commit, 'scripts/install.ps1', token),
  ])
  const posix = parsePosixInstaller(posixSource)
  const windows = parseWindowsInstaller(windowsSource)
  const channels = selectHermesToolChannels(posix, windows)
  const versions = {
    node: resolveLatestVersion('node', channels.node),
    python: resolveLatestVersion('python', channels.python),
  }

  console.log(
    `Hermes 工具要求：Node.js ${posix.node}/${windows.node}，Python ${channels.python}；`
    + `mise 解析为 Node.js ${versions.node}、Python ${versions.python}`,
  )
  const previous = readFileSync(MISE_CONFIG, 'utf-8')
  const updated = updateMiseConfig(previous, versions)
  writeFileSync(MISE_CONFIG, updated)
  refreshMiseLock()
  emitOutputs({ node_version: versions.node, python_version: versions.python })
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  })
}
