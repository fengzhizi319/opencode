# 如何启动 `desktop-electron` 图形界面

这份说明记录如何启动仓库里的 Electron 图形界面：`packages/desktop-electron`。

## 先安装依赖

在仓库根目录执行：

```bash
cd /Users/charles/Documents/AI/opencode
bun install
```

仓库根目录的 `package.json` 指定了 Bun 版本：`bun@1.3.11`。

## 启动图形界面

推荐在仓库根目录直接运行：

```bash
bun --cwd packages/desktop-electron run dev
```

或者先切到包目录，再运行：

```bash
cd /Users/charles/Documents/AI/opencode/packages/desktop-electron
bun run dev
```

`dev` 脚本会启动 `electron-vite dev`，并在启动前执行 `predev`。

## `predev` 会做什么

`packages/desktop-electron/scripts/predev.ts` 会先：

1. 复制图标资源
2. 构建 `packages/opencode`
3. 把构建产物复制到 Electron 的 sidecar 目录

也就是说，启动 Electron GUI 前，它会先准备好主程序二进制。

## 其他常用命令

```bash
# 预览构建结果
bun --cwd packages/desktop-electron run preview

# 打包应用
bun --cwd packages/desktop-electron run build
bun --cwd packages/desktop-electron run package
```

## 注意事项

- 根目录的 `dev:desktop` 是给 `packages/desktop` 的 Tauri 应用用的，不是 `desktop-electron`。
- `packages/desktop-electron/README.md` 目前内容是旧的 Tauri 说明，别按它的命令启动 Electron。
- `predev` 会读取 `OPENCODE_CHANNEL` 和 `RUST_TARGET`，用于选择要复制的 sidecar 产物。

## 最短可执行步骤

```bash
cd /Users/charles/Documents/AI/opencode
bun install
bun --cwd packages/desktop-electron run dev
```

## 一句话总结

`desktop-electron` 的图形界面入口是 `packages/desktop-electron`，正常开发启动命令是：

```bash
bun --cwd packages/desktop-electron run dev
```

