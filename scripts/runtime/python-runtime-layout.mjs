import { dirname, join } from 'node:path'

export function venvPythonPath(venvDir, targetOs) {
  return targetOs === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python3')
}

export function bundledBasePythonPath(pythonRoot, targetOs) {
  return targetOs === 'win32'
    ? join(pythonRoot, 'base', 'python.exe')
    : join(pythonRoot, 'base', 'bin', 'python3')
}

export function bundledBaseHomePath(pythonRoot, targetOs) {
  return dirname(bundledBasePythonPath(pythonRoot, targetOs))
}

export function configWithPythonHome(config, home) {
  const normalizedHome = String(home)
  const lines = String(config).split(/\r?\n/)
  const homeIndex = lines.findIndex(line => /^\s*home\s*=/.test(line))
  if (homeIndex >= 0) {
    lines[homeIndex] = `home = ${normalizedHome}`
  } else {
    lines.unshift(`home = ${normalizedHome}`)
  }
  return lines.join('\n').replace(/\n*$/, '\n')
}

export function makeBundledBaseConfigPortable(config, targetOs) {
  const home = targetOs === 'win32' ? '../base' : '../base/bin'
  return configWithPythonHome(config, home)
}

export function windowsVenvRebaseScript() {
  return [
    'from pathlib import Path',
    'script = Path(__file__).resolve()',
    'config = script.parents[1] / "pyvenv.cfg"',
    'base = script.parents[2] / "base"',
    'lines = config.read_text(encoding="utf-8").splitlines()',
    'replacement = f"home = {base}"',
    'updated = [replacement if line.strip().startswith("home =") else line for line in lines]',
    'if not any(line.strip().startswith("home =") for line in lines):',
    '    updated.insert(0, replacement)',
    'config.write_text("\\n".join(updated) + "\\n", encoding="utf-8")',
    '',
  ].join('\n')
}

export function windowsModuleLauncher(moduleName) {
  return [
    '@echo off',
    '"%~dp0..\\..\\base\\python.exe" "%~dp0rebase-venv.py" || exit /b 1',
    'set "PY=%~dp0python.exe"',
    'set "VIRTUAL_ENV=%~dp0.."',
    'set "UV_PROJECT_ENVIRONMENT=%VIRTUAL_ENV%"',
    'set "UV_PYTHON=%PY%"',
    `"%PY%" -m ${moduleName} %*`,
  ].join('\r\n')
}
