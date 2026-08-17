#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const steps = [
  'stage-mise-tools.mjs',
  'fetch-git.mjs',
  'fetch-hermes.mjs',
  'install-hermes.mjs',
  'prune-python.mjs',
]

for (const step of steps) {
  console.log(`\n==> 执行 ${step}`)
  const result = spawnSync(process.execPath, [join(SCRIPT_DIR, step)], {
    env: process.env,
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
