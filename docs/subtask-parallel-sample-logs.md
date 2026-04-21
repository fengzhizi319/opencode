# 子任务并行示例日志（参考）

下面是一个并行批处理 3 个子任务 (MAX_PARALLEL_SUBTASKS = 3) 的示例日志片段，供审阅：

```
INFO session.prompt loop { step: 5, sessionID: "sess-abc" }
INFO session.prompt found task { task: { type: 'subtask', agent: 'build', description: 'run tests', ... } }
INFO session.prompt batching 3 subtasks for parallel execution
DEBUG session.prompt created assistant message { id: 'msg-101', agent: 'build' }
DEBUG session.prompt created assistant message { id: 'msg-102', agent: 'build' }
DEBUG session.prompt created assistant message { id: 'msg-103', agent: 'build' }
INFO task.execute.before { callID: 'part-201' }
INFO task.execute.before { callID: 'part-202' }
INFO task.execute.before { callID: 'part-203' }
INFO task.execute started { callID: 'part-201', subagent: 'build-sub' }
INFO task.execute started { callID: 'part-202', subagent: 'build-sub' }
INFO task.execute started { callID: 'part-203', subagent: 'build-sub' }
INFO task.execute finished { callID: 'part-202', durationMs: 812 }
INFO session.prompt updating part { callID: 'part-202', status: 'completed' }
INFO task.execute finished { callID: 'part-201', durationMs: 1203 }
INFO session.prompt updating part { callID: 'part-201', status: 'completed' }
INFO task.execute finished { callID: 'part-203', durationMs: 1602 }
INFO session.prompt updating part { callID: 'part-203', status: 'completed' }
INFO session.prompt inserted synthetic user message for command in part-201
INFO session.prompt continue loop
```

说明：日志显示父会话先为每个子任务写入 running 状态，然后并行执行 TaskTool/子会话，最后串行地将结果写回并插入必要的 synthetic messages。这样可以在保持父会话历史一致性的同时获得并行执行的速度优势。

