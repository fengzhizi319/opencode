// 导入测试框架和待测试的模块
import { expect, test, describe } from "bun:test"
import { ConfigMarkdown } from "../../src/config/markdown"  // Markdown 配置解析工具

/**
 * 测试套件 1：验证 ConfigMarkdown.files() 函数提取 @file 引用功能
 * 
 * ConfigMarkdown.files() 的作用：
 * - 从 Markdown 文本中提取所有以 @ 符号开头的文件路径引用
 * - 使用正则表达式匹配，支持相对路径、绝对路径、隐藏文件等
 * - 排除被反引号包裹的引用（如代码片段中的 @path）
 * - 排除电子邮件地址等非文件引用
 * 
 * 应用场景：
 * - 在 AI Agent 的配置文件中引用其他文件
 * - 允许用户通过 @path/to/file 语法包含外部文件内容
 * - 支持灵活的引用格式，提高配置的可读性
 */
describe("ConfigMarkdown: normal template", () => {
  // 测试模板：包含各种格式的 @file 引用，用于全面测试提取逻辑
  const template = `This is a @valid/path/to/a/file and it should also match at
  the beginning of a line:

  @another-valid/path/to/a/file

  but this is not:

     - Adds a "Co-authored-by:" footer which clarifies which AI agent
       helped create this commit, using an appropriate \`noreply@...\`
       or \`noreply@anthropic.com\` email address.

  We also need to deal with files followed by @commas, ones
  with @file-extensions.md, even @multiple.extensions.bak,
  hidden directories like @.config/ or files like @.bashrc
  and ones at the end of a sentence like @foo.md.

  Also shouldn't forget @/absolute/paths.txt with and @/without/extensions,
  as well as @~/home-files and @~/paths/under/home.txt.

  If the reference is \`@quoted/in/backticks\` then it shouldn't match at all.`

  // 执行文件引用提取，获取所有匹配结果
  const matches = ConfigMarkdown.files(template)

  // 测试用例 1.1：验证总共提取了 12 个文件引用
  // 预期匹配的引用：
  // 1. valid/path/to/a/file
  // 2. another-valid/path/to/a/file
  // 3. commas
  // 4. file-extensions.md
  // 5. multiple.extensions.bak
  // 6. .config/
  // 7. .bashrc
  // 8. foo.md
  // 9. /absolute/paths.txt
  // 10. /without/extensions
  // 11. ~/home-files
  // 12. ~/paths/under/home.txt
  // 不应匹配：noreply@...、noreply@anthropic.com（邮箱）、`@quoted/in/backticks`（反引号包裹）
  test("should extract exactly 12 file references", () => {
    expect(matches.length).toBe(12)
  })

  // 测试用例 1.2：验证提取第一个相对路径引用
  test("should extract valid/path/to/a/file", () => {
    expect(matches[0][1]).toBe("valid/path/to/a/file")
  })

  // 测试用例 1.3：验证提取行首的相对路径引用
  test("should extract another-valid/path/to/a/file", () => {
    expect(matches[1][1]).toBe("another-valid/path/to/a/file")
  })

  // 测试用例 1.4：验证能够正确处理后面紧跟逗号的引用
  // 输入：@commas, → 应提取 "commas"（不包括逗号）
  test("should extract paths ignoring comma after", () => {
    expect(matches[2][1]).toBe("commas")
  })

  // 测试用例 1.5：验证能够提取带文件扩展名且后面有逗号的路径
  // 输入：@file-extensions.md, → 应提取 "file-extensions.md"
  test("should extract a path with a file extension and comma after", () => {
    expect(matches[3][1]).toBe("file-extensions.md")
  })

  // 测试用例 1.6：验证能够提取包含多个点号的文件名（多重扩展名）
  // 输入：@multiple.extensions.bak, → 应提取 "multiple.extensions.bak"
  test("should extract a path with multiple dots and comma after", () => {
    expect(matches[4][1]).toBe("multiple.extensions.bak")
  })

  // 测试用例 1.7：验证能够提取隐藏目录（以 . 开头）
  // 输入：@.config/ → 应提取 ".config/"
  test("should extract hidden directory", () => {
    expect(matches[5][1]).toBe(".config/")
  })

  // 测试用例 1.8：验证能够提取隐藏文件（以 . 开头且无扩展名）
  // 输入：@.bashrc → 应提取 ".bashrc"
  test("should extract hidden file", () => {
    expect(matches[6][1]).toBe(".bashrc")
  })

  // 测试用例 1.9：验证能够忽略句子末尾的句号
  // 输入：@foo.md. → 应提取 "foo.md"（不包括句号）
  test("should extract a file ignoring period at end of sentence", () => {
    expect(matches[7][1]).toBe("foo.md")
  })

  // 测试用例 1.10：验证能够提取带扩展名的绝对路径
  // 输入：@/absolute/paths.txt → 应提取 "/absolute/paths.txt"
  test("should extract an absolute path with an extension", () => {
    expect(matches[8][1]).toBe("/absolute/paths.txt")
  })

  // 测试用例 1.11：验证能够提取不带扩展名的绝对路径
  // 输入：@/without/extensions → 应提取 "/without/extensions"
  test("should extract an absolute path without an extension", () => {
    expect(matches[9][1]).toBe("/without/extensions")
  })

  // 测试用例 1.12：验证能够提取家目录简写路径（不带扩展名）
  // 输入：@~/home-files → 应提取 "~/home-files"
  test("should extract an absolute path in home directory", () => {
    expect(matches[10][1]).toBe("~/home-files")
  })

  // 测试用例 1.13：验证能够提取家目录下的完整路径（带扩展名）
  // 输入：@~/paths/under/home.txt → 应提取 "~/paths/under/home.txt"
  test("should extract an absolute path under home directory", () => {
    expect(matches[11][1]).toBe("~/paths/under/home.txt")
  })

  // 测试用例 1.14：验证不会匹配被反引号包裹的引用（代码片段中的 @path）
  // 这是为了避免误匹配代码示例或命令中的 @ 引用
  test("should not match when preceded by backtick", () => {
    const backtickTest = "This `@should/not/match` should be ignored"
    const backtickMatches = ConfigMarkdown.files(backtickTest)
    expect(backtickMatches.length).toBe(0)
  })

  // 测试用例 1.15：验证不会匹配电子邮件地址
  // user@example.com 虽然包含 @ 符号，但不是文件引用，应该被排除
  test("should not match email addresses", () => {
    const emailTest = "Contact user@example.com for help"
    const emailMatches = ConfigMarkdown.files(emailTest)
    expect(emailMatches.length).toBe(0)
  })
})

/**
 * 测试套件 2：验证 ConfigMarkdown.parse() 函数的 YAML frontmatter 解析功能
 * 
 * ConfigMarkdown.parse() 的作用：
 * - 读取 Markdown 文件并解析其 YAML frontmatter（前置元数据）
 * - Frontmatter 是位于文件顶部、被 --- 分隔符包裹的 YAML 格式元数据
 * - 返回解析后的 data（元数据对象）和 content（去除 frontmatter 后的正文）
 * - 具备容错能力：如果标准解析失败，会使用 fallbackSanitization 进行宽松解析
 * 
 * Frontmatter 示例：
 * ```yaml
 * ---
 * title: Hello World
 * description: This is a description
 * ---
 * # Markdown content starts here
 * ```
 * 
 * 应用场景：
 * - AI Agent 配置文件：定义 agent 的名称、描述、使用的模型等
 * - 文档元数据：存储文章的标题、作者、日期等信息
 * - 配置模板：允许在 Markdown 中嵌入结构化配置
 */
describe("ConfigMarkdown: frontmatter parsing", async () => {
  // 解析测试 fixture 文件（包含复杂的 frontmatter 用例）
  const parsed = await ConfigMarkdown.parse(import.meta.dir + "/fixtures/frontmatter.md")

  // 测试用例 2.1：验证解析过程不抛出异常，且返回结构完整
  test("should parse without throwing", () => {
    expect(parsed).toBeDefined()
    expect(parsed.data).toBeDefined()    // 元数据对象存在
    expect(parsed.content).toBeDefined() // 正文内容存在
  })

  // 测试用例 2.2：验证能够正确提取双引号包裹的描述字段
  test("should extract description field", () => {
    expect(parsed.data.description).toBe("This is a description wrapped in quotes")
  })

  // 测试用例 2.3：验证能够处理值中包含冒号的字段
  // YAML 中冒号是键值分隔符，需要特殊处理以避免解析错误
  // 输入：occupation: This man has the following occupation: Software Engineer
  // 输出："This man has the following occupation: Software Engineer"
  test("should extract occupation field with colon in value", () => {
    expect(parsed.data.occupation).toBe("This man has the following occupation: Software Engineer")
  })

  // 测试用例 2.4：验证能够提取单引号包裹的标题字段
  test("should extract title field with single quotes", () => {
    expect(parsed.data.title).toBe("Hello World")
  })

  // 测试用例 2.5：验证能够处理值中包含双引号的字段
  // 输入：name: John "Doe" → 输出：'John "Doe"'
  test("should extract name field with embedded quotes", () => {
    expect(parsed.data.name).toBe('John "Doe"')
  })

  // 测试用例 2.6：验证能够处理值中包含单引号的字段
  // 输入：family: He has no 'family' → 输出："He has no 'family'"
  test("should extract family field with embedded single quotes", () => {
    expect(parsed.data.family).toBe("He has no 'family'")
  })

  // 测试用例 2.7：验证能够提取多行文本字段（使用 YAML 块标量）
  // 多行文本通常以 | 或 > 开头，保留换行符
  test("should extract multiline summary field", () => {
    expect(parsed.data.summary).toBe("This is a summary\n")
  })

  // 测试用例 2.8：验证不会解析被注释掉的字段（以 # 开头）
  // YAML 注释应该被忽略，不会出现在解析结果中
  test("should not include commented fields in data", () => {
    expect(parsed.data.field).toBeUndefined()
  })

  // 测试用例 2.9：验证能够正确解析包含端口号的 URL
  // URL 中的冒号和斜杠不应该干扰 YAML 解析
  // 输入：url: https://example.com:8080/path?query=value
  test("should extract URL with port", () => {
    expect(parsed.data.url).toBe("https://example.com:8080/path?query=value")
  })

  // 测试用例 2.10：验证能够处理包含时间格式（多个冒号）的值
  // 输入：time: The time is 12:30:00 PM
  test("should extract time with colons", () => {
    expect(parsed.data.time).toBe("The time is 12:30:00 PM")
  })

  // 测试用例 2.11：验证能够处理值中包含多个冒号的复杂情况
  // 输入：nested: First: Second: Third: Fourth
  test("should extract value with multiple colons", () => {
    expect(parsed.data.nested).toBe("First: Second: Third: Fourth")
  })

  // 测试用例 2.12：验证已经用双引号包裹的含冒号的值不会被重复处理
  // 已引用的值应该保持原样，不需要转换为块标量
  test("should preserve already double-quoted values with colons", () => {
    expect(parsed.data.quoted_colon).toBe("Already quoted: no change needed")
  })

  // 测试用例 2.13：验证已经用单引号包裹的含冒号的值不会被重复处理
  test("should preserve already single-quoted values with colons", () => {
    expect(parsed.data.single_quoted_colon).toBe("Single quoted: also fine")
  })

  // 测试用例 2.14：验证能够处理混合了引号和冒号的复杂值
  // 输入：mixed: He said "hello: world" and then left
  test("should extract value with quotes and colons mixed", () => {
    expect(parsed.data.mixed).toBe('He said "hello: world" and then left')
  })

  // 测试用例 2.15：验证能够正确处理空值（null）
  // YAML 中空值可以表示为 null、~ 或留空
  test("should handle empty values", () => {
    expect(parsed.data.empty).toBeNull()
  })

  // 测试用例 2.16：验证美元符号替换模式（$'、$& 等）会被当作普通文本处理
  // 这些是 JavaScript replace() 的特殊字符，需要避免被误解释
  test("should handle dollar sign replacement patterns literally", () => {
    expect(parsed.data.dollar).toBe("Use $' and $& for special patterns")
  })

  // 测试用例 2.17：验证不会将正文内容中的 YAML 格式文本误解析为 frontmatter
  // 只有文件顶部的 --- 之间的内容才是 frontmatter
  test("should not parse fake yaml from content", () => {
    expect(parsed.data.fake_field).toBeUndefined()   // 正文中的 fake_field 不应被解析
    expect(parsed.data.another).toBeUndefined()      // 正文中的 another 不应被解析
  })

  // 测试用例 2.18：验证正文内容保持原样，不被修改或解析
  // content 应该包含 frontmatter 之后的所有原始文本
  test("should extract content after frontmatter without modification", () => {
    expect(parsed.content).toContain("Content that should not be parsed:")
    expect(parsed.content).toContain("fake_field: this is not yaml")
    expect(parsed.content).toContain("url: https://should-not-be-parsed.com:3000")
  })
})

/**
 * 测试套件 3：验证解析空 frontmatter 的情况
 * 
 * 空 frontmatter 示例：
 * ```
 * ---
 * ---
 * Content
 * ```
 */
describe("ConfigMarkdown: frontmatter parsing w/ empty frontmatter", async () => {
  // 解析包含空 frontmatter 的测试文件
  const result = await ConfigMarkdown.parse(import.meta.dir + "/fixtures/empty-frontmatter.md")

  // 测试用例 3.1：验证空 frontmatter 能够正常解析
  // - data 应该是空对象 {}
  // - content 应该只包含正文部分
  test("should parse without throwing", () => {
    expect(result).toBeDefined()
    expect(result.data).toEqual({})         // 空 frontmatter 解析为空对象
    expect(result.content.trim()).toBe("Content")  // 正文保持不变
  })
})

/**
 * 测试套件 4：验证解析没有 frontmatter 的文件
 * 
 * 没有 frontmatter 的文件示例：
 * ```
 * Content
 * ```
 */
describe("ConfigMarkdown: frontmatter parsing w/ no frontmatter", async () => {
  // 解析不包含任何 frontmatter 的测试文件
  const result = await ConfigMarkdown.parse(import.meta.dir + "/fixtures/no-frontmatter.md")

  // 测试用例 4.1：验证没有 frontmatter 的文件能够正常解析
  // - data 应该是空对象 {}
  // - content 应该是整个文件内容
  test("should parse without throwing", () => {
    expect(result).toBeDefined()
    expect(result.data).toEqual({})         // 没有 frontmatter 时返回空对象
    expect(result.content.trim()).toBe("Content")  // 整个文件作为正文返回
  })
})

/**
 * 测试套件 5：验证解析以 Markdown 标题开头的文件（无 frontmatter）
 * 
 * 这种情况需要确保 Markdown 标题不会被误认为是 frontmatter
 */
describe("ConfigMarkdown: frontmatter parsing w/ Markdown header", async () => {
  // 解析以 Markdown 标题开头的测试文件
  const result = await ConfigMarkdown.parse(import.meta.dir + "/fixtures/markdown-header.md")

  // 测试用例 5.1：验证 Markdown 标题文件能够正确解析
  // - data 应该是空对象（没有 frontmatter）
  // - content 应该包含完整的 Markdown 内容，包括标题
  test("should parse and match", () => {
    expect(result).toBeDefined()
    expect(result.data).toEqual({})  // 没有 frontmatter，返回空对象
    // 验证正文内容完整保留，包括 Markdown 格式
    expect(result.content.trim().replace(/\r\n/g, "\n")).toBe(`# Response Formatting Requirements

Always structure your responses using clear markdown formatting:

- By default don't put information into tables for questions (but do put information into tables when creating or updating files)
- Use headings (##, ###) to organise sections, always
- Use bullet points or numbered lists for multiple items
- Use code blocks with language tags for any code
- Use **bold** for key terms and emphasis
- Use tables when comparing options or listing structured data
- Break long responses into logical sections with headings`)
  })
})

/**
 * 测试套件 6：验证解析包含特殊模型 ID 的 frontmatter
 * 
 * 这种情况测试模型 ID 中包含特殊字符（如斜杠、冒号）时的解析能力
 * 例如：synthetic/hf:zai-org/GLM-4.7
 */
describe("ConfigMarkdown: frontmatter has weird model id", async () => {
  // 解析包含特殊模型 ID 的测试文件
  const result = await ConfigMarkdown.parse(import.meta.dir + "/fixtures/weird-model-id.md")

  // 测试用例 6.1：验证能够正确解析包含特殊字符的模型 ID 和其他复杂字段
  test("should parse and match", () => {
    expect(result).toBeDefined()
    // 验证基本字段
    expect(result.data["description"]).toEqual("General coding and planning agent")
    expect(result.data["mode"]).toEqual("subagent")
    
    // 验证特殊模型 ID（包含斜杠和冒号）
    // synthetic/hf:zai-org/GLM-4.7 是一个复杂的模型标识符
    expect(result.data["model"]).toEqual("synthetic/hf:zai-org/GLM-4.7")
    
    // 验证嵌套对象字段（tools）
    expect(result.data["tools"]["write"]).toBeTrue()
    expect(result.data["tools"]["read"]).toBeTrue()
    
    // 验证多行文本字段
    expect(result.data["stuff"]).toBe("This is some stuff\n")

    // 验证正文内容
    expect(result.content.trim()).toBe("Strictly follow da rules")
  })
})
