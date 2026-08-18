import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hermesSource } from '../scripts/runtime/runtime-config.mjs'
import {
  parsePosixInstaller,
  parseWindowsInstaller,
  selectHermesToolChannels,
  updateMiseConfig,
} from '../scripts/sync-runtime-tools.mjs'
import {
  configWithPythonHome,
  makeBundledBaseConfigPortable,
  windowsBatchCommandArgs,
  windowsModuleLauncher,
  windowsVenvRebaseScript,
} from '../scripts/runtime/python-runtime-layout.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const validSource = {
  HERMES_VERSION: '0.20.2',
  HERMES_SOURCE_REPOSITORY: 'https://github.com/NousResearch/hermes-agent.git',
  HERMES_SOURCE_REF: 'v2026.8.16',
  HERMES_SOURCE_COMMIT: 'df4b65147d7ddd74dd449f9067aabbca5aef0ec7',
}

test('Hermes 源码配置必须完整提供', () => {
  assert.throws(() => hermesSource({}), /缺少 Runtime 源码配置/)
  assert.deepEqual(hermesSource(validSource), {
    version: validSource.HERMES_VERSION,
    repository: validSource.HERMES_SOURCE_REPOSITORY,
    ref: validSource.HERMES_SOURCE_REF,
    commit: validSource.HERMES_SOURCE_COMMIT,
  })
})

test('Hermes commit 必须是完整的 40 位哈希', () => {
  assert.throws(
    () => hermesSource({ ...validSource, HERMES_SOURCE_COMMIT: 'df4b651' }),
    /40 位完整 Git commit/,
  )
})

test('mise 固定 Runtime 工具版本并使用预编译 Python', () => {
  const config = readFileSync(resolve(ROOT, 'mise.toml'), 'utf-8')
  const lock = readFileSync(resolve(ROOT, 'mise.lock'), 'utf-8')
  const nodeVersion = config.match(/^node = "(\d+\.\d+\.\d+)"$/m)?.[1]
  const pythonVersion = config.match(
    /^python = \{ version = "(\d+\.\d+\.\d+)", patch_sysconfig = false \}$/m,
  )?.[1]
  assert.ok(nodeVersion)
  assert.ok(pythonVersion)
  assert.match(config, /^python\.compile = false$/m)
  assert.match(lock, new RegExp(`\\[\\[tools\\.node\\]\\]\\r?\\nversion = "${nodeVersion.replaceAll('.', '\\.')}"`))
  assert.match(lock, new RegExp(`\\[\\[tools\\.python\\]\\]\\r?\\nversion = "${pythonVersion.replaceAll('.', '\\.')}"`))
  for (const platform of ['windows-x64', 'macos-x64', 'macos-arm64', 'linux-x64', 'linux-arm64']) {
    assert.match(lock, new RegExp(`tools\\.node\\."platforms\\.${platform}"`))
    assert.match(lock, new RegExp(`tools\\.python\\."platforms\\.${platform}"`))
  }
  assert.equal(existsSync(resolve(ROOT, 'scripts/runtime/fetch-node.mjs')), false)
  assert.equal(existsSync(resolve(ROOT, 'scripts/runtime/fetch-python.mjs')), false)
})

test('Runtime 工具版本从 Hermes 两个平台安装脚本同步', () => {
  const posix = parsePosixInstaller('PYTHON_VERSION="3.11"\nNODE_VERSION="26"\n')
  const windows = parseWindowsInstaller('$PythonVersion = "3.11"\n$NodeVersion = "22"\n')
  assert.deepEqual(selectHermesToolChannels(posix, windows), { python: '3.11', node: '26' })
  assert.throws(
    () => selectHermesToolChannels(posix, { python: '3.12', node: '26' }),
    /Python 版本声明不一致/,
  )

  const updated = updateMiseConfig(
    '[tools]\nnode = "22.0.0"\npython = { version = "3.12.0", patch_sysconfig = false }\n',
    { node: '26.7.0', python: '3.11.16' },
  )
  assert.match(updated, /^node = "26\.7\.0"$/m)
  assert.match(updated, /^python = \{ version = "3\.11\.16", patch_sysconfig = false \}$/m)
})

test('Python 虚拟环境配置可以在绝对路径和可移植路径之间切换', () => {
  assert.match(configWithPythonHome('include-system-site-packages = false\n', 'C:\\runtime\\base'), /^home = C:\\runtime\\base/m)
  assert.match(makeBundledBaseConfigPortable('home = C:\\build\\base\n', 'win32'), /^home = \.\.\/base$/m)
})

test('Windows 启动器会在启动 Hermes 前重定位虚拟环境', () => {
  const rebase = windowsVenvRebaseScript()
  const launcher = windowsModuleLauncher('hermes_cli.main')
  assert.match(rebase, /pyvenv\.cfg/)
  assert.match(rebase, /parents\[2\] \/ "base"/)
  assert.match(launcher, /base\\python\.exe.*rebase-venv\.py/)
  assert.match(launcher, /"%PY%" -m hermes_cli\.main/)
  assert.deepEqual(
    windowsBatchCommandArgs('C:\\Runtime Dir\\hermes.cmd', ['--version']),
    ['/d', '/c', 'C:\\Runtime Dir\\hermes.cmd', '--version'],
  )
})

test('发布工作流只使用本仓库的 Runtime 构建脚本', () => {
  const workflow = readFileSync(resolve(ROOT, '.github/workflows/release-runtime.yml'), 'utf-8')
  const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf-8')
  assert.match(workflow, /run: npm run prepare:runtime/)
  assert.match(workflow, /run: npm run package:runtime/)
  assert.match(workflow, /uses: jdx\/mise-action@v4/)
  assert.match(workflow, /run: node scripts\/sync-runtime-tools\.mjs/)
  assert.match(workflow, /git push origin "HEAD:\$DEFAULT_BRANCH"/)
  assert.match(workflow, /ref: \$\{\{ needs\.sync_tools\.outputs\.runtime_commit \}\}/)
  assert.doesNotMatch(workflow, /actions\/setup-node/)
  assert.match(
    workflow,
    /uses: astral-sh\/setup-uv@v10\.0\.1\s+with:[\s\S]*?cache-dependency-glob: mise\.lock\s+cache-suffix: hermes-\$\{\{ needs\.plan\.outputs\.source_commit \}\}/,
  )
  assert.doesNotMatch(workflow, /^\s+repository:/m)
  assert.doesNotMatch(workflow, /\.builder\//i)
  assert.doesNotMatch(readme, /截至\s+\d{4}-\d{2}-\d{2}/)
})

test('Hermes 检出忽略跨平台不兼容的贡献者文件名', () => {
  const fetchScript = readFileSync(resolve(ROOT, 'scripts/runtime/fetch-hermes.mjs'), 'utf-8')
  const sparseInit = "run('git', ['sparse-checkout', 'init', '--no-cone'])"
  const sparseSet = "run('git', ['sparse-checkout', 'set', '/*', '!/contributors/'])"
  const checkout = "run('git', ['checkout', '-B', 'main', fetchedCommit])"

  assert.match(fetchScript, /contributors\/.*Windows.*macOS/s)
  assert.ok(fetchScript.indexOf(sparseInit) < fetchScript.indexOf(sparseSet))
  assert.ok(fetchScript.indexOf(sparseSet) < fetchScript.indexOf(checkout))
})
