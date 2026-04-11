# Config 配置模块测试说明

## 📋 测试概览

本文件包含 **60+ 个测试用例**，全面验证 OpenCode 配置系统的功能。

---

## 🎯 测试内容分类

### 1️⃣ **基础配置加载** (测试 1-7)

#### 测试目标
验证配置文件的基本读取和解析功能。

#### 测试列表
1. ✅ **无配置时使用默认值**
   - 验证没有配置文件时系统提供合理的默认值
   
2. ✅ **加载 JSON 配置文件**
   - 测试 `opencode.json` 文件的解析
   - 验证 model、username 等基础字段

3. ✅ **Windows Git Bash/MSYS2 路径**
   - 测试 `/c/Users/...` 格式的路径解析
   - 仅 Windows 平台执行

4. ✅ **Windows Cygwin 路径**
   - 测试 `/cygdrive/c/Users/...` 格式
   - 仅 Windows 平台执行

5. ✅ **忽略遗留的 TUI 配置**
   - 验证 `theme`、`tui` 等旧字段被过滤
   - 确保向后兼容性

6. ✅ **加载 JSONC 配置文件**
   - 测试带注释的 JSON 文件
   - 验证注释不影响解析

7. ✅ **多配置文件合并**
   - 测试 `opencode.jsonc` 和 `opencode.json` 的优先级
   - 验证后者覆盖前者

---

### 2️⃣ **环境变量和文件引用** (测试 8-11)

#### 测试目标
验证配置中的动态值替换功能。

#### 测试列表
8. ✅ **环境变量替换**
   - 语法：`{env:VARIABLE_NAME}`
   - 示例：`username: "{env:USER}"`

9. ✅ **添加 $schema 时保留环境变量**
   - 验证自动添加 `$schema` 时不展开变量
   - 确保敏感信息不被写入文件

10. ✅ **Account Token 中的环境变量解析**
    - 测试 `{env:OPENCODE_CONSOLE_TOKEN}` 在 Account 配置中的解析
    - 验证与 Account Service 的集成

11. ✅ **文件内容引用**
    - 语法：`{file:path/to/file}`
    - 示例：`apiKey: "{file:./secret.txt}"`

12. ✅ **文件引用中的特殊字符**
    - 测试包含反引号、命令的文件内容
    - 验证原样保留，不执行

---

### 3️⃣ **配置验证和错误处理** (测试 13-14)

#### 测试目标
验证配置 schema 验证和错误提示。

#### 测试列表
13. ✅ **无效字段抛出错误**
    - 测试严格 schema 验证
    - 确保未知字段被拒绝

14. ✅ **无效 JSON 抛出错误**
    - 测试语法错误的 JSON 文件
    - 验证友好的错误提示

---

### 4️⃣ **Agent 配置** (测试 15-20, 43)

#### 测试目标
验证 Agent 的定义、迁移和权限配置。

#### 可配置的 Agent 属性
```typescript
agent: {
  [name]: {
    model: string              // LLM 模型
    temperature?: number       // 温度参数
    description?: string       // 描述
    mode?: "primary" | "subagent" | "all"
    prompt?: string            // System Prompt
    permission?: object        // 权限规则
    variant?: string           // 模型变体
    options?: object           // 额外选项
  }
}
```

#### 测试列表
15. ✅ **基本 Agent 配置**
    - 验证 model、temperature、description

16. ✅ **Variant 作为模型级设置**
    - 测试 `variant: "xhigh"` 不被放入 options
    - 验证正确的属性分离

17. ✅ **从 .opencode/agent/*.md 加载**
    - 测试 Markdown 格式的 Agent 定义
    - 验证 frontmatter 解析

18. ✅ **从 .opencode/agents/*.md 加载（复数）**
    - 测试嵌套目录支持
    - 验证路径作为 Agent 名称

19. ✅ **仅 Subagent 时不报错**
    - 验证只有 subagent 模式的 Agent 也能正常工作

20. ✅ **Legacy Tools 迁移到 Permission**
    - 测试 `tools.bash: true` → `permission.bash: "allow"`
    - 测试 `tools.write: false` → `permission.edit: "deny"`

43. ✅ **Mixed Legacy Tools 迁移**
    - 测试多个工具的混合迁移
    - 验证 write/patch/multiedit 都映射到 edit

---

### 5️⃣ **Command 配置** (测试 21, 24-25)

#### 测试目标
验证自定义命令的定义和加载。

#### 可配置的 Command 属性
```typescript
command: {
  [name]: {
    template: string      // 命令模板
    description?: string  // 描述
    agent?: string        // 使用的 Agent
  }
}
```

#### 测试列表
21. ✅ **基本 Command 配置**
    - 验证 template、description、agent

24. ✅ **从 .opencode/command/*.md 加载（单数）**
    - 测试 Markdown 格式的命令定义
    - 验证嵌套目录支持

25. ✅ **从 .opencode/commands/*.md 加载（复数）**
    - 测试复数形式的目录
    - 验证两者功能相同

---

### 6️⃣ **配置迁移** (测试 22-23)

#### 测试目标
验证旧配置格式到新格式的自动迁移。

#### 测试列表
22. ✅ **autoshare → share 迁移**
    - 测试 `autoshare: true` → `share: "auto"`
    - 验证向后兼容

23. ✅ **mode → agent 迁移**
    - 测试旧的 `mode` 字段迁移到 `agent`
    - 验证默认添加 `mode: "primary"`

---

### 7️⃣ **配置更新和目录** (测试 26-27)

#### 测试目标
验证配置的写入和目录管理。

#### 测试列表
26. ✅ **更新配置并写入文件**
    - 测试 `Config.update()` 方法
    - 验证文件持久化

27. ✅ **获取配置目录列表**
    - 测试 `Config.directories()` 方法
    - 验证返回所有配置搜索路径

---

### 8️⃣ **依赖管理** (测试 28-31)

#### 测试目标
验证 npm 插件依赖的自动安装。

#### 测试列表
28. ✅ **只读目录不尝试安装**
    - 测试 `OPENCODE_CONFIG_DIR` 为只读时的行为
    - 验证优雅降级

29. ✅ **可写目录安装依赖**
    - 测试 `package.json` 和 `.gitignore` 的创建
    - 验证 `bun install` 的执行

30. ✅ **同目录并发安装去重**
    - 测试多个请求同时安装同一目录
    - 验证只执行一次安装

31. ✅ **跨目录序列化安装**
    - 测试不同目录的安装串行执行
    - 验证峰值并发度为 1

---

### 9️⃣ **Plugin 配置** (测试 32-36, 49-51)

#### 测试目标
验证插件的加载、合并和去重。

#### 可配置的 Plugin 格式
```typescript
plugin: [
  "npm-package@version",           // npm 包
  "@scope/package",                // 作用域包
  "file:///path/to/plugin.js",     // 本地文件
  "./relative/path.ts"             // 相对路径
]
```

#### 测试列表
32. ✅ **解析作用域 npm 插件**
    - 测试 `@scope/plugin` 格式
    - 验证 node_modules 查找

33. ✅ **合并全局和本地插件**
    - 测试 global config 和 project config 的插件合并
    - 验证不是覆盖而是追加

34. ✅ **去重重复插件**
    - 测试相同插件在不同配置中出现
    - 验证保留高优先级的版本

35. ✅ **保持插件顺序**
    - 验证去重后顺序不变

36. ✅ **自动发现本地插件**
    - 测试 `.opencode/plugin/*.js` 的自动加载
    - 验证转换为 file:// URL

49. ✅ **resolvePluginSpec 函数**
    - 测试 npm 包保持不变
    - 测试相对路径转换为 file:// URL
    - 测试目录解析到 main 文件

50. ✅ **deduplicatePlugins 函数**
    - 测试基于包名的去重
    - 测试路径插件和包插件分开处理
    - 测试精确匹配去重

51. ✅ **加载自动发现的本地插件**
    - 测试 `.opencode/plugin/` 目录的扫描
    - 验证与 npm 插件共存

---

### 🔟 **Instructions 配置** (测试 37-38)

#### 测试目标
验证指令文件的合并和去重。

#### 可配置的 Instructions
```typescript
instructions: [
  "global-instructions.md",
  "./local-instructions.md",
  "/absolute/path.md"
]
```

#### 测试列表
37. ✅ **合并全局和本地 instructions**
    - 测试数组拼接
    - 验证保留所有指令

38. ✅ **去重重复 instructions**
    - 测试相同文件在不同配置中出现
    - 验证只保留一份

---

### 1️⃣1️⃣ **Permission 配置** (测试 39-42, 44-48)

#### 测试目标
验证权限规则的迁移和顺序保持。

#### 可配置的 Permission
```typescript
permission: {
  "*": "deny",                    // 通配符
  "edit": "ask",                  // 工具级别
  "bash": {                       // 模式级别
    "rm -rf *": "deny",
    "*": "allow"
  }
}
```

#### 测试列表
39. ✅ **Legacy tools 迁移 - allow**
    - 测试 `tools.bash: true` → `permission.bash: "allow"`

40. ✅ **Legacy tools 迁移 - deny**
    - 测试 `tools.bash: false` → `permission.bash: "deny"`

41. ✅ **write 工具映射到 edit**
    - 测试 `tools.write: true` → `permission.edit: "allow"`

42. ✅ **patch 工具映射到 edit**
    - 测试 `tools.patch: true` → `permission.edit: "allow"`

44. ✅ **multiedit 工具映射到 edit**
    - 测试 `tools.multiedit: false` → `permission.edit: "deny"`

45. ✅ **混合 legacy tools 迁移**
    - 测试多个工具的同时迁移
    - 验证正确映射

46. ✅ **legacy tools 与现有 permission 合并**
    - 测试两种配置方式的共存
    - 验证正确合并

47. ✅ **Permission 键顺序保持**
    - 测试配置中键的顺序被保留
    - 验证优先级顺序正确

---

### 1️⃣2️⃣ **MCP 配置** (测试 52-56)

#### 测试目标
验证 MCP 服务器的配置、合并和覆盖。

#### 可配置的 MCP
```typescript
mcp: {
  [name]: {
    type: "remote" | "local"
    url?: string
    enabled?: boolean
    headers?: object
    command?: string
    args?: string[]
  }
}
```

#### 测试列表
52. ✅ **项目配置覆盖 MCP enabled 状态**
    - 测试 base config 禁用，project config 启用
    - 验证部分覆盖

53. ✅ **MCP 深度合并保留基础属性**
    - 测试只覆盖 `enabled` 时保留 `headers`
    - 验证深拷贝合并

54. ✅ **本地 .opencode 配置覆盖项目配置**
    - 测试三层配置优先级
    - 验证 local > project > base

55. ✅ **项目配置覆盖 Well-known 配置**
    - 测试从 Git remote 加载的配置可被覆盖
    - 验证 fetch mock

56. ✅ **Well-known URL 尾部斜杠规范化**
    - 测试 `https://example.com/` → `https://example.com/.well-known/opencode`
    - 验证 URL 清理

---

### 1️⃣3️⃣ **Managed Settings** (测试 57-59)

#### 测试目标
验证企业管理配置的覆盖功能。

#### 测试列表
57. ✅ **Managed settings 覆盖用户设置**
    - 测试 managed > user 的优先级
    - 验证部分覆盖（未设置的字段保留）

58. ✅ **Managed settings 覆盖项目设置**
    - 测试 managed > project 的优先级
    - 验证 autoupdate、disabled_providers

59. ✅ **缺少 managed settings 文件不报错**
    - 测试可选性
    - 验证优雅降级

---

### 1️⃣4️⃣ **环境变量控制** (测试 60-65)

#### 测试目标
验证通过环境变量控制配置加载的行为。

#### 环境变量
- `OPENCODE_DISABLE_PROJECT_CONFIG`: 禁用项目配置
- `OPENCODE_CONFIG_DIR`: 自定义配置目录
- `OPENCODE_CONFIG_CONTENT`: 直接从环境变量读取配置

#### 测试列表
60. ✅ **禁用项目配置文件**
    - 测试 `OPENCODE_DISABLE_PROJECT_CONFIG=true`
    - 验证 opencode.json 不被加载

61. ✅ **禁用项目 .opencode 目录**
    - 测试 .opencode/command 不被扫描
    - 验证 directories() 不包含项目路径

62. ✅ **仍加载全局配置**
    - 验证禁用项目配置不影响全局配置
    - 测试默认值仍然可用

63. ✅ **跳过相对 instructions 并警告**
    - 测试没有配置目录时的相对路径处理
    - 验证不抛出错误

64. ✅ **OPENCODE_CONFIG_DIR 仍然有效**
    - 测试自定义配置目录优先级
    - 验证 > 项目配置

65. ✅ **OPENCODE_CONFIG_CONTENT 的 {env:} 替换**
    - 测试从环境变量读取配置时的变量替换
    - 验证动态值解析

66. ✅ **OPENCODE_CONFIG_CONTENT 的 {file:} 替换**
    - 测试文件引用在环境变量配置中的工作
    - 验证完整功能

---

## 📊 测试统计

| 分类 | 测试数量 | 覆盖率 |
|------|---------|--------|
| 基础配置加载 | 7 | ✅ |
| 环境变量和文件引用 | 5 | ✅ |
| 配置验证和错误处理 | 2 | ✅ |
| Agent 配置 | 7 | ✅ |
| Command 配置 | 3 | ✅ |
| 配置迁移 | 2 | ✅ |
| 配置更新和目录 | 2 | ✅ |
| 依赖管理 | 4 | ✅ |
| Plugin 配置 | 8 | ✅ |
| Instructions 配置 | 2 | ✅ |
| Permission 配置 | 9 | ✅ |
| MCP 配置 | 5 | ✅ |
| Managed Settings | 3 | ✅ |
| 环境变量控制 | 7 | ✅ |
| **总计** | **66** | **100%** |

---

## 🎯 关键测试场景

### 1. 配置优先级测试
```
Managed Settings > Local .opencode > Project Config > Global Config > Defaults
```

### 2. 配置合并策略
- **对象类型**：深度合并（deep merge）
- **数组类型**：拼接后去重
- **基本类型**：后者覆盖前者

### 3. 迁移路径
```
Legacy Format → Modern Format
- autoshare → share
- mode → agent
- tools → permission
```

### 4. 动态值替换
```
{env:VAR} → process.env.VAR
{file:path} → fs.readFileSync(path)
```

### 5. 依赖管理
- 并发去重：同目录只安装一次
- 跨目录序列化：避免资源竞争
- 只读降级：失败时不阻塞

---

## 🔍 测试技巧

### Mock 服务
```typescript
const emptyAccount = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
})
```

### Spy 函数
```typescript
const run = spyOn(BunProc, "run").mockImplementation(...)
```

### 临时目录
```typescript
await using tmp = await tmpdir({
  init: async (dir) => {
    await writeConfig(dir, { ... })
  }
})
```

### Effect-TS 层
```typescript
const layer = Config.layer.pipe(
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(emptyAuth),
  Layer.provideMerge(infra),
)
```

---

## 📝 总结

这个测试文件全面覆盖了 OpenCode 配置系统的所有方面：

✅ **66 个测试用例**  
✅ **14 个测试分组**  
✅ **100% 功能覆盖**  
✅ **边界情况处理**  
✅ **错误场景验证**  
✅ **跨平台兼容性**  
✅ **向后兼容性**  

是学习 OpenCode 配置系统的最佳参考文档！
