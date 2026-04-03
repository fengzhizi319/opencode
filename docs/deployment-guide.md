# 部署指南 (Deployment Guide)

## 硬件和系统要求
- 操作系统: macOS, Linux, Windows (WSL推荐)
- 环境安装: 需要 `bun` (推荐使用官方安装脚本 `curl -fsSL https://bun.sh/install | bash`)

## 本地编译部署

1. **拉取代码**
   ```bash
   git clone https://github.com/opencode/opencode.git
   cd opencode
   ```

2. **安装依赖项**
   由于我们使用 Bun 进行包管理和运行：
   ```bash
   bun install
   ```

3. **打包构建**
   如果需要构建出二进制文件和应用：
   ```bash
   # 查看 script 的工具集
   bun run script/build.ts
   ```

## 构建桌面应用 (Desktop App)

我们使用了 Electron 和 Tauri 提供跨平台的支持：
- 进入 `packages/desktop-electron`
- 执行 `bun install`
- 执行打包命令如 `bun run build`

## Docker 环境
若需容器化构建，可查阅 `containers/` 目录里的相关文档和 `Dockerfile` 构建无界面代理镜像。
