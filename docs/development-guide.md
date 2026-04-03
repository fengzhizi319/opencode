# 开发指南 (Development Guide)

## 架构选型
- **构建环境**: Bun + TypeScript
- **包管理**: Bun workspace / Turborepo
- **UI框架**: Solid.js (如果有 Web UI 部分) / Vite

## 代码规范要求

请仔细阅读项目根目录下的 `AGENTS.md`。

1. **命名规范**: **优先使用单词命名 (Single word names)**，如 `pid`, `cfg`, `err`, `opts`, `dir`, `root`。除非绝对必要，否则不要使用 CamelCase 复合词。
2. **逻辑编写**:
   - 优先函数式数组遍历（如 `.map()`, `.filter()`），避免 for 循环。
   - 避免冗余的 `try/catch`。
   - 避免使用 `else`，使用提前通过 `return` 结束判断的操作。
   - 减少变量结构的过度解构（Destructuring），推荐直接使用属性。

## 增加组件或者工具

在 `packages/opencode/src/tools` 新增工具时，确保导出的定义与 Schema 格式统一。

## 测试建议

1. 测试命令请进入子包目录下执行，例如：
   ```bash
   cd packages/opencode
   bun test
   bun typecheck
   ```
2. 禁止在根目录下执行测试，会抛出 `do-not-run-tests-from-root` 的报错。
3. 尽量减少 mock，测试真实的实现。
