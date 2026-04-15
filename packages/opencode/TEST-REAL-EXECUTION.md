# 真实执行测试指南

## 概述

`test-real-execution.ts` 是一个真实的端到端测试脚本，它会：
1. 使用本地 Ollama 服务
2. 调用 Qwen2.5 模型（0.5B 或 1.5B 参数版本）
3. 创建完整的会话流程
4. 生成冒泡排序 Python 代码并保存到文件

## 前置条件

### 1. 安装 Ollama

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh
```

### 2. 启动 Ollama 服务

```bash
ollama serve
```

保持此终端窗口运行。

### 3. 拉取 Qwen 模型

```bash
# 推荐：Qwen2.5 0.5B（轻量级，速度快）
ollama pull qwen2.5:0.5b

# 备选：Qwen2.5 1.5B（能力更强，但更慢）
ollama pull qwen2.5:1.5b
```

验证模型已下载：
```bash
ollama list
```

应该看到类似输出：
```
NAME              ID           SIZE    MODIFIED
qwen2.5:0.5b      xxxxxxxx     397MB   2 minutes ago
```

## 运行测试

### 基本用法

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun test-real-execution.ts
```

### 预期输出

测试会经历以下阶段：

1. **准备工作目录** - 创建临时文件夹
2. **配置 Ollama Provider** - 检查 Ollama 连接和可用模型
3. **创建会话** - 初始化新的对话会话
4. **构建用户消息** - 解析用户提示词
5. **选择 LLM 模型** - 确认使用的模型
6. **发送提示到 LLM** - 实际调用模型并等待响应
7. **验证执行结果** - 检查生成的文件和内容
8. **清理资源** - 显示临时目录位置

### 成功标志

✅ 看到 "测试执行完成" 横幅  
✅ 显示生成的 Python 代码  
✅ 文件 `bubble_sort.py` 在临时目录中创建  

## 故障排查

### 问题 1: Ollama 未运行

**错误信息**: `fetch failed` 或 `ECONNREFUSED`

**解决方案**:
```bash
ollama serve
```

### 问题 2: 模型不存在

**错误信息**: `Model not found: ollama/qwen2.5:0.5b`

**解决方案**:
```bash
ollama pull qwen2.5:0.5b
```

或者修改脚本使用其他可用模型。

### 问题 3: 权限错误

**错误信息**: `Permission denied`

**解决方案**:
```bash
chmod +x test-real-execution.ts
```

### 问题 4: 依赖缺失

**错误信息**: `Module not found`

**解决方案**:
```bash
cd /Users/charles/Documents/AI/opencode
bun install
```

## 自定义测试

### 修改提示词

编辑 `test-real-execution.ts` 第 117 行：

```typescript
const userPrompt = "你的自定义提示词"
```

### 更换模型

编辑第 135-150 行，更改模型名称：

```typescript
modelInfo = await Provider.getModel("ollama", "llama3.2:1b")
```

### 调整超时时间

如果模型响应很慢，可以在环境变量中设置：

```bash
export OLLAMA_TIMEOUT=300  # 300秒超时
bun test-real-execution.ts
```

## 查看生成的文件

测试完成后，临时目录路径会显示在输出中。例如：

```
[DEBUG] 保留临时目录供检查 /var/folders/xx/opencode-test-abc123
```

你可以：

```bash
# 查看文件
ls -la /var/folders/xx/opencode-test-abc123

# 运行生成的代码
python /var/folders/xx/opencode-test-abc123/bubble_sort.py

# 清理
rm -rf /var/folders/xx/opencode-test-abc123
```

## 性能参考

| 模型 | 平均响应时间 | Token 消耗 | 文件大小 |
|------|------------|-----------|---------|
| qwen2.5:0.5b | 5-15 秒 | ~200-400 | ~150 行 |
| qwen2.5:1.5b | 10-30 秒 | ~300-600 | ~200 行 |

*注：实际性能取决于硬件配置*

## 与其他测试对比

| 特性 | debug-execution.ts | test-real-execution.ts |
|------|-------------------|----------------------|
| LLM 调用 | ❌ 模拟 | ✅ 真实调用 |
| 文件生成 | ❌ 模拟 | ✅ 真实写入 |
| 需要 Ollama | ❌ 否 | ✅ 是 |
| 执行速度 | ⚡ 快 (<1s) | 🐢 慢 (5-30s) |
| 用途 | 理解流程 | 验证功能 |

## 高级用法

### 批量测试多个模型

创建脚本 `batch-test.sh`:

```bash
#!/bin/bash

models=("qwen2.5:0.5b" "qwen2.5:1.5b" "llama3.2:1b")

for model in "${models[@]}"; do
  echo "Testing with $model..."
  MODEL=$model bun test-real-execution.ts
  echo "---"
done
```

### 集成到 CI/CD

在 GitHub Actions 中使用：

```yaml
- name: Setup Ollama
  run: |
    curl -fsSL https://ollama.com/install.sh | sh
    ollama serve &
    ollama pull qwen2.5:0.5b

- name: Run Real Execution Test
  run: bun test-real-execution.ts
```

## 相关文档

- [OpenCode 开发指南](../../docs/development-guide.md)
- [Provider 配置](../../docs/llm-provider-configuration.md)
- [Session 模块文档](../../docs/session-module.md)

## 贡献

如果你改进了这个测试脚本，请：

1. 更新本 README
2. 添加新的测试用例
3. 提交 PR 到 `dev` 分支
