import test from 'node:test'
import assert from 'node:assert/strict'
import {
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
