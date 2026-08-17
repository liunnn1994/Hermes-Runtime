#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export const UPSTREAM_REPOSITORY = 'NousResearch/hermes-agent'
export const SOURCE_REPOSITORY = 'https://github.com/NousResearch/hermes-agent.git'
export const RUNTIME_TAG_PATTERN = /^hermes-(\d+\.\d+\.\d+)-runtime$/

export function parseVersion(value) {
  const match = String(value ?? '').match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return null
  return match.slice(1).map(Number)
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new Error(`无法比较无效版本：${left}、${right}`)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

export function versionFromUpstreamRelease(release) {
  if (release?.draft || release?.prerelease) return null
  const match = String(release?.name ?? '').match(/\bHermes Agent v(\d+\.\d+\.\d+)\b/i)
  return match?.[1] ?? null
}

export function versionFromRuntimeRelease(release) {
  if (release?.draft || release?.prerelease) return null
  return String(release?.tag_name ?? '').match(RUNTIME_TAG_PATTERN)?.[1] ?? null
}

function uniqueUpstreamReleases(releases) {
  const byVersion = new Map()
  for (const release of releases) {
    const version = versionFromUpstreamRelease(release)
    if (!version) continue
    const existing = byVersion.get(version)
    if (!existing || String(release.published_at) > String(existing.published_at)) {
      byVersion.set(version, { ...release, version })
    }
  }
  return [...byVersion.values()]
}

export function selectRelease(upstreamReleases, runtimeReleases) {
  const upstream = uniqueUpstreamReleases(upstreamReleases)
    .sort((a, b) => compareVersions(a.version, b.version))
  if (upstream.length === 0) throw new Error('没有找到带语义版本号的 Hermes Agent 稳定版')

  const publishedVersions = runtimeReleases
    .map(versionFromRuntimeRelease)
    .filter(Boolean)
    .sort(compareVersions)

  // 初始化规则：没有 Runtime Release 的仓库从上游最新版本开始，
  // 不补发更早的 Hermes 版本。
  if (publishedVersions.length === 0) return upstream.at(-1)

  // 初始化完成后，每次工作流只推进一个上游 Release；即使两次轮询之间出现
  // 多个新版本，也能保证发布顺序确定。
  const latestPublished = publishedVersions.at(-1)
  return upstream.find(release => compareVersions(release.version, latestPublished) > 0) ?? null
}

export function createGithubClient({ token = '', fetchImpl = fetch } = {}) {
  return async function github(path) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Hermes-Runtime-release-planner',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`GitHub API 请求 ${path} 返回 ${response.status}：${body.slice(0, 500)}`)
    }
    return response.json()
  }
}

export async function listReleases(github, repository) {
  const releases = []
  for (let page = 1; page <= 10; page += 1) {
    const batch = await github(`/repos/${repository}/releases?per_page=100&page=${page}`)
    releases.push(...batch)
    if (batch.length < 100) return releases
  }
  throw new Error(`${repository} 的 Release 历史记录超过 1,000 条安全上限`)
}

export async function peelTagToCommit(github, repository, tagName) {
  let object = (await github(
    `/repos/${repository}/git/ref/tags/${encodeURIComponent(tagName)}`,
  )).object

  for (let depth = 0; depth < 5; depth += 1) {
    if (object?.type === 'commit' && /^[0-9a-f]{40}$/i.test(object.sha)) {
      return object.sha.toLowerCase()
    }
    if (object?.type !== 'tag' || !/^[0-9a-f]{40}$/i.test(object.sha)) break
    object = (await github(`/repos/${repository}/git/tags/${object.sha}`)).object
  }
  throw new Error(`无法将 ${repository}@${tagName} 解析为 Git commit`)
}

export async function buildPlan({ repository, token = '', fetchImpl = fetch }) {
  if (!repository?.includes('/')) throw new Error('GITHUB_REPOSITORY 必须使用 owner/name 格式')
  const github = createGithubClient({ token, fetchImpl })
  const [upstreamReleases, runtimeReleases] = await Promise.all([
    listReleases(github, UPSTREAM_REPOSITORY),
    listReleases(github, repository),
  ])
  const selected = selectRelease(upstreamReleases, runtimeReleases)
  if (!selected) return { should_build: 'false' }

  const sourceCommit = await peelTagToCommit(
    github,
    UPSTREAM_REPOSITORY,
    selected.tag_name,
  )
  return {
    should_build: 'true',
    version: selected.version,
    source_ref: selected.tag_name,
    source_commit: sourceCommit,
    source_repository: SOURCE_REPOSITORY,
    runtime_tag: `hermes-${selected.version}-runtime`,
    upstream_url: selected.html_url,
    upstream_published_at: selected.published_at,
  }
}

function emitPlan(plan) {
  const output = process.env.GITHUB_OUTPUT
  if (!output) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    return
  }
  for (const [key, value] of Object.entries(plan)) {
    appendFileSync(output, `${key}=${String(value)}\n`)
  }
}

async function main() {
  const plan = await buildPlan({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  })
  emitPlan(plan)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  })
}
