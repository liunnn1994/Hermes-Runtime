import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPlan,
  compareVersions,
  peelTagToCommit,
  selectRelease,
  versionFromRuntimeRelease,
  versionFromUpstreamRelease,
} from '../scripts/release-plan.mjs'

function upstream(version, tag, extra = {}) {
  return {
    name: `Hermes Agent v${version} (${tag.slice(1)})`,
    tag_name: tag,
    html_url: `https://example.test/${tag}`,
    published_at: `${tag.slice(1).replaceAll('.', '-')}T00:00:00Z`,
    draft: false,
    prerelease: false,
    ...extra,
  }
}

function runtime(version, extra = {}) {
  return {
    tag_name: `hermes-${version}-runtime`,
    draft: false,
    prerelease: false,
    ...extra,
  }
}

test('语义版本号按数值比较', () => {
  assert.equal(compareVersions('0.20.10', '0.20.2') > 0, true)
  assert.equal(compareVersions('1.0.0', '0.99.99') > 0, true)
  assert.equal(compareVersions('0.20.2', '0.20.2'), 0)
})

test('Release 解析器拒绝草稿和无关名称', () => {
  assert.equal(versionFromUpstreamRelease(upstream('0.20.2', 'v2026.8.16')), '0.20.2')
  assert.equal(versionFromUpstreamRelease(upstream('0.20.2', 'v2026.8.16', { draft: true })), null)
  assert.equal(versionFromRuntimeRelease(runtime('0.20.2')), '0.20.2')
  assert.equal(versionFromRuntimeRelease({ tag_name: 'v0.20.2' }), null)
})

test('空 Runtime 仓库初始化时只选择最新 Release', () => {
  const selected = selectRelease([
    upstream('0.20.0', 'v2026.8.3'),
    upstream('0.20.2', 'v2026.8.16'),
    upstream('0.20.1', 'v2026.8.13'),
  ], [])
  assert.equal(selected.version, '0.20.2')
})

test('已初始化仓库每次只推进一个 Release', () => {
  const releases = [
    upstream('0.20.3', 'v2026.8.20'),
    upstream('0.21.0', 'v2026.8.25'),
  ]
  assert.equal(selectRelease(releases, [runtime('0.20.2')]).version, '0.20.3')
  assert.equal(selectRelease(releases, [runtime('0.20.3')]).version, '0.21.0')
  assert.equal(selectRelease(releases, [runtime('0.21.0')]), null)
})

test('附注 tag 可以解析为 commit 对象', async () => {
  const responses = new Map([
    ['/repos/NousResearch/hermes-agent/git/ref/tags/v2026.8.16', {
      object: { type: 'tag', sha: 'a'.repeat(40) },
    }],
    [`/repos/NousResearch/hermes-agent/git/tags/${'a'.repeat(40)}`, {
      object: { type: 'commit', sha: 'DF4B65147D7DDD74DD449F9067AABBCA5AEF0EC7' },
    }],
  ])
  const commit = await peelTagToCommit(async path => responses.get(path), 'NousResearch/hermes-agent', 'v2026.8.16')
  assert.equal(commit, 'df4b65147d7ddd74dd449f9067aabbca5aef0ec7')
})

// 手动补发模式共用的假 fetch：按路径返回预设响应，未命中返回 404。
// buildPlan 的 fetchImpl 收到完整 URL，这里剥离 API 前缀后再查表。
function fakeGithub(responses) {
  return async url => {
    const path = String(url).replace(/^https:\/\/api\.github\.com/, '')
    const body = responses.get(path)
    if (!body) {
      return { ok: false, status: 404, text: async () => 'Not Found', json: async () => ({}) }
    }
    return { ok: true, status: 200, text: async () => '', json: async () => body }
  }
}

const UPSTREAM_RELEASE = {
  name: 'Hermes Agent v0.20.5 (2026.8.19)',
  tag_name: 'v2026.8.19',
  html_url: 'https://example.test/v2026.8.19',
  published_at: '2026-08-19T00:00:00Z',
  draft: false,
  prerelease: false,
}
const ANNOTATED_TAG_RESPONSES = new Map([
  ['/repos/NousResearch/hermes-agent/git/ref/tags/v2026.8.19', {
    object: { type: 'commit', sha: 'f'.repeat(40) },
  }],
])

test('手动指定上游 ref 时按该 Release 生成构建计划', async () => {
  const plan = await buildPlan({
    repository: 'example/runtime',
    fetchImpl: fakeGithub(new Map([
      ['/repos/NousResearch/hermes-agent/releases/tags/v2026.8.19', UPSTREAM_RELEASE],
      ...ANNOTATED_TAG_RESPONSES,
      ['/repos/example/runtime/releases?per_page=100&page=1', [runtime('0.21.1')]],
    ])),
    upstreamRef: 'v2026.8.19',
  })
  assert.equal(plan.should_build, 'true')
  assert.equal(plan.version, '0.20.5')
  assert.equal(plan.runtime_tag, 'hermes-0.20.5-runtime')
  // 补发旧版本不能抢占 Latest 标记。
  assert.equal(plan.mark_latest, 'false')
})

test('手动指定最新版本时保留 Latest 标记', async () => {
  const plan = await buildPlan({
    repository: 'example/runtime',
    fetchImpl: fakeGithub(new Map([
      ['/repos/NousResearch/hermes-agent/releases/tags/v2026.8.19', UPSTREAM_RELEASE],
      ...ANNOTATED_TAG_RESPONSES,
      ['/repos/example/runtime/releases?per_page=100&page=1', [runtime('0.20.4')]],
    ])),
    upstreamRef: 'v2026.8.19',
  })
  assert.equal(plan.mark_latest, 'true')
})

test('手动指定的版本已发布时报错而不是重复构建', async () => {
  await assert.rejects(
    buildPlan({
      repository: 'example/runtime',
      fetchImpl: fakeGithub(new Map([
        ['/repos/NousResearch/hermes-agent/releases/tags/v2026.8.19', UPSTREAM_RELEASE],
        ...ANNOTATED_TAG_RESPONSES,
        ['/repos/example/runtime/releases?per_page=100&page=1', [runtime('0.20.5')]],
      ])),
      upstreamRef: 'v2026.8.19',
    }),
    /已经发布/,
  )
})

test('手动指定不存在的上游 ref 时报错', async () => {
  await assert.rejects(
    buildPlan({
      repository: 'example/runtime',
      fetchImpl: fakeGithub(new Map()),
      upstreamRef: 'v1999.1.1',
    }),
    /没有 tag 为 v1999.1.1 的 Release/,
  )
})
