#!/usr/bin/env node
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = [
  join(ROOT, 'scripts', 'release-plan.mjs'),
  join(ROOT, 'scripts', 'sync-runtime-tools.mjs'),
  ...readdirSync(join(ROOT, 'scripts', 'runtime'))
    .filter(name => name.endsWith('.mjs'))
    .map(name => join(ROOT, 'scripts', 'runtime', name)),
]

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log(`已检查 ${files.length} 个脚本的语法`)
