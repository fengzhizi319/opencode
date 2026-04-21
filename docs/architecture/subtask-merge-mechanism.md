# 子任务输出合并机制

## 概述

OpenCode 中的子任务(Task Tool)执行完成后,其结果通过**附件(attachments)**机制返回给父会话。本文档详细说明子任务输出的处理方式、合并机制以及文件变更的集成流程。

## 核心概念

### 1. 子任务不是补丁(Patch),而是独立会话

子任务在执行时会:
- 创建一个**独立的子会话**(child session),具有唯一的 `sessionID`
- 在子会话中运行完整的 agent-tool-llm 循环
- 子会话可以执行任意工具操作(read/write/edit/bash等)
- 所有文件修改**直接写入文件系统**,而非生成补丁

### 2. 附件(Attachments)机制

子任务完成后,通过 `attachments` 字段将结果传递回父会话:

```typescript
// TaskTool.execute 返回值结构
{
  title: string              // 任务标题
  metadata: {                // 元数据
    sessionId: string        // 子会话ID
    model: ModelInfo         // 使用的模型
  }
  output: string             // 文本输出(task_result内容)
  attachments?: Array<{      // 可选的附件列表
    type: "file" | "image"
    mime: string            // MIME类型
    url: string             // data:URL 或文件路径
    filename?: string       // 文件名
  }>
}
```

## 工作流程

### 阶段1: 子任务执行

```
父会话 (Parent Session)
    ↓ 调用 task tool
子会话 (Child Session) 创建
    ↓ 执行 agent loop
    ├─ read files
    ├─ edit files (直接修改文件系统)
    ├─ write files (直接创建文件)
    └─ bash commands
    ↓ 完成执行
提取结果 (output + attachments)
```

### 阶段2: 结果处理

在 `packages/opencode/src/session/prompt.ts` 的 `loop` 函数中:

```typescript
// L632-643: 执行子任务并处理附件
const result = await taskTool.execute(taskArgs, taskCtx).catch(...)

// 处理结果中的附件,为其分配新的ID和关联信息
const attachments = result?.attachments?.map((attachment) => ({
  ...attachment,
  id: PartID.ascending(),        // 生成新的Part ID
  sessionID,                      // 关联到父会话
  messageID: assistantMessage.id, // 关联到助手消息
}))

// L660-676: 更新工具部分状态
if (result && part.state.status === "running") {
  await Session.updatePart({
    ...part,
    state: {
      status: "completed",
      input: part.state.input,
      title: result.title,
      metadata: result.metadata,
      output: result.output,
      attachments,  // 附件存储在这里
      time: {
        ...part.state.time,
        end: Date.now(),
      },
    },
  } satisfies MessageV2.ToolPart)
}
```

### 阶段3: 附件转换为模型消息

在 `packages/opencode/src/session/message-v2.ts` 的 `toModelMessages` 函数中:

```typescript
// L734-753: 处理工具完成的附件
if (part.type === "tool") {
  if (part.state.status === "completed") {
    const outputText = part.state.time.compacted 
      ? "[Old tool result content cleared]" 
      : part.state.output
    
    const attachments = part.state.time.compacted || options?.stripMedia 
      ? [] 
      : (part.state.attachments ?? [])
    
    // 分离媒体文件和非媒体文件
    const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
    const nonMediaAttachments = attachments.filter((a) => !isMedia(a.mime))
    
    // 对于不支持工具结果中媒体的提供商,提取媒体文件
    if (!supportsMediaInToolResults && mediaAttachments.length > 0) {
      media.push(...mediaAttachments)
    }
    
    const finalAttachments = supportsMediaInToolResults 
      ? attachments 
      : nonMediaAttachments
    
    // 构建输出格式
    const output = finalAttachments.length > 0
      ? {
          text: outputText,
          attachments: finalAttachments,
        }
      : outputText
    
    // 添加工具结果到消息
    assistantMessage.parts.push({
      type: "tool-result",
      toolCallId: part.callID,
      output: toModelOutput({ 
        toolCallId: part.callID, 
        input: part.state.input, 
        output 
      }),
    })
  }
}

// L797-813: 如果提取了媒体文件,注入为单独的用户消息
if (media.length > 0) {
  result.push({
    id: MessageID.ascending(),
    role: "user",
    parts: [
      {
        type: "text" as const,
        text: "Attached image(s) from tool result:",
      },
      ...media.map((attachment) => ({
        type: "file" as const,
        url: attachment.url,
        mediaType: attachment.mime,
      })),
    ],
  })
}
```

## 关键问题解答

### Q1: 如果是新写代码(非补丁),如何合并?

**答案**: 不存在"合并"的概念,因为:

1. **子任务直接修改文件系统**
   - 子任务中的 `write`/`edit` 工具直接操作磁盘上的文件
   - 这些修改对父会话立即可见
   - 不需要任何合并操作

2. **附件的作用**
   - 附件主要用于传递**二进制文件**(图片、PDF等)
   - 或者作为**引用信息**传递给父会话的LLM
   - 不是用于代码合并

3. **示例场景**
   ```
   父会话: "创建一个React组件"
     ↓ 调用 task tool
   子会话: 
     - write src/MyComponent.tsx (直接写入文件系统)
     - write src/MyComponent.css (直接写入文件系统)
     ↓ 完成
   父会话: 
     - 收到 output: "已创建组件文件"
     - 收到 attachments: [] (通常为空,因为文件已在磁盘上)
     - 可以继续读取刚创建的文件进行验证
   ```

### Q2: 有没有专门的合并Agent?

**答案**: **没有**。原因如下:

1. **无需合并**: 文件修改是直接的,不是补丁形式
2. **冲突避免**: 子任务在独立会话中运行,不会与父会话并发修改同一文件
3. **权限隔离**: 子任务的权限受控,只能访问授权的资源

### Q3: 全新文件如何处理?

**答案**: 全新文件也**直接写入文件系统**:

```typescript
// 子会话中
WriteTool.execute({
  path: "src/NewFile.ts",
  content: "export const hello = 'world'"
})
// 文件立即存在于磁盘上

// 父会话可以通过 ReadTool 读取
ReadTool.execute({
  path: "src/NewFile.ts"
})
```

### Q4: 如果需要将子任务的结果"整合"到父会话怎么办?

**答案**: 通过以下机制:

1. **文本输出(output)**: 子任务的总结性描述
   ```typescript
   output: `task_id: ${sessionId}
   
   <task_result>
   已完成以下工作:
   - 创建了 MyComponent.tsx
   - 添加了样式文件
   - 导出了必要的接口
   </task_result>`
   ```

2. **附件(attachments)**: 用于特殊文件类型
   - 图片、PDF等二进制文件
   - 以 `data:` URL 形式嵌入

3. **文件系统共享**: 最直接的方式
   - 父会话可以直接读取子任务创建/修改的文件
   - 通过 `read` 工具获取最新内容

## 实际案例分析

### 案例1: 代码生成任务

```
用户: "帮我创建一个登录页面"
  ↓
父会话调用 task tool:
  {
    prompt: "创建登录页面组件",
    subagent_type: "frontend",
    description: "Login page implementation"
  }
  ↓
子会话执行:
  1. read src/components/ (了解现有结构)
  2. write src/components/LoginPage.tsx
  3. write src/components/LoginPage.module.css
  4. edit src/App.tsx (添加路由)
  ↓
子会话返回:
  {
    output: "已创建登录页面组件并配置路由",
    attachments: []  // 空,因为文件已在磁盘上
  }
  ↓
父会话继续:
  - 可以看到文件系统中的新文件
  - 可以读取验证: read src/components/LoginPage.tsx
  - 可以继续后续任务
```

### 案例2: 带图片的任务

```
用户: "分析这个截图并提出UI改进建议"
  ↓
父会话调用 task tool,附带图片:
  {
    prompt: "分析UI并提供改进建议",
    subagent_type: "designer"
  }
  (图片通过父会话的消息历史传递)
  ↓
子会话执行:
  1. 分析图片
  2. 生成标注图片(使用绘图工具)
  3. 返回标注结果
  ↓
子会话返回:
  {
    output: "发现了3个可改进点...",
    attachments: [
      {
        type: "image",
        mime: "image/png",
        url: "data:image/png;base64,iVBORw0KGgo...",
        filename: "annotated_ui.png"
      }
    ]
  }
  ↓
父会话:
  - 收到文本分析
  - 收到标注图片附件
  - 可以将图片展示给用户
```

## 技术细节

### 附件的数据结构

```typescript
// 定义位置: packages/opencode/src/tool/tool.ts
export interface Info {
  execute(args, ctx): Promise<{
    title: string
    metadata: Metadata
    output: string
    attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
  }>
}

// MessageV2.FilePart 结构
type FilePart = {
  id: PartID              // 在父会话中重新生成
  sessionID: SessionID    // 设置为父会话ID
  messageID: MessageID    // 设置为父会话的消息ID
  type: "file"
  url: string            // data:URL 或文件路径
  filename?: string
  mime: string
}
```

### ID重映射过程

```typescript
// packages/opencode/src/session/prompt.ts L638-643
const attachments = result?.attachments?.map((attachment) => ({
  ...attachment,
  id: PartID.ascending(),        // 生成父会话的新Part ID
  sessionID,                      // 从子会话改为父会话
  messageID: assistantMessage.id, // 关联到父会话的助手消息
}))
```

这确保了附件正确归属到父会话的消息系统中。

### 媒体文件的特殊处理

某些LLM提供商不支持在工具结果中包含媒体文件,因此需要特殊处理:

```typescript
// packages/opencode/src/session/message-v2.ts L738-745
const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
const nonMediaAttachments = attachments.filter((a) => !isMedia(a.mime))

if (!supportsMediaInToolResults && mediaAttachments.length > 0) {
  media.push(...mediaAttachments)  // 提取到单独的列表
}

const finalAttachments = supportsMediaInToolResults 
  ? attachments 
  : nonMediaAttachments  // 只保留非媒体附件
```

然后在后续注入为用户消息(L797-813)。

## 最佳实践

### 1. 子任务应该做什么

✅ **推荐**:
- 直接读写文件系统
- 执行完整的任务流程
- 返回简洁的文本总结
- 仅在必要时返回附件(图片等)

❌ **不推荐**:
- 尝试生成补丁字符串
- 手动管理文件合并逻辑
- 返回大量文本作为附件

### 2. 父会话如何使用子任务结果

```typescript
// ✅ 好的做法: 直接读取文件验证
await prompt({
  sessionID: parentSessionID,
  parts: [
    { type: "text", text: "检查刚才创建的组件是否正确" },
    { type: "file", url: "file://src/components/LoginPage.tsx" }
  ]
})

// ❌ 不好的做法: 试图从output中解析文件内容
// output只是摘要,不应该包含完整代码
```

### 3. 附件的使用场景

| 场景 | 使用附件 | 说明 |
|------|---------|------|
| 代码文件 | ❌ | 直接写入文件系统 |
| 配置文件 | ❌ | 直接写入文件系统 |
| 生成的图片 | ✅ | 需要通过data:URL传递 |
| PDF文档 | ✅ | 二进制内容需要嵌入 |
| 图表/截图 | ✅ | 视觉内容需要展示 |

## 相关文件

- `packages/opencode/src/tool/task.ts` - TaskTool实现
- `packages/opencode/src/session/prompt.ts` - 子任务执行和附件处理(L632-719)
- `packages/opencode/src/session/message-v2.ts` - 附件到模型消息的转换(L621-816)
- `packages/opencode/src/tool/tool.ts` - Tool接口定义

## 总结

1. **子任务不使用补丁机制**,而是直接修改文件系统
2. **没有专门的合并Agent**,因为不需要合并操作
3. **附件主要用于二进制文件**(图片、PDF等)的传递
4. **代码文件通过文件系统共享**,父会话可直接读取
5. **ID重映射**确保附件正确归属到父会话

这种设计简化了架构,避免了复杂的合并逻辑,同时保持了子任务的独立性和安全性。
