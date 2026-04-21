# 子任务结果合并与冲突解决（中文指南）

本文档汇总了对于父任务在收到多个已完成子任务后，如何对它们的输出进行合并、优化与冲突解决的完整流程与实现建议（包括自动化步骤、人工干预策略与可在本仓库中落地的实现要点）。

概览

- 收集子任务输出并规范化为补丁（patch）或文件变更。
- 将补丁按目标文件分组，尝试自动合并（无冲突直接应用，冲突则走三路合并或 AST 级合并）。
- 在临时工作区执行格式化/类型检查/测试；通过则提交，失败则生成合并会话等待人工处理或发起修复子任务。

步骤细节

1) 收集与正规化
- 从父会话历史（Session）读取每个子任务的结果（`TaskTool` 返回的 `output`、`attachments` 等）。
- 如果子任务已返回 patch/diff，直接使用；否则将子任务产生的文件内容与基线（task 创建时的快照）对比，生成补丁。

2) 按文件分组并分类
- 对每个目标文件收集来自不同子任务的补丁：
  - 无重叠 -> 自动合并候选
  - 局部重叠 -> 尝试三路合并（three-way merge）
  - 语义/结构冲突 -> AST 级合并或人工审查

3) 自动合并尝试
- 无重叠：直接合并到临时工作区
- 重叠：先尝试文本三路合并（diff3/git merge-file）；失败时触发 AST 合并或人工审查

4) AST / 语义合并（针对源代码）
- 对 TypeScript/JavaScript 等语言，使用 AST 工具（`ts-morph`/`recast`/`jscodeshift`）做合并：自动去重 imports、合并不同函数/类修改、调整命名冲突。
- 对复杂重构，建议把合并失败的文件交给专门的合并子任务（由 plan agent 触发或人工创建）。

5) 自动化验证
- 在临时分支/工作区运行：格式化、类型检查（`bun typecheck`）、单元测试、lint
- 只有所有检查通过才能自动应用合并并提交主线或创建 PR

6) 失败与人工干预
- 失败时：保存合并候选、冲突片段和运行日志为“合并会话”（Session），并通知人工审查。
- 人工审查后可发起新的子任务（如重构/统一接口）或直接手动合并。

7) 抽取共用逻辑（优化合并）
- 当多个子任务包含重复逻辑时，优先考虑抽取为共享模块：
  - 检测重复代码（AST 相似度或 code-clone 检测）并生成抽取建议
  - 通过单独子任务来实现抽取与替换

8) 原子提交与回滚
- 把合格的更改作为一个原子包（单个 commit/merge）提交；使用临时分支或 snapshot 来实现可回滚性（git revert 或 Session 的 revert 相关 API）。

在本仓库的落地建议（模块与 API）

- 新增 `MergeManager`（建议路径）：`packages/opencode/src/session/merge-manager.ts`
  - 功能：收集子任务输出 -> 规范化 patch -> 按文件合并 -> 生成合并候选 -> 在临时工作区运行验证 -> 应用或生成合并会话
  - 关键方法：`collectResults(sessionID)`, `normalizeToPatch(result)`, `groupByFile(patches)`, `tryAutoMergeForFile(file, patches, base)`, `astMerge(...)`, `applyMergedChanges(sessionID, mergedPatches)`, `runChecks(worktree)`

- TaskTool 增强（建议）：让 `TaskTool.execute` 在可行时返回结构化的 patch 对象（而非纯文本），便于 MergeManager 直接消费。

测试建议

- 单元/集成测试要覆盖：
  - 无冲突合并（多个子任务修改不同文件）
  - 文本三路合并成功
  - 文本合并失败后 AST 合并成功
  - 合并失败并生成合并会话（包含冲突信息与日志）
  - abort 场景：父会话中止时，正在运行的子任务被正确取消，临时工作区能被清理

监控与可观测性

- 记录合并相关指标：子任务数量、自动合并成功率、冲突率、平均合并时间、测试失败率
- 将这些指标用于优化 Plan agent 的任务划分策略

示例命令（伪）

```bash
# 收集并生成 patch
node scripts/collect-subtask-outputs.js --session sess-123 --out merged-candidates/
# 在临时分支应用非冲突补丁
git checkout -b merge/sess-123
git apply merged-candidates/nonconflicting/*.patch
# 运行验证
bun typecheck && bun test packages/opencode/test/integration/merge-*
```

文档与测试

- 本文档保存在 `docs/merge-and-conflict-resolution.md`
- 新增的 UT（若仓库中无相关 UT）路径：
  - `packages/opencode/test/session/merge-doc.test.ts`（验证文档存在）

后续工作建议（优先级）

1. 实现 MergeManager 的基础收集与非冲突自动应用（低风险，价值高）
2. 扩展 TaskTool 返回结构化 patch（中等工作量）
3. 实现 AST 合并 PoC（针对 TypeScript/JavaScript）并写集成测试（高价值）
4. 将合并流程接入 CI 并记录合并相关指标

---

(此文件由会话助手自动生成。如需我直接实现 `MergeManager` 的 PoC 并添加集成测试，请回复“开始实现 MergeManager”）

