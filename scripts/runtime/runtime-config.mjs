export function hermesSource(env = process.env) {
  const version = env.HERMES_VERSION?.trim()
  const repository = env.HERMES_SOURCE_REPOSITORY?.trim()
  const ref = env.HERMES_SOURCE_REF?.trim()
  const commit = env.HERMES_SOURCE_COMMIT?.trim().toLowerCase()

  const missing = [
    ['HERMES_VERSION', version],
    ['HERMES_SOURCE_REPOSITORY', repository],
    ['HERMES_SOURCE_REF', ref],
    ['HERMES_SOURCE_COMMIT', commit],
  ].filter(([, value]) => !value).map(([name]) => name)

  if (missing.length > 0) {
    throw new Error(`缺少 Runtime 源码配置：${missing.join('、')}`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('HERMES_VERSION 必须是完整的语义版本号')
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('HERMES_SOURCE_COMMIT 必须是 40 位完整 Git commit')
  }

  return { version, repository, ref, commit }
}
