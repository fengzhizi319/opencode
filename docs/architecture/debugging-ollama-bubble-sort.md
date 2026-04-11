# Ollama + Python 冒泡排序 调试指南

本文是面向**本地 Ollama 模型**的调试说明，目标场景是：

> 用代码或 CLI 调试“请帮我用 Python 语言实现一个冒泡排序算法，并验证结果正确性”，并让 LLM 使用本地 Ollama 的 `qwen3.5:0.8b`。

它同时说明两种入口：

1. **真实调试入口**：OpenCode 的 CLI / TUI 运行入口 `packages/opencode/src/index.ts`。
2. **示例调试文件入口**：`packages/opencode/debug-execution.ts` 和 `packages/opencode/debug-execution-node.mjs`，用于演示一条完整的调试链路。

如果你是第一次跑通，先看 [debugging-ollama-bubble-sort-beginner.md](./debugging-ollama-bubble-sort-beginner.md)。
如果你想顺着源码断点追踪，再看 [debugging-ollama-bubble-sort-source-breakpoints.md](./debugging-ollama-bubble-sort-source-breakpoints.md)。

---

## 1. 你要用哪个入口

### 1.1 真实调试入口
如果你要让 OpenCode 真正运行任务，请使用 CLI 入口：

- `packages/opencode/src/index.ts`
- `debug` 子命令：用于查看配置、路径、Agent、文件、LSP 等调试信息
- `run` 子命令：用于实际发送任务给 LLM

### 1.2 示例调试文件入口
如果你想先看“调试过程长什么样”，可以直接运行仓库里已有的示例脚本：

- `packages/opencode/debug-execution.ts`
- `packages/opencode/debug-execution-node.mjs`

这两个脚本会模拟“生成 Python 冒泡排序算法”的完整过程，并在各阶段打印调试信息。它们更像**教学/演示脚本**，不是 OpenCode 的正式运行入口。

---

## 2. 本地 Ollama 模型准备

### 2.1 启动 Ollama
确认本机已经安装并启动 Ollama：

```bash
ollama serve
```

如果你已经有后台服务，可以跳过这一步。

### 2.2 拉取模型
把模型下载到本地：

```bash
ollama pull qwen3.5:0.8b
```

### 2.3 检查模型是否可用

```bash
ollama list
```

你应该能看到 `qwen3.5:0.8b`。

### 2.4 检查 OpenAI 兼容接口
OpenCode 使用的是 OpenAI-compatible 方式访问 Ollama，你可以先确认本地接口可用：

```bash
curl http://localhost:11434/v1/models
```

---

## 3. OpenCode 中的 Ollama 配置

OpenCode 的配置文件可以放在：

- 项目根目录 `opencode.json`
- 或全局配置文件

下面是一个适合本地 Ollama 的示例配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "name": "Ollama Local",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:11434/v1",
        "apiKey": "ollama"
      },
      "models": {
        "qwen3.5:0.8b": {
          "name": "Qwen 3.5 0.8B",
          "tool_call": true,
          "limit": {
            "context": 8192,
            "output": 2048
          }
        }
      }
    }
  },
  "model": "ollama/qwen3.5:0.8b",
  "small_model": "ollama/qwen3.5:0.8b",
  "default_agent": "build"
}
```

### 3.1 字段说明

- `provider.ollama`：provider ID，后续会体现在 `ollama/qwen3.5:0.8b` 这种模型字符串里。
- `npm`: 使用 `@ai-sdk/openai-compatible`，因为 Ollama 暴露的是 OpenAI-compatible 接口。
- `options.baseURL`: Ollama 的 OpenAI 兼容地址。
- `models.qwen3.5:0.8b`: 模型 ID，和 `opencode models ollama` 输出中的名字一致。
- `model`: 默认主模型。
- `small_model`: 轻量任务用的小模型；只有一个模型时，也可以先写成同一个。
- `default_agent`: 默认使用 `build` 更适合直接做代码任务。

### 3.2 关键点

你在命令行里传的模型名，建议使用完整格式：

```text
ollama/qwen3.5:0.8b
```

这和 `providerID/modelID` 的结构一致。

---

## 4. 调试模式怎么开

### 4.1 先看当前解析后的配置
进入 `packages/opencode` 目录后执行：

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun run --conditions=browser ./src/index.ts debug config
```

如果你想看全局路径：

```bash
bun run --conditions=browser ./src/index.ts debug paths
```

如果你想确认模型注册是否成功：

```bash
bun run --conditions=browser ./src/index.ts models ollama --verbose
```

### 4.2 打开详细日志
OpenCode 当前通过 CLI 全局参数控制日志，而不是通过 `OPENCODE_LOG_LEVEL` 环境变量。

推荐这样启动：

```bash
bun --inspect run --conditions=browser ./src/index.ts --print-logs --log-level DEBUG run --model ollama/qwen3.5:0.8b --agent build -- "请帮我用 Python 语言实现一个冒泡排序算法，并验证结果正确性"
```

### 4.3 参数含义

- `--inspect`：允许你在 Bun / Chrome / VS Code 中附加调试器。
- `--print-logs`：把日志直接输出到 stderr。
- `--log-level DEBUG`：打开更详细的日志。
- `run`：进入实际任务执行。
- `--model ollama/qwen3.5:0.8b`：明确使用本地 Ollama 模型。
- `--agent build`：直接进入执行型 Agent。
- 最后的中文 prompt：你真正想调试的任务。

---

## 5. 推荐的调试流程

### Step 1：先验证配置
先确认配置和模型都能被正确解析：

```bash
bun run --conditions=browser ./src/index.ts debug config
bun run --conditions=browser ./src/index.ts models ollama --verbose
```

如果这里看不到 `ollama/qwen3.5:0.8b`，先修配置，不要急着跑任务。

### Step 2：跑最小任务
先使用一个短 prompt，减少噪音：

```bash
bun --inspect run --conditions=browser ./src/index.ts --print-logs --log-level DEBUG run --model ollama/qwen3.5:0.8b --agent build -- "请用 Python 实现一个冒泡排序算法。"
```

### Step 3：要求模型验证正确性
等它生成代码后，再追加明确的验证要求：

```text
请检查以下边界条件：
1. 空列表
2. 单元素列表
3. 已排序列表
4. 逆序列表
5. 含重复元素的列表

请给出你验证后的结果，并说明代码文件路径。
```

### Step 4：如果要看执行细节，用示例调试脚本
如果你想先理解整个执行链路，而不是真的连 LLM，可以运行：

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun debug-execution.ts
```

或者：

```bash
node debug-execution-node.mjs
```

这两个脚本会输出：

- 项目初始化
- 会话创建
- Agent 选择
- Skill 加载
- 工具初始化
- System Prompt 组装
- 用户消息创建
- LLM 事件流
- 写文件 / 校验 / 摘要

---

## 6. 如何用调试模式排查问题

### 6.1 如果模型没有按预期调用工具
先看：

1. `debug config` 里模型是否正确
2. `models ollama --verbose` 是否显示模型
3. `--agent build` 是否生效
4. `--log-level DEBUG` 是否真的打开了日志

### 6.2 如果请求被拒绝或没有输出
重点检查：

- Ollama 是否在运行
- `http://localhost:11434/v1/models` 是否可访问
- `provider.ollama.options.baseURL` 是否正确
- `qwen3.5:0.8b` 是否真的存在

### 6.3 如果工具调用成功但结果不对
建议让模型明确输出验证步骤：

```text
请在生成冒泡排序代码后，继续输出一个最小测试计划，并逐个说明每个测试用例的预期结果。
```

---

## 7. 适合直接复制的冒泡排序调试命令

### 7.1 最常用命令

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun --inspect run --conditions=browser ./src/index.ts --print-logs --log-level DEBUG run --model ollama/qwen3.5:0.8b --agent build -- "请帮我用 Python 语言实现一个冒泡排序算法，并验证结果正确性"
```

### 7.2 只看配置

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun run --conditions=browser ./src/index.ts debug config
```

### 7.3 看模型列表

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun run --conditions=browser ./src/index.ts models ollama --verbose
```

### 7.4 看调试脚本

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun debug-execution.ts
```

---

## 8. 总结

如果你的目标是“调试 OpenCode 如何完成一个 Python 冒泡排序任务，并使用本地 Ollama `qwen3.5:0.8b`”，推荐按这个顺序来：

1. 配置 Ollama provider。
2. 用 `debug config` 和 `models ollama --verbose` 验证配置。
3. 用 `--print-logs --log-level DEBUG` 跑真实任务。
4. 用 `--inspect` 附加调试器。
5. 如果只想看执行链路，直接运行 `packages/opencode/debug-execution.ts`。

如果你想继续深入源码层的调试，可以再看：

- `docs/architecture/debugging-guide.md`
- `docs/architecture/live-execution.md`
- `docs/architecture/debugging-workflow.md`

