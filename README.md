# Hermes Runtime 自动发布

本项目自动跟踪 Hermes Agent 的稳定版 Release，并为支持的平台生成可移植、解压即用的
Runtime 压缩包。构建、校验和发布逻辑均保存在本仓库中，不依赖外部项目的构建脚本。

## 发布规则

GitHub Actions 工作流无法直接订阅另一个仓库的 `release` 事件，因此
[`release-runtime.yml`](.github/workflows/release-runtime.yml) 每六小时轮询一次
Hermes Agent 官方 Release，同时支持手动触发。

- 如果本仓库尚无 `hermes-X.Y.Z-runtime` Release，工作流只构建上游最新稳定版，
  不补发历史版本。
- 完成首次发布后，每次运行只构建下一个尚未发布的上游新版本。若轮询期间遗漏多个版本，
  后续定时任务会按版本顺序依次发布。
- 忽略上游草稿和预发布版本。
- 构建矩阵启动前会把上游 tag 解析为完整 Git commit，确保所有平台使用同一份源码快照。
- 构建矩阵启动前会读取该 commit 的 Unix 和 Windows 安装脚本，用 mise 把 Node.js、
  Python 同步到 Hermes 声明版本线的最新正式补丁版，并重新生成五平台锁文件。
- `mise.toml` 或 `mise.lock` 发生变化时，工作流会提交到默认分支；本次构建随后检出
  该提交，保证发布资产与仓库中记录的工具版本完全一致。
- 所有平台的压缩包、清单文件和 SHA-256 文件齐全且校验通过前，Release 始终保持草稿状态。

## Runtime 内容

本仓库自己的构建脚本位于 [`scripts/runtime`](scripts/runtime)，负责：

- 由 [`mise.toml`](mise.toml) 固定并安装 Node.js 和 Python；
- 把 mise 已安装的 Node.js、Python 整理为可迁移 Runtime 布局；
- 在 Windows Runtime 中附带 MinGit；
- 按 Release tag 和完整 commit 检出 Hermes Agent 源码；
- 使用 `uv` 创建可迁移虚拟环境并安装 Hermes Agent 及其可选功能；
- 构建 Hermes TUI 和 Web 前端，并安装浏览器运行时；
- 清理缓存与构建依赖，执行迁移后启动检查；
- 生成压缩包、Runtime 清单、平台清单和 SHA-256 文件。

## 支持平台

- `win-x64`
- `mac-x64`
- `mac-arm64`
- `linux-x64`
- `linux-arm64`（不内置浏览器运行时）

当前不发布 32 位 Runtime。虽然部分基础组件提供 Windows x86 或 Linux armv7 版本，
但 Hermes Agent 的完整核心依赖没有覆盖这些目标的预编译包，GitHub 也没有对应的标准
32 位托管运行器，无法满足“原生构建、完整验证、解压即用”的发布要求。

## 压缩包结构

资产命名示例：

```text
hermes-runtime-hermes-agent-0.20.2-win-x64.tar.gz
hermes-runtime-hermes-agent-0.20.2-win-x64.tar.gz.sha256
hermes-runtime-win-x64.json
```

压缩包不包含额外的顶层目录，可直接解压到对应的版本/平台目录：

```powershell
$target = "$env:USERPROFILE\.sdata-ai-studio\desktop-runtime\hermes\0.20.2\win-x64"
New-Item -ItemType Directory -Force $target | Out-Null
tar -xzf hermes-runtime-hermes-agent-0.20.2-win-x64.tar.gz -C $target
```

解压后的根目录结构如下：

```text
win-x64/
├── git/
├── node/
├── python/
└── runtime-manifest.json
```

Windows 的可移植 Hermes 启动器位于 `python/venv/Scripts/hermes.cmd`；macOS 和
Linux 的启动器位于 `python/venv/bin/hermes`。

## 本地检查

Release 规划器和 Runtime 构建脚本不依赖第三方 Node 包。完整构建需要先由 mise
安装项目固定的工具版本；CI 中的 uv 由 Astral 官方 Action 提供：

```bash
mise install
npm run check
```

完整 Runtime 会在各平台原生 GitHub 托管运行器上构建。
