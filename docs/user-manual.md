# 用户手册 (User Manual)

## 简介

OpenCode 是你的智能AI协同开发助手。

## 快速上手

1. **安装环境**: 确保你已安装 `bun`。
2. **初始化**: 运行 `bun install` 安装依赖。
3. **启动 TUI 模式 (可交互调试)**:
   ```bash
   bun run dev
   ```
   这会自动代理到 `bun run --cwd packages/opencode --conditions=browser src/index.ts`。

4. **单次命令执行**:
   如果你想直接提问，可以通过如下命令：
   ```bash
   bun run --cwd packages/opencode --conditions=browser src/index.ts run -- "请帮我写一个Python的冒泡排序算法"
   ```

## 配置 LLM 模型和密钥

在 TUI 模式下输入指令：
```bash
/connect
```
根据提示输入你的提供商 ID（如 `openai`, `anthropic`）和你的 API 密钥。密钥将被加密生存在 `~/.local/share/opencode/auth.json` 中。
如果需要定制 LLM，可修改 `opencode.jsonc` 配置文件。详细配置方法可参考 `llm-provider-configuration.md`。
