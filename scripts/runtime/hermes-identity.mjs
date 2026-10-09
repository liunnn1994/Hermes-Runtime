// 新版 Hermes 的运行版本来自 install stamp；旧版来自 Python 包元数据。
export function hermesIdentityPython(expectedCommit) {
  return [
    'import importlib.metadata as metadata',
    'from pathlib import Path',
    'import hermes_cli',
    'stamp = Path(hermes_cli.__file__).resolve().parent.parent / "install-stamp.json"',
    'if stamp.is_file():',
    '    from hermes_cli.version_info import get_version_info',
    '    identity = get_version_info()',
    `    assert identity.commit == ${JSON.stringify(expectedCommit)}, identity`,
    '    assert not identity.dirty, identity',
    '    print(identity.base_version)',
    'else:',
    '    print(metadata.version("hermes-agent"))',
  ].join('\n')
}
