# API 文档 (API Documentation)

## 概述

OpenCode 提供了一套核心的 API 封装和工具组（Tools），用于代理模型执行。

## 核心接口

### 1. FileSystem Tools
- `read_file(filePath, startLine, endLine)`: 读取本地文件指定行数。
- `replace_string_in_file(filePath, oldString, newString)`: 对本地文件做字符串精确替换。
- `insert_edit_into_file(filePath, code)`: 修改目标文件的内容。
- `create_file(filePath, content)`: 创建新文件。

### 2. Search Tools
- `file_search(query)`: 按 glob 匹配查找文件路径。
- `grep_search(query)`: 查找项目内包含某些字符串或正则的文件段落。
- `semantic_search(query)`: 按照语义进行代码片段搜索。

### 3. Execution Tools
- `run_in_terminal(command, ...)`: 开辟终端运行任务。

### SDK 使用

如果您要集成到 Node.js 或 Bun 中，可从 `@opencode/sdk` 导出模块：
```ts
import { ToolContext } from '@opencode/sdk';
//...
```
