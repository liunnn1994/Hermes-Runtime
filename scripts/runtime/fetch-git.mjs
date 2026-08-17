#!/usr/bin/env node
// Windows 构建下载 MinGit；其他平台创建占位目录，以保持统一的 Runtime 结构。
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arch as osArch, platform as osPlatform, tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')

const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const OUT_DIR = resolve(ROOT, 'resources', 'git', `${OS_LABEL}-${TARGET_ARCH}`)

mkdirSync(OUT_DIR, { recursive: true })

if (TARGET_OS !== 'win32') {
  writeFileSync(resolve(OUT_DIR, '.placeholder'), 'Git for Windows is only bundled on Windows.\n')
  console.log(`Git 占位目录已准备完成：${OUT_DIR}`)
  process.exit(0)
}

if (TARGET_ARCH !== 'x64') {
  console.error(`不支持的 Git for Windows 目标平台：${TARGET_OS}-${TARGET_ARCH}`)
  process.exit(1)
}

if (existsSync(resolve(OUT_DIR, 'cmd', 'git.exe'))) {
  console.log(`Git for Windows 已存在于 ${OUT_DIR}，跳过下载`)
  process.exit(0)
}

async function latestMinGitUrl() {
  if (process.env.GIT_FOR_WINDOWS_URL?.trim()) return process.env.GIT_FOR_WINDOWS_URL.trim()

  const headers = { 'User-Agent': 'hermes-runtime-build' }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`

  const response = await fetch('https://api.github.com/repos/git-for-windows/git/releases/latest', {
    headers,
  })
  if (!response.ok) {
    throw new Error(`GitHub API 返回 ${response.status}`)
  }
  const release = await response.json()
  const asset = release.assets?.find(candidate =>
    typeof candidate?.name === 'string'
    && /^MinGit-.*-64-bit\.zip$/.test(candidate.name)
    && typeof candidate.browser_download_url === 'string',
  )
  if (!asset) throw new Error('最新版 Git for Windows Release 中没有 MinGit 64 位压缩包')
  return asset.browser_download_url
}

let url
try {
  url = await latestMinGitUrl()
} catch (err) {
  console.error(`解析 Git for Windows 下载地址失败：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const file = url.split('/').pop() || 'mingit.zip'
const archivePath = resolve(tmpdir(), file)

console.log(`正在下载 ${url}`)
const curl = spawnSync('curl', ['-fL', '--retry', '3', '-o', archivePath, url], { stdio: 'inherit' })
if (curl.status !== 0) {
  console.error('curl 下载失败')
  process.exit(curl.status ?? 1)
}

console.log(`正在解压到 ${OUT_DIR}`)
const extract = spawnSync('tar', ['-xf', archivePath, '-C', OUT_DIR], { stdio: 'inherit' })
if (extract.status !== 0) {
  console.error('解压失败')
  process.exit(extract.status ?? 1)
}

rmSync(archivePath, { force: true })
console.log(`Git for Windows 已准备完成：${OUT_DIR}`)
