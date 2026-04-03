# 任务执行流程图

## 整体架构流程图

```mermaid
flowchart TB
    subgraph User["👤 用户层"]
        UI[用户界面/UI]
        Input["输入: 写冒泡排序算法"]
    end

    subgraph SessionLayer["💬 会话层 (Session)"]
        SessionPrompt[SessionPrompt]
        Loop["loop() 主循环"]
        UserMsg[创建 User Message]
        AssistantMsg[创建 Assistant Message]
    end

    subgraph AgentLayer["🤖 Agent 层"]
        AgentGet["Agent.get('build')"]
        AgentConfig[Agent 配置<br/>权限/模型/提示词]
    end

    subgraph ToolLayer["🔧 Tool 层"]
        ToolRegistry[ToolRegistry]
        InitTools[初始化 Tools]
        WriteTool["WriteTool"]
        SkillTool["SkillTool"]
        BashTool["BashTool"]
    end

    subgraph SkillLayer["📚 Skill 层"]
        SkillAvailable["Skill.available()"]
        SkillList[可用 Skill 列表]
        SkillInject[注入 Skill 内容]
    end

    subgraph MemoryLayer["🧠 记忆层 (Memory)"]
        Messages[消息历史]
        Parts[Message Parts]
        Snapshot[代码快照]
        Compaction[压缩管理]
    end

    subgraph LLMLayer["🧩 LLM 层"]
        SystemPrompt[组装 System Prompt]
        ToModelMsgs["toModelMessages()"]
        StreamText["streamText()"]
        Processor["SessionProcessor"]
    end

    subgraph PermissionLayer["🔐 权限层"]
        PermissionEval["Permission.evaluate()"]
        UserConfirm[用户确认对话框]
    end

    %% 用户输入流程
    Input --> UI
    UI --> SessionPrompt
    SessionPrompt --> UserMsg
    UserMsg --> Loop

    %% Agent 选择
    Loop --> AgentGet
    AgentGet --> AgentConfig
    AgentConfig --> ToolRegistry

    %% Skill 处理
    AgentConfig --> SkillAvailable
    SkillAvailable --> SkillList
    SkillList --> SkillInject
    SkillInject --> SystemPrompt

    %% Tool 初始化
    ToolRegistry --> InitTools
    InitTools --> SystemPrompt

    %% Prompt 组装
    SystemPrompt --> ToModelMsgs
    ToModelMsgs --> Messages
    Messages --> StreamText

    %% LLM 流处理
    StreamText --> Processor
    Processor --> Parts
    Parts --> AssistantMsg

    %% Tool 调用流程
    Processor -->|tool-call| WriteTool
    WriteTool --> PermissionEval
    PermissionEval -->|需要确认| UserConfirm
    UserConfirm -->|Allow| WriteTool
    WriteTool -->|写入文件| Snapshot
    WriteTool -->|返回结果| Processor

    %% 继续循环或结束
    Processor -->|需要更多步骤| Loop
    Processor -->|完成| SessionPrompt
    SessionPrompt --> UI

    %% 记忆管理
    Loop -->|检查上下文| Compaction
    Compaction -->|必要时压缩| Messages
    AssistantMsg -->|保存| Messages
    Snapshot -->|生成 diff| SessionSummary

    style User fill:#e1f5fe
    style SessionLayer fill:#fff3e0
    style AgentLayer fill:#f3e5f5
    style ToolLayer fill:#e8f5e9
    style SkillLayer fill:#fff8e1
    style MemoryLayer fill:#fce4ec
    style LLMLayer fill:#e0f2f1
    style PermissionLayer fill:#ffebee
```

---

## 详细执行时序图

```mermaid
sequenceDiagram
    participant U as 用户/UI
    participant SP as SessionPrompt
    participant AG as Agent
    participant SK as Skill
    participant TR as ToolRegistry
    participant LLM as LLM Service
    participant PR as Processor
    participant WT as WriteTool
    participant PM as Permission
    participant SS as Session/SQLite

    U->>SP: prompt("写冒泡排序算法")
    activate SP
    
    SP->>SS: createUserMessage()
    SP->>SP: loop()
    activate SP
    
    Note over SP: 第 1 轮迭代
    
    SP->>AG: get("build")
    AG-->>SP: Agent.Info
    
    SP->>SK: available(agent)
    SK-->>SP: [python-best-practices]
    
    SP->>TR: tools(model, agent)
    TR-->>SP: [write, read, bash, skill...]
    
    SP->>SP: resolveTools()
    
    SP->>LLM: stream({messages, tools, system})
    activate LLM
    
    LLM->>PR: 返回 Event Stream
    activate PR
    
    PR->>PR: handleEvent(text-start)
    PR->>PR: handleEvent(text-delta) × N
    PR->>U: 实时显示: "我来帮你写..."
    
    PR->>PR: handleEvent(tool-call: write)
    PR->>WT: execute(args)
    activate WT
    
    WT->>PM: ask(permission: "edit")
    activate PM
    PM->>U: 显示确认对话框
    U->>PM: 点击 "Allow"
    PM-->>WT: 授权通过
    deactivate PM
    
    WT->>SS: 写入文件 bubble_sort.py
    WT-->>PR: 返回结果
    deactivate WT
    
    PR->>PR: handleEvent(tool-result)
    PR->>PR: handleEvent(finish-step)
    PR-->>LLM: 完成
    deactivate PR
    deactivate LLM
    
    SP->>SP: 检查循环条件
    Note over SP: finish=tool-calls, 继续循环
    
    Note over SP: 第 2 轮迭代
    
    SP->>LLM: stream(包含 tool-result)
    activate LLM
    LLM->>PR: 返回 Event Stream
    activate PR
    
    PR->>PR: handleEvent(text-start)
    PR->>PR: handleEvent(text-delta) × N
    PR->>U: 实时显示: "已完成..."
    PR->>PR: handleEvent(text-end)
    PR->>PR: handleEvent(finish-step)
    
    PR-->>LLM: 完成
    deactivate PR
    deactivate LLM
    
    SP->>SP: 检查循环条件
    Note over SP: finish=stop, 结束循环
    
    SP-->>SP: 退出 loop()
    deactivate SP
    
    SP->>SS: SessionSummary.summarize()
    SP-->>U: 返回最终结果
    deactivate SP
```

---

## Skill 使用流程图

```mermaid
flowchart LR
    A[用户输入] --> B{是否需要 Skill?}
    B -->|是| C[模型调用 skill 工具]
    B -->|否| D[正常处理]
    
    C --> E[SkillTool.execute]
    E --> F[Skill.get(name)]
    F --> G{Skill 存在?}
    G -->|否| H[返回错误: Skill 未找到]
    G -->|是| I[Permission.ask]
    I --> J{用户授权?}
    J -->|否| K[抛出拒绝错误]
    J -->|是| L[读取 SKILL.md]
    L --> M[扫描辅助文件]
    M --> N[组装 skill_content]
    N --> O[返回给模型]
    O --> P[模型使用 Skill 知识]
    
    D --> Q[直接生成回复]
    H --> R[模型调整策略]
    K --> R
    P --> S[完成任务]
    Q --> S
```

---

## Agent 调度流程图

```mermaid
flowchart TD
    A[用户输入] --> B{包含 @agent?}
    
    B -->|是| C[解析 @agent 名称]
    B -->|否| D[使用默认 Agent]
    
    C --> E{Agent 存在?}
    E -->|否| F[返回错误提示]
    E -->|是| G[获取 Agent.Info]
    D --> G
    
    G --> H{Agent.mode}
    
    H -->|primary| I[可以直接与用户交互]
    H -->|subagent| J[只能通过 task 工具调用]
    H -->|all| K[两者皆可]
    
    I --> L[执行主循环]
    J --> M[拒绝直接调用]
    K --> L
    
    L --> N[根据 Agent.permission 过滤工具]
    N --> O[组装 Agent 专属 system prompt]
    O --> P[调用 LLM]
    
    F --> Q[提示可用 Agents]
    M --> Q
```

---

## 记忆管理流程图

```mermaid
flowchart TD
    subgraph Incoming["新消息到达"]
        A[添加 Message/Part]
    end
    
    subgraph ContextCheck["上下文检查"]
        B{Token 数 > 阈值?}
    end
    
    subgraph Prune["剪枝 Prune"]
        C[从后向前扫描]
        D{累计 > 40k tokens?}
        E[标记旧 tool output 为 compacted]
    end
    
    subgraph Compact["压缩 Compact"]
        F[创建 compaction user message]
        G[调用 compaction Agent]
        H[生成对话摘要]
        I[保存为 summary message]
    end
    
    subgraph Continue["继续对话"]
        J[插入 "Continue..." 提示]
        K[恢复主循环]
    end
    
    A --> B
    B -->|是| C
    B -->|否| L[正常继续]
    
    C --> D
    D -->|否| C
    D -->|是| E
    E --> F
    
    F --> G
    G --> H
    H --> I
    I --> J
    J --> K
    
    style Prune fill:#fff3e0
    style Compact fill:#e8f5e9
```

---

## 权限检查流程图

```mermaid
flowchart TD
    A[Tool 执行] --> B[Permission.ask]
    
    B --> C[合并 Rulesets]
    C --> D[Agent 默认权限]
    C --> E[用户配置权限]
    C --> F[会话级权限]
    
    D --> G[Permission.evaluate]
    E --> G
    F --> G
    
    G --> H{评估结果}
    
    H -->|allow| I[直接通过]
    H -->|deny| J[抛出 DeniedError]
    H -->|ask| K[创建 Permission.Request]
    
    K --> L[发布 Asked 事件]
    L --> M[UI 显示确认对话框]
    M --> N{用户选择}
    
    N -->|Allow Once| O[Deferred.succeed]
    N -->|Always| P[添加到 approved Ruleset]
    P --> O
    N -->|Reject| Q[Deferred.fail RejectedError]
    
    O --> I
    Q --> R[Tool 执行中断]
    J --> R
    
    I --> S[继续 Tool 执行]
    
    style H fill:#fff3e0
    style N fill:#e8f5e9
```
