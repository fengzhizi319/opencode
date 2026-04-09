# Ollama + Python 冒泡排序 WebStorm 调试版

本文是专门面向 **WebStorm** 的调试版本，重点说明如何用 JetBrains 系列 IDE 连接 OpenCode 的调试进程、设置断点、配置路径映射，并顺着源码查看 Ollama 任务的执行链路。

如果你更偏向先跑通流程，可以先看：

- [debugging-ollama-bubble-sort-beginner.md](./debugging-ollama-bubble-sort-beginner.md)

如果你更偏向源码定位，可以先看：

- [debugging-ollama-bubble-sort-source-breakpoints.md](./debugging-ollama-bubble-sort-source-breakpoints.md)

---

## 目录

- [适合谁看](#适合谁看)
- [调试前准备](#调试前准备)
- [WebStorm 调试方式](#webstorm-调试方式)
- [路径映射与断点](#路径映射与断点)
- [推荐断点位置](#推荐断点位置)
- [最小调试命令](#最小调试命令)
- [如何逐步追踪](#如何逐步追踪)
- [常见问题](#常见问题)
- [推荐阅读](#推荐阅读)

---

## 适合谁看

这份文档适合下面的人：

1. 常用 WebStorm / IntelliJ 系列 IDE。
2. 想用 IDE 的 Run/Debug 配置调试 OpenCode。
3. 想看 `session/prompt.ts`、`session/processor.ts`、`tool/write.ts` 的源码执行情况。

它更关注：

- Attach 调试
- Source maps
- Path mappings
- Breakpoints
- 变量观察

---

## 调试前准备

### 1. 准备 Ollama

先确保：

- `ollama serve` 已运行
- `ollama pull qwen3.5:0.8b` 已完成
- `ollama list` 能看到模型

如果还没配置好，请先看新手版。

### 2. 准备 OpenCode 配置

确认 `opencode.json` 里至少包含：

- `provider.ollama`
- `model: "ollama/qwen3.5:0.8b"`
- `default_agent: "build"`

### 3. 确认 WebStorm 能做 Node.js / Attach 调试

WebStorm 可以通过：

- Node.js Remote Debug / Attach
- 终端启动进程后附加调试器

来调试 Bun 运行的 OpenCode。

---

## WebStorm 调试方式

### 方式一：先启动，再 Attach

这是最稳妥的方式。

#### 第 1 步：终端里启动 OpenCode

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun --inspect=9229 run --conditions=browser ./src/index.ts --print-logs --log-level DEBUG run --model ollama/qwen3.5:0.8b --agent build -- "请帮我用 Python 语言实现一个冒泡排序算法，并验证结果正确性"
```

#### 第 2 步：在 WebStorm 创建 Attach 配置

创建一个 Node.js Attach / Remote Debug 配置，连接到：

- Host: `localhost`
- Port: `9229`

然后附加到运行中的 Bun 进程。

### 方式二：用 Run/Debug Configuration 启动

如果你的 WebStorm 版本和 Bun 支持足够好，也可以尝试直接用运行配置启动 `packages/opencode/src/index.ts`。

推荐使用下面的参数：

```text
--print-logs --log-level DEBUG run --model ollama/qwen3.5:0.8b --agent build -- 请帮我用 Python 语言实现一个冒泡排序算法，并验证结果正确性
```

但如果你遇到 source map 或路径映射问题，优先回到“方式一”。

---

## 路径映射与断点

WebStorm 调试时，最关键的是让 IDE 把运行中的源码路径映射回本地文件。

### 1. 路径映射建议

如果你是从下面这个目录启动：

```bash
/Users/charles/Documents/AI/opencode/packages/opencode
```

那么 IDE 里最好让：

- 本地目录：`/Users/charles/Documents/AI/opencode/packages/opencode`
- 远程目录：同样映射为这个目录

这样断点才更容易命中。

### 2. 断点建议

建议优先打在这些地方：

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/tool/write.ts`
- `packages/opencode/src/tool/edit.ts`
- `packages/opencode/src/permission/index.ts`

### 3. Source maps

如果你发现断点跳到了编译后的位置，重点检查：

- 是否从 `packages/opencode` 目录运行
- 是否启用了 `--inspect`
- WebStorm 是否附加到了正确的进程
- 你的路径映射是否正确

---

## 推荐断点位置

| 文件 | 函数 / 位置 | 目的 |
|---|---|---|
| `packages/opencode/src/index.ts` | CLI 入口 | 看命令参数是否进来 |
| `packages/opencode/src/session/prompt.ts` | `prompt()` | 看 user message 如何创建 |
| `packages/opencode/src/session/prompt.ts` | `loop()` | 看主循环如何进入 |
| `packages/opencode/src/session/prompt.ts` | `resolveTools()` | 看工具是怎么被装配的 |
| `packages/opencode/src/session/llm.ts` | `stream()` | 看最终送给模型的请求 |
| `packages/opencode/src/session/processor.ts` | `handleEvent()` | 看流事件如何变成 part |
| `packages/opencode/src/tool/write.ts` | `execute()` | 看文件写入路径和参数 |
| `packages/opencode/src/tool/edit.ts` | `execute()` | 看字符串替换是否成功 |
| `packages/opencode/src/permission/index.ts` | `ask()` / `evaluate()` | 看权限是否放行 |
| `packages/opencode/src/provider/provider.ts` | `getModel()` | 看 `ollama/qwen3.5:0.8b` 是否正确解析 |

---

## 最小调试命令

建议先用终端启动，再在 WebStorm 里附加：

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun --inspect=9229 run --conditions=browser ./src/index.ts --print-logs --log-level DEBUG run --model ollama/qwen3.5:0.8b --agent build -- "请帮我用 Python 语言实现一个冒泡排序算法，并验证结果正确性"
```

如果你只是想快速看一遍流程，也可以直接运行示例脚本：

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun debug-execution.ts
```

---

## 如何逐步追踪

### 1. 先看 `src/index.ts`

确认命令行是否包含：

- `--print-logs`
- `--log-level DEBUG`
- `run`
- `--model ollama/qwen3.5:0.8b`
- `--agent build`

### 2. 再看 `prompt()`

重点看：

- `input.sessionID`
- `input.agent`
- `input.model`
- `message.parts`

### 3. 再看 `loop()`

重点看：

- `lastUser`
- `tools`
- `system`
- `insertReminders()` 是否触发

### 4. 再看 `LLM.stream()`

重点看：

- provider 是否是 Ollama
- model 是否是 `qwen3.5:0.8b`
- messages 是否包含用户任务

### 5. 再看 `handleEvent()`

重点看：

- `text-delta`
- `tool-call`
- `tool-result`
- `finish-step`

### 6. 最后看 `write()` / `edit()`

重点确认：

- 是否真的写到了工作区
- 是否被权限拦截
- 路径是否是你想要的文件

---

## 常见问题

### 问题 1：WebStorm 断点不命中
通常检查：

- 是否先用 `--inspect=9229` 启动
- 是否 Attach 到正确端口
- 是否配置了正确路径映射

### 问题 2：看到的不是本地源码
通常检查：

- 本地目录是否映射到 `/Users/charles/Documents/AI/opencode/packages/opencode`
- 断点是否落在实际运行的源码文件上

### 问题 3：工具没有执行
通常检查：

- `resolveTools()` 里工具是否被过滤
- `Permission.ask()` 是否拒绝
- `debug config` 是否正确配置 `ollama/qwen3.5:0.8b`

### 问题 4：模型不对
通常检查：

- `opencode.json` 中 `model` 是否写成 `ollama/qwen3.5:0.8b`
- `models ollama --verbose` 是否能看到模型

---

## 推荐阅读

- [debugging-ollama-bubble-sort-beginner.md](./debugging-ollama-bubble-sort-beginner.md)
- [debugging-ollama-bubble-sort.md](./debugging-ollama-bubble-sort.md)
- [debugging-ollama-bubble-sort-source-breakpoints.md](./debugging-ollama-bubble-sort-source-breakpoints.md)

