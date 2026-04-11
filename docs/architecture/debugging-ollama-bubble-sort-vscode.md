# Ollama + Python 冒泡排序 VS Code 断点版

本文是专门面向 **VS Code** 的断点调试版本，目标是让你在编辑器里直接看到 OpenCode 运行时的关键状态，并且能够在源码中命中断点。

如果你是第一次跑通流程，建议先看：

- [debugging-ollama-bubble-sort-beginner.md](./debugging-ollama-bubble-sort-beginner.md)

如果你想先理解源码调用链，可以再看：

- [debugging-ollama-bubble-sort-source-breakpoints.md](./debugging-ollama-bubble-sort-source-breakpoints.md)

---

## 目录

- [适合谁看](#适合谁看)
- [调试前准备](#调试前准备)
- [VS Code 启动配置](#vs-code-启动配置)
- [推荐断点位置](#推荐断点位置)
- [最小调试命令](#最小调试命令)
- [如何逐步看变量](#如何逐步看变量)
- [常见问题](#常见问题)
- [推荐阅读](#推荐阅读)

---

## 适合谁看

这份文档适合下面两类人：

1. 已经能跑 OpenCode，但想在 **VS Code 里单步调试**。
2. 想看 `SessionPrompt.prompt()`、`loop()`、`SessionProcessor.handleEvent()`、`tool/write.ts` 是如何串起来的。

它更关注：

- `launch.json`
- 断点
- 变量观察
- `inspect` 调试
- 源码跳转

而不是 Ollama 安装细节。

---

## 调试前准备

### 1. 准备 Ollama

如果还没准备好模型，请先看新手版：

- `debugging-ollama-bubble-sort-beginner.md`

最少要确认：

- `ollama serve` 已运行
- `ollama pull qwen3.5:0.8b` 已完成
- `ollama list` 能看到模型

### 2. 准备 OpenCode 配置

确认 `opencode.json` 里至少有：

- `provider.ollama`
- `model: "ollama/qwen3.5:0.8b"`
- `default_agent: "build"`

### 3. 确保 VS Code 已安装调试支持

你至少需要：

- VS Code
- 能调试 Bun / Node.js 进程的扩展或内置调试能力

---

## VS Code 启动配置

下面给出一个建议的 `.vscode/launch.json` 示例。

### 1. 推荐配置：直接启动 OpenCode

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "OpenCode: run with Ollama",
      "type": "bun",
      "request": "launch",
      "program": "${workspaceFolder}/packages/opencode/src/index.ts",
      "cwd": "${workspaceFolder}/packages/opencode",
      "args": [
        "--print-logs",
        "--log-level",
        "DEBUG",
        "run",
        "--model",
        "ollama/qwen3.5:0.8b",
        "--agent",
        "build",
        "--",
        "请帮我用 Python 语言实现一个冒泡排序算法，并验证结果正确性"
      ]
    }
  ]
}
```

### 2. 如果你更想手动 attach

先在终端启动：

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun --inspect=9229 run --conditions=browser ./src/index.ts --print-logs --log-level DEBUG run --model ollama/qwen3.5:0.8b --agent build -- "请帮我用 Python 语言实现一个冒泡排序算法，并验证结果正确性"
```

然后在 VS Code 里使用 Attach 到 9229 的调试配置。

---

## 推荐断点位置

建议先在下面这些位置打断点：

| 文件 | 函数 / 位置 | 目的 |
|---|---|---|
| `packages/opencode/src/index.ts` | CLI 参数解析处 | 确认 `--print-logs`、`--log-level`、`run`、`--model` 是否正确进入 |
| `packages/opencode/src/session/prompt.ts` | `prompt()` | 看用户消息如何创建 |
| `packages/opencode/src/session/prompt.ts` | `loop()` | 看主循环如何进入 |
| `packages/opencode/src/session/prompt.ts` | `resolveTools()` | 看工具为什么会出现 |
| `packages/opencode/src/session/llm.ts` | `stream()` | 看最终发给模型的请求 |
| `packages/opencode/src/session/processor.ts` | `handleEvent()` | 看流式事件如何被落盘 |
| `packages/opencode/src/tool/write.ts` | `execute()` | 看文件写入是否发生 |
| `packages/opencode/src/tool/edit.ts` | `execute()` | 看文本替换是否正确 |
| `packages/opencode/src/permission/index.ts` | `ask()` / `evaluate()` | 看工具权限是否放行 |

---

## 最小调试命令

如果你不想先写 `launch.json`，可以直接用终端跑：

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun --inspect run --conditions=browser ./src/index.ts --print-logs --log-level DEBUG run --model ollama/qwen3.5:0.8b --agent build -- "请帮我用 Python 语言实现一个冒泡排序算法，并验证结果正确性"
```

然后在 VS Code 里附加到运行中的进程。

---

## 如何逐步看变量

### 1. 在 `prompt()` 看什么

重点看：

- `input.agent`
- `input.model`
- `input.sessionID`
- `message.parts`
- `session.permission`

你要确认：

- 当前是否真的在用 `build`
- 是否已经把 Ollama 模型写对
- 用户输入是否转成了结构化 parts

### 2. 在 `loop()` 看什么

重点看：

- `lastUser`
- `lastAssistant`
- `tools`
- `system`
- `task`

你要确认：

- 工具集有没有正确构建
- 这轮是否应该进入 `write` / `edit` / `task`

### 3. 在 `handleEvent()` 看什么

重点看：

- `value.type`
- `ctx.currentText`
- `ctx.toolcalls`
- `ctx.needsCompaction`

你要确认：

- 文本是不是按流在回写
- 工具是否真的运行起来
- 是否触发了压缩

### 4. 在 `write()` 看什么

重点看：

- `params.filePath`
- `params.content`
- `ctx.ask()` 的结果

你要确认：

- 真正写入的是哪一个文件
- 写入前是否有权限确认

---

## 常见问题

### 问题 1：断点没有命中
通常检查：

- 你是不是用了 `--inspect`
- 你是不是在正确的 workspace 打开了源码
- `launch.json` 的 `cwd` 是否是 `packages/opencode`

### 问题 2：看不到源码映射
通常检查：

- 是否从 `packages/opencode` 目录运行
- 是否让 VS Code 打开了同一个工作区
- 是否在 Bun 调试会话上附加成功

### 问题 3：模型根本没走到 tool call
通常检查：

- `debug config` 是否真的配置了 `ollama/qwen3.5:0.8b`
- `models ollama --verbose` 是否显示了模型
- `--agent build` 是否传对了

### 问题 4：写文件不对
通常检查：

- `tool/write.ts` 的 `filePath`
- 权限是否被拒绝
- 工作区路径是否指向当前项目

---

## 推荐阅读

- [debugging-ollama-bubble-sort-beginner.md](./debugging-ollama-bubble-sort-beginner.md)
- [debugging-ollama-bubble-sort.md](./debugging-ollama-bubble-sort.md)
- [debugging-ollama-bubble-sort-source-breakpoints.md](./debugging-ollama-bubble-sort-source-breakpoints.md)

