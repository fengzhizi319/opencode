#!/usr/bin/env node
/**
 * 调试执行脚本 (Node.js 版本) - 冒泡排序任务
 * 
 * 用法:
 *   node debug-execution-node.mjs
 * 
 * 这个脚本会模拟执行 "写冒泡排序算法" 任务，并在关键位置输出调试信息。
 * 不需要安装依赖，可以直接运行查看执行流程。
 */

const DEBUG = {
  stage: (num, name) => console.log(`\n${"=".repeat(60)}\n[阶段 ${num}] ${name}\n${"=".repeat(60)}`),
  log: (label, data) => {
    if (data !== undefined) {
      console.log(`[DEBUG] ${label}:`, typeof data === "object" ? JSON.stringify(data, null, 2) : data);
    } else {
      console.log(`[DEBUG] ${label}`);
    }
  },
  divider: () => console.log("-".repeat(60)),
};

function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           OpenCode 执行调试 - Python 冒泡排序任务              ║
║                     (Node.js 版本)                             ║
╚══════════════════════════════════════════════════════════════╝
`);

  // ========== 阶段 1: 初始化 ==========
  DEBUG.stage(1, "项目初始化");
  
  DEBUG.log("正在初始化项目实例...");
  DEBUG.log("工作目录", "/home/user/myproject");
  DEBUG.divider();

  // ========== 阶段 2: 创建会话 ==========
  DEBUG.stage(2, "创建会话");
  
  const mockSession = {
    id: "01HQ8V8X1Y2Z3W4V5U6T7S8R9Q",
    title: "New session - 2026-03-30T10:30:00.000Z",
    directory: "/home/user/myproject",
  };
  DEBUG.log("会话创建成功", mockSession);
  DEBUG.divider();

  // ========== 阶段 3: Agent 选择 ==========
  DEBUG.stage(3, "Agent 选择");
  
  const mockAgent = {
    name: "build",
    mode: "primary",
    description: "The default agent. Executes tools based on configured permissions.",
    permission: [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "doom_loop", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "ask" },
    ],
    model: undefined,
  };
  DEBUG.log("使用 Agent", mockAgent);
  DEBUG.divider();

  // ========== 阶段 4: Skill 加载 ==========
  DEBUG.stage(4, "Skill 加载");
  
  const mockSkills = [
    { name: "python-best-practices", description: "Python coding best practices" },
    { name: "algorithm-templates", description: "Common algorithm templates" },
  ];
  DEBUG.log(`找到 ${mockSkills.length} 个可用 Skills`, mockSkills.map(s => s.name));
  DEBUG.divider();

  // ========== 阶段 5: 工具初始化 ==========
  DEBUG.stage(5, "工具初始化");
  
  const mockTools = [
    { id: "bash", description: "Execute shell commands" },
    { id: "read", description: "Read files or directories" },
    { id: "edit", description: "Edit files by string replacement" },
    { id: "write", description: "Create or overwrite files" },
    { id: "skill", description: "Load specialized skills" },
    { id: "glob", description: "Find files by glob pattern" },
    { id: "grep", description: "Search code by regex" },
  ];
  DEBUG.log(`可用工具 (${mockTools.length} 个)`, mockTools.map(t => t.id));
  DEBUG.divider();

  // ========== 阶段 6: System Prompt 组装 ==========
  DEBUG.stage(6, "System Prompt 组装");
  
  const systemPrompts = [
    "You are an expert software engineer...",
    `## Available Skills\n${mockSkills.map(s => `- ${s.name}: ${s.description}`).join("\n")}`,
    "Current time: 2026-03-30 10:30:00",
    "Current directory: /home/user/myproject",
  ];
  DEBUG.log(`组装了 ${systemPrompts.length} 段 System Prompt`);
  systemPrompts.forEach((prompt, i) => {
    console.log(`\n[${i + 1}] ${prompt.substring(0, 80)}${prompt.length > 80 ? "..." : ""}`);
  });
  DEBUG.divider();

  // ========== 阶段 7: 用户消息 ==========
  DEBUG.stage(7, "用户消息创建");
  
  const userMessage = {
    id: "msg_01HQ8V9A2B3C4D5E6F7G8H9I0J",
    role: "user",
    sessionID: mockSession.id,
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-4" },
    parts: [
      { type: "text", text: "请帮我写一个Python的冒泡排序算法" }
    ],
  };
  DEBUG.log("User Message", userMessage);
  DEBUG.divider();

  // ========== 阶段 8: LLM 调用模拟 ==========
  DEBUG.stage(8, "LLM 流处理 (第一轮)");
  
  console.log("\n[事件序列]");
  const events = [
    { type: "start", desc: "LLM 流开始" },
    { type: "text-start", desc: "文本开始生成" },
    { type: "text-delta", desc: "我来帮你写一个 Python 的冒泡排序算法。", isContent: true },
    { type: "text-end", desc: "文本生成结束" },
    { type: "tool-input-start", desc: "工具输入开始: write" },
    { 
      type: "tool-call", 
      desc: "工具调用: write", 
      detail: {
        toolName: "write",
        input: {
          filePath: "/home/user/myproject/bubble_sort.py",
          content: "def bubble_sort(arr):\n    n = len(arr)\n    for i in range(n):\n        for j in range(0, n - i - 1):\n            if arr[j] > arr[j + 1]:\n                arr[j], arr[j + 1] = arr[j + 1], arr[j]\n    return arr\n",
        }
      }
    },
    { type: "tool-result", desc: "工具执行成功", detail: { output: "File created" } },
    { type: "finish-step", desc: "步骤完成", detail: { tokens: { total: 245, input: 180, output: 65 } } },
  ];
  
  events.forEach((e, i) => {
    console.log(`${i + 1}. [${e.type}] ${e.desc}`);
    if (e.isContent) {
      console.log(`   内容: "${e.desc}"`);
    }
    if (e.detail) {
      const detailStr = JSON.stringify(e.detail, null, 2);
      console.log(`   详情: ${detailStr.split('\n').map(l => "   " + l).join('\n')}`);
    }
  });
  DEBUG.divider();

  // ========== 阶段 9: WriteTool 执行 ==========
  DEBUG.stage(9, "WriteTool 执行详情");
  
  DEBUG.log("工具参数", {
    filePath: "/home/user/myproject/bubble_sort.py",
    content: `def bubble_sort(arr):
    n = len(arr)
    for i in range(n):
        for j in range(0, n - i - 1):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
    return arr`,
  });
  
  DEBUG.log("权限检查", {
    permission: "edit",
    pattern: "bubble_sort.py",
    action: "ask -> allow (用户确认)",
  });
  
  DEBUG.log("文件操作", {
    operation: "write",
    path: "/home/user/myproject/bubble_sort.py",
    size: "156 bytes",
    status: "success",
  });
  
  DEBUG.log("发布事件", ["File.Event.Edited", "FileWatcher.Event.Updated"]);
  DEBUG.divider();

  // ========== 阶段 10: 第二轮迭代 ==========
  DEBUG.stage(10, "LLM 流处理 (第二轮)");
  
  console.log("\n[事件序列]");
  const events2 = [
    { type: "start", desc: "LLM 流开始" },
    { type: "text-start", desc: "文本开始生成" },
    { type: "text-delta", desc: "已经完成！我在 /home/user/myproject/bubble_sort.py 创建了冒泡排序算法。", isContent: true },
    { type: "text-end", desc: "文本生成结束" },
    { type: "finish-step", desc: "步骤完成", detail: { tokens: { total: 180, input: 120, output: 60 }, finishReason: "stop" } },
  ];
  
  events2.forEach((e, i) => {
    console.log(`${i + 1}. [${e.type}] ${e.desc}`);
    if (e.isContent) {
      console.log(`   内容: "${e.desc.substring(0, 60)}..."`);
    }
    if (e.detail) {
      console.log(`   详情:`, JSON.stringify(e.detail, null, 2));
    }
  });
  DEBUG.divider();

  // ========== 阶段 11: 会话摘要 ==========
  DEBUG.stage(11, "会话摘要");
  
  const summary = {
    additions: 15,
    deletions: 0,
    files: 1,
    diffs: [
      {
        file: "/home/user/myproject/bubble_sort.py",
        before: "",
        after: "def bubble_sort(arr):...",
        additions: 15,
        deletions: 0,
      }
    ]
  };
  DEBUG.log("变更统计", summary);
  DEBUG.divider();

  // ========== 阶段 12: 最终结果 ==========
  DEBUG.stage(12, "最终输出");
  
  const finalOutput = `我已经在 \`/home/user/myproject/bubble_sort.py\` 创建了冒泡排序算法。

文件内容预览:
\`\`\`python
def bubble_sort(arr):
    n = len(arr)
    for i in range(n):
        for j in range(0, n - i - 1):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
    return arr
\`\`\`

你可以运行测试:
\`\`\`bash
python bubble_sort.py
\`\`\``;

  console.log(finalOutput);
  DEBUG.divider();

  // ========== 执行统计 ==========
  DEBUG.stage(13, "执行统计");
  
  const stats = {
    "会话 ID": "01HQ8V8X1Y2Z3W4V5U6T7S8R9Q",
    "迭代次数": 2,
    "Token 使用": "425 (input: 320, output: 105)",
    "生成文件": 1,
    "文件路径": "/home/user/myproject/bubble_sort.py",
    "代码行数": 15,
  };
  
  Object.entries(stats).forEach(([key, value]) => {
    console.log(`${key.padEnd(15)}: ${value}`);
  });

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                      调试执行完成                              ║
╚══════════════════════════════════════════════════════════════╝
`);
}

main();
