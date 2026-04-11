# Ollama + Python 冒泡排序 新手步骤版

本文是面向新手的最小可运行调试指南，目标只有一个：

> 让你用本地 Ollama 的 `qwen3.5:0.8b`，跑通 OpenCode 的 Python 冒泡排序任务，并能看懂输出是否正确。

如果你已经熟悉 OpenCode 的源码调试，可以直接看同目录的 `debugging-ollama-bubble-sort-source-breakpoints.md`。

---

## 目录

- [第一步：准备 Ollama](#第一步准备-ollama)
- [第二步：配置 OpenCode](#第二步配置-opencode)
- [第三步：检查模型是否可用](#第三步检查模型是否可用)
- [第四步：用最小命令跑任务](#第四步用最小命令跑任务)
- [第五步：怎么看结果是否正确](#第五步怎么看结果是否正确)
- [第六步：常见问题](#第六步常见问题)
- [推荐阅读](#推荐阅读)

---

## 第一步：准备 Ollama

### 1. 启动 Ollama 服务

先确认 Ollama 在运行：

```bash
ollama serve
```

如果你已经安装了 Ollama 桌面程序，并且它已经在后台运行，这一步可以跳过。

### 2. 拉取模型

```bash
ollama pull qwen3.5:0.8b
```

### 3. 检查模型是否存在

```bash
ollama list
```

你应该能看到 `qwen3.5:0.8b`。

### 4. 检查本地 API

OpenCode 通过 OpenAI-compatible 接口访问 Ollama，先验证接口可用：

```bash
curl http://localhost:11434/v1/models
```

---

## 第二步：配置 OpenCode

在项目根目录创建或修改 `opencode.json`：

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

### 说明

- `provider.ollama`：本地 provider 的名字。
- `baseURL`：Ollama 的 OpenAI-compatible 地址。
- `qwen3.5:0.8b`：模型名。
- `model`：默认主模型。
- `small_model`：小任务也可以先用同一个模型。
- `default_agent`：默认从 `build` agent 开始更适合写代码。

---

## 第三步：检查模型是否可用

进入 `packages/opencode` 目录后执行：

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun run --conditions=browser ./src/index.ts debug config
bun run --conditions=browser ./src/index.ts models ollama --verbose
```

你要确认两件事：

1. `debug config` 里确实看到了 `ollama/qwen3.5:0.8b`
2. `models ollama --verbose` 能列出 `qwen3.5:0.8b`

如果这一步不对，先修配置，不要继续跑任务。

---

## 第四步：用最小命令跑任务

下面这条命令是最小可用命令：

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun --inspect run --conditions=browser ./src/index.ts --print-logs --log-level DEBUG run --model ollama/qwen3.5:0.8b --agent build -- "请帮我用 Python 语言实现一个冒泡排序算法，并验证结果正确性"
```

### 这个命令做了什么

- `--inspect`：方便你附加调试器。
- `--print-logs`：把日志直接输出。
- `--log-level DEBUG`：显示更多内部信息。
- `run`：真正执行任务。
- `--model ollama/qwen3.5:0.8b`：指定本地模型。
- `--agent build`：让系统直接进入代码执行模式。
- 最后的中文 prompt：任务内容。

### 如果你想先少一点输出

可以先去掉 `--inspect`，只保留日志：

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun run --conditions=browser ./src/index.ts --print-logs --log-level DEBUG run --model ollama/qwen3.5:0.8b --agent build -- "请帮我用 Python 语言实现一个冒泡排序算法，并验证结果正确性"
```

---

## 第五步：怎么看结果是否正确

当模型返回结果后，重点检查这几件事：

### 1. 是否真的生成了 Python 代码
应该看到类似：

```python
def bubble_sort(arr):
    ...
```

### 2. 是否说明了保存位置
最好能看到文件路径，比如：

```text
/home/user/myproject/bubble_sort.py
```

### 3. 是否验证了边界条件
最好检查这些测试：

- 空列表
- 单元素列表
- 已排序列表
- 逆序列表
- 含重复元素的列表

### 4. 是否给出自测结果
你可以直接要求模型再补一条：

```text
请检查空列表、单元素列表、已排序列表、逆序列表和含重复元素的列表，并说明验证结果。
```

---

## 第六步：常见问题

### 问题 1：提示找不到模型
先检查：

```bash
ollama list
```

再检查：

```bash
bun run --conditions=browser ./src/index.ts debug config
```

如果 `opencode.json` 里不是 `ollama/qwen3.5:0.8b`，就要改成正确配置。

### 问题 2：命令执行后没有输出
通常先看这几个点：

- Ollama 是否真的在跑
- `curl http://localhost:11434/v1/models` 是否成功
- `--log-level DEBUG` 是否真的加上了
- `--model ollama/qwen3.5:0.8b` 是否写对了

### 问题 3：模型生成了代码，但没有验证
你可以把 prompt 改成更明确的版本：

```text
请生成 Python 冒泡排序代码，并在答案里主动验证以下测试用例：
1. 空列表
2. 单元素列表
3. 已排序列表
4. 逆序列表
5. 含重复元素的列表
```

### 问题 4：你只想先看流程，不想真的连模型
可以运行示例脚本：

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun debug-execution.ts
```

或者：

```bash
node debug-execution-node.mjs
```

这些脚本会模拟完整执行流程，适合先理解“会发生什么”。

---

## 推荐阅读

- [debugging-ollama-bubble-sort.md](./debugging-ollama-bubble-sort.md)：完整调试说明
- `debugging-ollama-bubble-sort-source-breakpoints.md`：源码断点版
- [debugging-guide.md](./debugging-guide.md)：源码调试总指南

