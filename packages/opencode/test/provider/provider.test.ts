// 导入 Bun 测试框架的 test 和 expect 函数
import { test, expect } from "bun:test"
// 导入 Node.js 路径模块，用于构建文件路径
import path from "path"

// 导入临时目录工具，用于创建隔离的测试环境
import { tmpdir } from "../fixture/fixture"
// 导入实例模块，提供项目上下文管理
import { Instance } from "../../src/project/instance"
// 导入 Provider 模块，被测试的核心模块
import { Provider } from "../../src/provider/provider"
// 导入 ProviderID 和 ModelID 类型，用于标识提供者和模型
import { ProviderID, ModelID } from "../../src/provider/schema"
// 导入环境变量管理模块
import { Env } from "../../src/env"

/**
 * ============================================================================
 * 第一部分：Provider 加载机制测试
 * 测试从不同来源（环境变量、配置文件）加载 Provider 的行为
 * ============================================================================
 */

/**
 * 测试：从环境变量加载 Provider
 * 
 * 验证当设置 ANTHROPIC_API_KEY 环境变量时，
 * Anthropic Provider 能够正确加载并保留其连接源信息。
 */
test("provider loaded from env variable", async () => {
  // 创建临时测试目录
  await using tmp = await tmpdir({
    init: async (dir) => {
      // 写入最小化的 opencode.json 配置文件
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  
  // 在临时目录上下文中执行测试
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      // 设置 Anthropic API 密钥
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      // 验证 Anthropic Provider 已加载
      expect(providers[ProviderID.anthropic]).toBeDefined()
      // Provider 应保留其连接源（env 表示从环境变量加载）
      expect(providers[ProviderID.anthropic].source).toBe("env")
      // 验证 Anthropic 自定义 loader 添加的 beta header
      expect(providers[ProviderID.anthropic].options.headers["anthropic-beta"]).toBeDefined()
    },
  })
})

/**
 * 测试：从配置文件加载 Provider（使用 apiKey 选项）
 * 
 * 验证当在配置文件中直接指定 apiKey 时，
 * Provider 能够正确加载而无需环境变量。
 */
test("provider loaded from config with apiKey option", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              options: {
                apiKey: "config-api-key",  // 直接在配置中指定 API 密钥
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
    },
  })
})

/**
 * 测试：disabled_providers 配置排除指定 Provider
 * 
 * 验证即使设置了环境变量，被禁用的 Provider 也不会加载。
 */
test("disabled_providers excludes provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          disabled_providers: ["anthropic"],  // 禁用 Anthropic
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      // 验证 Anthropic Provider 未加载
      expect(providers[ProviderID.anthropic]).toBeUndefined()
    },
  })
})

/**
 * 测试：enabled_providers 限制仅加载列出的 Provider
 * 
 * 验证当设置 enabled_providers 时，只有列表中的 Provider 会加载，
 * 即使其他 Provider 的环境变量已设置。
 */
test("enabled_providers restricts to only listed providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic"],  // 仅启用 Anthropic
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
      Env.set("OPENAI_API_KEY", "test-openai-key")  // 即使设置了 OpenAI 密钥
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.anthropic]).toBeDefined()  // Anthropic 应加载
      expect(providers[ProviderID.openai]).toBeUndefined()   // OpenAI 不应加载
    },
  })
})

/**
 * 测试：模型白名单过滤 Provider 的模型
 * 
 * 验证 whitelist 配置能够只保留指定的模型，排除其他所有模型。
 */
test("model whitelist filters models for provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              whitelist: ["claude-sonnet-4-20250514"],  // 只保留此模型
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      const models = Object.keys(providers[ProviderID.anthropic].models)
      expect(models).toContain("claude-sonnet-4-20250514")
      expect(models.length).toBe(1)  // 应该只有一个模型
    },
  })
})

/**
 * 测试：模型黑名单排除特定模型
 * 
 * 验证 blacklist 配置能够排除指定的模型，保留其他所有模型。
 */
test("model blacklist excludes specific models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              blacklist: ["claude-sonnet-4-20250514"],  // 排除此模型
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      const models = Object.keys(providers[ProviderID.anthropic].models)
      expect(models).not.toContain("claude-sonnet-4-20250514")  // 验证已被排除
    },
  })
})

/**
 * ============================================================================
 * 第二部分：自定义 Provider 和模型配置测试
 * 测试自定义 Provider、模型别名、npm 包等高级功能
 * ============================================================================
 */

/**
 * 测试：通过配置文件创建自定义模型别名
 * 
 * 验证可以为现有模型创建自定义别名，并指定自定义名称。
 */
test("custom model alias via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "my-alias": {
                  id: "claude-sonnet-4-20250514",
                  name: "My Custom Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      expect(providers[ProviderID.anthropic].models["my-alias"]).toBeDefined()
      expect(providers[ProviderID.anthropic].models["my-alias"].name).toBe("My Custom Alias")
    },
  })
})

/**
 * 测试：使用 npm 包创建自定义 Provider
 * 
 * 验证可以通过配置完全自定义 Provider，包括：
 * - 指定 npm 包（@ai-sdk/openai-compatible）
 * - 自定义 API 端点
 * - 自定义环境变量要求
 * - 自定义模型定义
 */
test("custom provider with npm package", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "custom-provider": {
              name: "Custom Provider",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.custom.com/v1",
              env: ["CUSTOM_API_KEY"],
              models: {
                "custom-model": {
                  name: "Custom Model",
                  tool_call: true,
                  limit: {
                    context: 128000,
                    output: 4096,
                  },
                },
              },
              options: {
                apiKey: "custom-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("custom-provider")]).toBeDefined()
      expect(providers[ProviderID.make("custom-provider")].name).toBe("Custom Provider")
      expect(providers[ProviderID.make("custom-provider")].models["custom-model"]).toBeDefined()
    },
  })
})

/**
 * 测试：环境变量优先级和配置选项合并
 * 
 * 验证：
 * 1. 环境变量设置的 API 密钥优先生效
 * 2. 配置文件中的 options 会与默认选项深度合并
 */
/**
 * 测试：环境变量优先级与配置选项合并
 * 
 * 验证当同时存在环境变量和配置文件时：
 * 1. 环境变量（如 ANTHROPIC_API_KEY）优先用于认证
 * 2. 配置文件中的 options 会被正确合并到 Provider
 * 3. 两者可以共存，互不冲突
 */
test("env variable takes precedence, config merges options", async () => {
  // 创建临时测试目录并写入配置文件
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              // 在配置文件中指定超时选项
              options: {
                timeout: 60000,        // 请求超时时间：60秒
                chunkTimeout: 15000,   // 流式响应块超时：15秒
              },
            },
          },
        }),
      )
    },
  })
  
  // 在项目上下文中执行测试
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      // 通过环境变量设置 API 密钥（而非配置文件）
      Env.set("ANTHROPIC_API_KEY", "env-api-key")
    },
    fn: async () => {
      // 获取所有已加载的 Provider
      const providers = await Provider.list()
      
      // 验证 Anthropic Provider 已成功加载
      expect(providers[ProviderID.anthropic]).toBeDefined()
      
      // 验证配置文件中的 options 被正确合并
      // 即使 API 密钥来自环境变量，配置选项仍然生效
      expect(providers[ProviderID.anthropic].options.timeout).toBe(60000)
      expect(providers[ProviderID.anthropic].options.chunkTimeout).toBe(15000)
    },
  })
})

/**
 * ============================================================================
 * 第三部分：模型获取和解析测试
 * 测试 getModel、parseModel、defaultModel 等核心 API
 * ============================================================================
 */

/**
 * 测试：getModel 返回有效 Provider/Model 的模型信息
 */
test("getModel returns model for valid provider/model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.getModel(ProviderID.anthropic, ModelID.make("claude-sonnet-4-20250514"))
      expect(model).toBeDefined()
      expect(String(model.providerID)).toBe("anthropic")
      expect(String(model.id)).toBe("claude-sonnet-4-20250514")
      const language = await Provider.getLanguage(model)
      expect(language).toBeDefined()
    },
  })
})

/**
 * 测试：getModel 对无效模型抛出 ModelNotFoundError
 * 
 * 验证当请求不存在的模型时，系统会抛出适当的错误。
 */
test("getModel throws ModelNotFoundError for invalid model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      // 请求不存在的模型应该抛出错误
      expect(Provider.getModel(ProviderID.anthropic, ModelID.make("nonexistent-model"))).rejects.toThrow()
    },
  })
})

/**
 * 测试：getModel 对无效 Provider 抛出 ModelNotFoundError
 * 
 * 验证当请求不存在的 Provider 时，系统会抛出适当的错误。
 */
test("getModel throws ModelNotFoundError for invalid provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // 请求不存在的 Provider 应该抛出错误
      expect(Provider.getModel(ProviderID.make("nonexistent-provider"), ModelID.make("some-model"))).rejects.toThrow()
    },
  })
})

/**
 * 测试：parseModel 正确解析 provider/model 字符串格式
 * 
 * 验证标准格式 "provider/model" 的解析。
 */
test("parseModel correctly parses provider/model string", () => {
  const result = Provider.parseModel("anthropic/claude-sonnet-4")
  expect(String(result.providerID)).toBe("anthropic")
  expect(String(result.modelID)).toBe("claude-sonnet-4")
})

/**
 * 测试：parseModel 处理包含斜杠的模型 ID
 * 
 * 验证像 "openrouter/anthropic/claude-3-opus" 这样的格式，
 * 第一个斜杠前是 provider，后面全是 model ID。
 */
test("parseModel handles model IDs with slashes", () => {
  const result = Provider.parseModel("openrouter/anthropic/claude-3-opus")
  expect(String(result.providerID)).toBe("openrouter")
  expect(String(result.modelID)).toBe("anthropic/claude-3-opus")
})

/**
 * 测试：defaultModel 在未配置时返回第一个可用模型
 * 
 * 验证当没有设置默认模型配置时，系统会自动选择第一个可用的模型。
 */
test("defaultModel returns first available model when no config set", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.defaultModel()
      // 应该返回有效的 providerID 和 modelID
      expect(model.providerID).toBeDefined()
      expect(model.modelID).toBeDefined()
    },
  })
})

/**
 * 测试：defaultModel 尊重配置文件中的 model 设置
 * 
 * 验证当在配置文件中明确指定默认模型时，系统会使用配置的模型。
 */
test("defaultModel respects config model setting", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          model: "anthropic/claude-sonnet-4-20250514",  // 明确指定默认模型
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.defaultModel()
      // 应该返回配置的模型
      expect(String(model.providerID)).toBe("anthropic")
      expect(String(model.modelID)).toBe("claude-sonnet-4-20250514")
    },
  })
})

/**
 * 测试：Provider 使用配置文件中的 baseURL
 * 
 * 验证自定义 Provider 可以正确设置和使用自定义的 API 端点。
 */
test("provider with baseURL from config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "custom-openai": {
              name: "Custom OpenAI",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "gpt-4": {
                  name: "GPT-4",
                  tool_call: true,
                  limit: { context: 128000, output: 4096 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://custom.openai.com/v1",  // 自定义 API 端点
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("custom-openai")]).toBeDefined()
      // 验证 baseURL 被正确设置
      expect(providers[ProviderID.make("custom-openai")].options.baseURL).toBe("https://custom.openai.com/v1")
    },
  })
})

/**
 * ============================================================================
 * 第四部分：模型特性和能力测试
 * 测试模型的成本、限制、能力、变体等属性
 * ============================================================================
 */

/**
 * 测试：模型成本未指定时默认为零
 */
test("model cost defaults to zero when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "test-provider": {
              name: "Test Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 128000, output: 4096 },
                },
              },
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.make("test-provider")].models["test-model"]
      expect(model.cost.input).toBe(0)
      expect(model.cost.output).toBe(0)
      expect(model.cost.cache.read).toBe(0)
      expect(model.cost.cache.write).toBe(0)
    },
  })
})

/**
 * 测试：模型选项从现有模型合并
 */
test("model options are merged from existing model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  options: {
                    customOption: "custom-value",
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.options.customOption).toBe("custom-value")
    },
  })
})

/**
 * 测试：当所有模型被过滤掉时移除 Provider
 * 
 * 验证如果 whitelist 导致没有模型剩下，整个 Provider 会被移除。
 */
test("provider removed when all models filtered out", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              whitelist: ["nonexistent-model"],
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.anthropic]).toBeUndefined()
    },
  })
})

test("closest finds model by partial match", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const result = await Provider.closest(ProviderID.anthropic, ["sonnet-4"])
      expect(result).toBeDefined()
      expect(String(result?.providerID)).toBe("anthropic")
      expect(String(result?.modelID)).toContain("sonnet-4")
    },
  })
})

test("closest returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await Provider.closest(ProviderID.make("nonexistent"), ["model"])
      expect(result).toBeUndefined()
    },
  })
})

test("getModel uses realIdByKey for aliased models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "my-sonnet": {
                  id: "claude-sonnet-4-20250514",
                  name: "My Sonnet Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.anthropic].models["my-sonnet"]).toBeDefined()

      const model = await Provider.getModel(ProviderID.anthropic, ModelID.make("my-sonnet"))
      expect(model).toBeDefined()
      expect(String(model.id)).toBe("my-sonnet")
      expect(model.name).toBe("My Sonnet Alias")
    },
  })
})

test("provider api field sets model api.url", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "custom-api": {
              name: "Custom API",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.example.com/v1",
              env: [],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      // api field is stored on model.api.url, used by getSDK to set baseURL
      expect(providers[ProviderID.make("custom-api")].models["model-1"].api.url).toBe("https://api.example.com/v1")
    },
  })
})

test("explicit baseURL overrides api field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "custom-api": {
              name: "Custom API",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.example.com/v1",
              env: [],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://custom.override.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("custom-api")].options.baseURL).toBe("https://custom.override.com/v1")
    },
  })
})

test("model inherits properties from existing database model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  name: "Custom Name for Sonnet",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.name).toBe("Custom Name for Sonnet")
      expect(model.capabilities.toolcall).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.limit.context).toBeGreaterThan(0)
    },
  })
})

test("disabled_providers prevents loading even with env var", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          disabled_providers: ["openai"],
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.openai]).toBeUndefined()
    },
  })
})

test("enabled_providers with empty array allows no providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: [],
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
      Env.set("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(Object.keys(providers).length).toBe(0)
    },
  })
})

test("whitelist and blacklist can be combined", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              whitelist: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
              blacklist: ["claude-opus-4-20250514"],
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      const models = Object.keys(providers[ProviderID.anthropic].models)
      expect(models).toContain("claude-sonnet-4-20250514")
      expect(models).not.toContain("claude-opus-4-20250514")
      expect(models.length).toBe(1)
    },
  })
})

test("model modalities default correctly", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "test-provider": {
              name: "Test",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.make("test-provider")].models["test-model"]
      expect(model.capabilities.input.text).toBe(true)
      expect(model.capabilities.output.text).toBe(true)
    },
  })
})

test("model with custom cost values", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "test-provider": {
              name: "Test",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                  cost: {
                    input: 5,
                    output: 15,
                    cache_read: 2.5,
                    cache_write: 7.5,
                  },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.make("test-provider")].models["test-model"]
      expect(model.cost.input).toBe(5)
      expect(model.cost.output).toBe(15)
      expect(model.cost.cache.read).toBe(2.5)
      expect(model.cost.cache.write).toBe(7.5)
    },
  })
})

test("getSmallModel returns appropriate small model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.getSmallModel(ProviderID.anthropic)
      expect(model).toBeDefined()
      expect(model?.id).toContain("haiku")
    },
  })
})

test("getSmallModel respects config small_model override", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          small_model: "anthropic/claude-sonnet-4-20250514",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.getSmallModel(ProviderID.anthropic)
      expect(model).toBeDefined()
      expect(String(model?.providerID)).toBe("anthropic")
      expect(String(model?.id)).toBe("claude-sonnet-4-20250514")
    },
  })
})

test("provider.sort prioritizes preferred models", () => {
  const models = [
    { id: "random-model", name: "Random" },
    { id: "claude-sonnet-4-latest", name: "Claude Sonnet 4" },
    { id: "gpt-5-turbo", name: "GPT-5 Turbo" },
    { id: "other-model", name: "Other" },
  ] as any[]

  const sorted = Provider.sort(models)
  expect(sorted[0].id).toContain("sonnet-4")
  expect(sorted[0].id).toContain("latest")
  expect(sorted[sorted.length - 1].id).not.toContain("gpt-5")
  expect(sorted[sorted.length - 1].id).not.toContain("sonnet-4")
})

test("multiple providers can be configured simultaneously", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              options: { timeout: 30000 },
            },
            openai: {
              options: { timeout: 60000 },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-anthropic-key")
      Env.set("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      expect(providers[ProviderID.openai]).toBeDefined()
      expect(providers[ProviderID.anthropic].options.timeout).toBe(30000)
      expect(providers[ProviderID.openai].options.timeout).toBe(60000)
    },
  })
})

test("provider with custom npm package", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "local-llm": {
              name: "Local LLM",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "llama-3": {
                  name: "Llama 3",
                  tool_call: true,
                  limit: { context: 8192, output: 2048 },
                },
              },
              options: {
                apiKey: "not-needed",
                baseURL: "http://localhost:11434/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("local-llm")]).toBeDefined()
      expect(providers[ProviderID.make("local-llm")].models["llama-3"].api.npm).toBe("@ai-sdk/openai-compatible")
      expect(providers[ProviderID.make("local-llm")].options.baseURL).toBe("http://localhost:11434/v1")
    },
  })
})

/**
 * ============================================================================
 * 第五部分：边缘情况和高级功能测试
 * 测试复杂配置、变体、特殊 Provider 等
 * ============================================================================
 */

// Edge cases for model configuration

/**
 * 测试：模型别名名称在 id 不同时默认为别名键
 */
test("model alias name defaults to alias key when id differs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                sonnet: {
                  id: "claude-sonnet-4-20250514",
                  // no name specified - should default to "sonnet" (the key)
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.anthropic].models["sonnet"].name).toBe("sonnet")
    },
  })
})

test("provider with multiple env var options only includes apiKey when single env", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "multi-env": {
              name: "Multi Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["MULTI_ENV_KEY_1", "MULTI_ENV_KEY_2"],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                baseURL: "https://api.example.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("MULTI_ENV_KEY_1", "test-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("multi-env")]).toBeDefined()
      // When multiple env options exist, key should NOT be auto-set
      expect(providers[ProviderID.make("multi-env")].key).toBeUndefined()
    },
  })
})

test("provider with single env var includes apiKey automatically", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "single-env": {
              name: "Single Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["SINGLE_ENV_KEY"],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                baseURL: "https://api.example.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("SINGLE_ENV_KEY", "my-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("single-env")]).toBeDefined()
      // Single env option should auto-set key
      expect(providers[ProviderID.make("single-env")].key).toBe("my-api-key")
    },
  })
})

test("model cost overrides existing cost values", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  cost: {
                    input: 999,
                    output: 888,
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.cost.input).toBe(999)
      expect(model.cost.output).toBe(888)
    },
  })
})

test("completely new provider not in database can be configured", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "brand-new-provider": {
              name: "Brand New",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              api: "https://new-api.com/v1",
              models: {
                "new-model": {
                  name: "New Model",
                  tool_call: true,
                  reasoning: true,
                  attachment: true,
                  temperature: true,
                  limit: { context: 32000, output: 8000 },
                  modalities: {
                    input: ["text", "image"],
                    output: ["text"],
                  },
                },
              },
              options: {
                apiKey: "new-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("brand-new-provider")]).toBeDefined()
      expect(providers[ProviderID.make("brand-new-provider")].name).toBe("Brand New")
      const model = providers[ProviderID.make("brand-new-provider")].models["new-model"]
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.capabilities.input.image).toBe(true)
    },
  })
})

test("disabled_providers and enabled_providers interaction", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          // enabled_providers takes precedence - only these are considered
          enabled_providers: ["anthropic", "openai"],
          // Then disabled_providers filters from the enabled set
          disabled_providers: ["openai"],
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-anthropic")
      Env.set("OPENAI_API_KEY", "test-openai")
      Env.set("GOOGLE_GENERATIVE_AI_API_KEY", "test-google")
    },
    fn: async () => {
      const providers = await Provider.list()
      // anthropic: in enabled, not in disabled = allowed
      expect(providers[ProviderID.anthropic]).toBeDefined()
      // openai: in enabled, but also in disabled = NOT allowed
      expect(providers[ProviderID.openai]).toBeUndefined()
      // google: not in enabled = NOT allowed (even though not disabled)
      expect(providers[ProviderID.google]).toBeUndefined()
    },
  })
})

test("model with tool_call false", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "no-tools": {
              name: "No Tools Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "basic-model": {
                  name: "Basic Model",
                  tool_call: false,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("no-tools")].models["basic-model"].capabilities.toolcall).toBe(false)
    },
  })
})

test("model defaults tool_call to true when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "default-tools": {
              name: "Default Tools Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  // tool_call not specified
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("default-tools")].models["model"].capabilities.toolcall).toBe(true)
    },
  })
})

test("model headers are preserved", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "headers-provider": {
              name: "Headers Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                  headers: {
                    "X-Custom-Header": "custom-value",
                    Authorization: "Bearer special-token",
                  },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.make("headers-provider")].models["model"]
      expect(model.headers).toEqual({
        "X-Custom-Header": "custom-value",
        Authorization: "Bearer special-token",
      })
    },
  })
})

test("provider env fallback - second env var used if first missing", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "fallback-env": {
              name: "Fallback Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["PRIMARY_KEY", "FALLBACK_KEY"],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { baseURL: "https://api.example.com" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      // Only set fallback, not primary
      Env.set("FALLBACK_KEY", "fallback-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      // Provider should load because fallback env var is set
      expect(providers[ProviderID.make("fallback-env")]).toBeDefined()
    },
  })
})

test("getModel returns consistent results", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model1 = await Provider.getModel(ProviderID.anthropic, ModelID.make("claude-sonnet-4-20250514"))
      const model2 = await Provider.getModel(ProviderID.anthropic, ModelID.make("claude-sonnet-4-20250514"))
      expect(model1.providerID).toEqual(model2.providerID)
      expect(model1.id).toEqual(model2.id)
      expect(model1).toEqual(model2)
    },
  })
})

test("provider name defaults to id when not in database", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "my-custom-id": {
              // no name specified
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("my-custom-id")].name).toBe("my-custom-id")
    },
  })
})

test("ModelNotFoundError includes suggestions for typos", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      try {
        await Provider.getModel(ProviderID.anthropic, ModelID.make("claude-sonet-4")) // typo: sonet instead of sonnet
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions.length).toBeGreaterThan(0)
      }
    },
  })
})

test("ModelNotFoundError for provider includes suggestions", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      try {
        await Provider.getModel(ProviderID.make("antropic"), ModelID.make("claude-sonnet-4")) // typo: antropic
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions).toContain("anthropic")
      }
    },
  })
})

test("getProvider returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const provider = await Provider.getProvider(ProviderID.make("nonexistent"))
      expect(provider).toBeUndefined()
    },
  })
})

test("getProvider returns provider info", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const provider = await Provider.getProvider(ProviderID.anthropic)
      expect(provider).toBeDefined()
      expect(String(provider?.id)).toBe("anthropic")
    },
  })
})

test("closest returns undefined when no partial match found", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const result = await Provider.closest(ProviderID.anthropic, ["nonexistent-xyz-model"])
      expect(result).toBeUndefined()
    },
  })
})

test("closest checks multiple query terms in order", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      // First term won't match, second will
      const result = await Provider.closest(ProviderID.anthropic, ["nonexistent", "haiku"])
      expect(result).toBeDefined()
      expect(result?.modelID).toContain("haiku")
    },
  })
})

test("model limit defaults to zero when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "no-limit": {
              name: "No Limit Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  // no limit specified
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.make("no-limit")].models["model"]
      expect(model.limit.context).toBe(0)
      expect(model.limit.output).toBe(0)
    },
  })
})

test("provider options are deeply merged", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              options: {
                headers: {
                  "X-Custom": "custom-value",
                },
                timeout: 30000,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      // Custom options should be merged
      expect(providers[ProviderID.anthropic].options.timeout).toBe(30000)
      expect(providers[ProviderID.anthropic].options.headers["X-Custom"]).toBe("custom-value")
      // anthropic custom loader adds its own headers, they should coexist
      expect(providers[ProviderID.anthropic].options.headers["anthropic-beta"]).toBeDefined()
    },
  })
})

test("custom model inherits npm package from models.dev provider config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            openai: {
              models: {
                "my-custom-model": {
                  name: "My Custom Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENAI_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.openai].models["my-custom-model"]
      expect(model).toBeDefined()
      expect(model.api.npm).toBe("@ai-sdk/openai")
    },
  })
})

test("custom model inherits api.url from models.dev provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            openrouter: {
              models: {
                "prime-intellect/intellect-3": {},
                "deepseek/deepseek-r1-0528": {
                  name: "DeepSeek R1",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENROUTER_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.openrouter]).toBeDefined()

      // New model not in database should inherit api.url from provider
      const intellect = providers[ProviderID.openrouter].models["prime-intellect/intellect-3"]
      expect(intellect).toBeDefined()
      expect(intellect.api.url).toBe("https://openrouter.ai/api/v1")

      // Another new model should also inherit api.url
      const deepseek = providers[ProviderID.openrouter].models["deepseek/deepseek-r1-0528"]
      expect(deepseek).toBeDefined()
      expect(deepseek.api.url).toBe("https://openrouter.ai/api/v1")
      expect(deepseek.name).toBe("DeepSeek R1")
    },
  })
})

/**
 * ============================================================================
 * 第六部分：模型变体（Variants）测试
 * 测试推理模型的变体生成、禁用和自定义
 * ============================================================================
 */

/**
 * 测试：为推理模型生成变体
 * 
 * 验证具有 reasoning 能力的模型会自动生成变体（如 high、max）。
 */
/**
 * 测试：为推理模型生成变体
 * 
 * 验证具有 reasoning 能力的模型会自动生成变体（如 high、max）。
 * 这些变体允许用户调整模型的推理深度和 token 预算。
 */
test("model variants are generated for reasoning models", async () => {
  // 创建临时测试目录，使用最小化配置
  // 1. 创建临时目录
  await using tmp = await tmpdir({
    init: async (dir) => {
      // 2. 在临时目录中写入配置文件
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  // 此时 tmp.path 类似: /var/folders/xx/opencode-test-a1b2c3d4
  // tmp.path/opencode.json 已存在

  // 3. 使用临时目录进行测试
  // 在项目上下文中执行测试
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      // 设置 Anthropic API 密钥以加载 Provider
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      // 获取所有已加载的 Provider
      const providers = await Provider.list()
      console.log("providers:::::", providers)

      // Claude Sonnet 4 具有推理能力，应该自动生成变体
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]

      // 验证模型具有 reasoning 能力
      expect(model.capabilities.reasoning).toBe(true)

      // 验证模型定义了变体（variants）
      expect(model.variants).toBeDefined()

      // 验证至少生成了一个变体（通常是 high 和 max）
      expect(Object.keys(model.variants!).length).toBeGreaterThan(0)
    },
  })
  // 4. 离开作用域时，自动执行清理
  // tmp[Symbol.asyncDispose]() 被调用
  // → 删除整个临时目录及其内容
})

/**
 * ============================================================================
 * 第八部分：Ollama 本地模型测试
 * 测试使用 Ollama 运行本地模型的配置和连接
 * ============================================================================
 */

/**
 * 测试：配置 Ollama 本地 Provider 并加载 Qwen3.5:0.8b 模型
 * 
 * 验证可以通过配置文件设置 Ollama 作为本地 Provider，
 * 并使用 OpenAI 兼容的 API 接口连接到本地的 Ollama 服务。
 * 
 * 前置条件：
 * 1. 已安装 Ollama：https://ollama.com/
 * 2. 已拉取模型：ollama pull qwen3.5:0.8b
 * 3. Ollama 服务正在运行：ollama serve（默认端口 11434）
 */
test("ollama local provider with qwen3.5:0.8b model", async () => {
  // 1. 创建临时测试目录
  await using tmp = await tmpdir({
    init: async (dir) => {
      // 2. 写入 Ollama Provider 配置
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            // 自定义 Provider ID，可以是任意字符串
            ollama: {
              // 使用 OpenAI 兼容的 SDK（Ollama 提供 OpenAI 兼容的 API）
              npm: "@ai-sdk/openai-compatible",
              // Provider 显示名称
              name: "Ollama (local)",
              // 不需要环境变量（本地运行无需 API Key）
              env: [],
              // 配置 Ollama 的 API 端点（默认端口 11434）
              options: {
                baseURL: "http://localhost:11434/v1",
              },
              // 定义可用的模型
              models: {
                "qwen3.5:0.8b": {
                  // 模型显示名称
                  name: "Qwen 3.5 0.8B",
                  // 启用工具调用能力
                  tool_call: true,
                  // 设置上下文窗口大小（建议 16k-32k）
                  limit: {
                    context: 16384,
                    output: 4096,
                  },
                },
              },
            },
          },
        }),
      )
    },
  })

  // 3. 在项目上下文中执行测试
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // 4. 获取所有已加载的 Provider
      const providers = await Provider.list()
      console.log("providers:::::", providers)

      // 5. 验证 Ollama Provider 已成功加载
      expect(providers[ProviderID.make("ollama")]).toBeDefined()
      expect(providers[ProviderID.make("ollama")].name).toBe("Ollama (local)")

      // 6. 验证 Provider 使用了正确的 npm 包
      expect(providers[ProviderID.make("ollama")].models["qwen3.5:0.8b"].api.npm).toBe(
        "@ai-sdk/openai-compatible",
      )

      // 7. 验证 baseURL 配置正确
      expect(providers[ProviderID.make("ollama")].options.baseURL).toBe("http://localhost:11434/v1")

      // 8. 验证模型配置
      const model = providers[ProviderID.make("ollama")].models["qwen3.5:0.8b"]
      expect(model).toBeDefined()
      expect(model.name).toBe("Qwen 3.5 0.8B")
      expect(model.capabilities.toolcall).toBe(true)
      expect(model.limit.context).toBe(16384)
      expect(model.limit.output).toBe(4096)

      // 9. 尝试获取模型（如果 Ollama 服务正在运行且模型已拉取）
      try {
        const loadedModel = await Provider.getModel(
          ProviderID.make("ollama"),
          ModelID.make("qwen3.5:0.8b"),
        )
        console.log("loadedModel:::::", loadedModel)
        expect(loadedModel).toBeDefined()
        expect(String(loadedModel.providerID)).toBe("ollama")
        expect(String(loadedModel.id)).toBe("qwen3.5:0.8b")
      } catch (error) {
        // 如果 Ollama 服务未运行或模型未拉取，会抛出错误
        // 这在 CI 环境中是正常的
        console.warn("Ollama service may not be running or model not pulled:", error)
      }
    },
  })
})

/**
 * 测试：Ollama Provider 支持多个模型
 * 
 * 验证可以配置多个 Ollama 模型并在它们之间切换。
 */
test("ollama provider with multiple models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            ollama: {
              npm: "@ai-sdk/openai-compatible",
              name: "Ollama Multi-Model",
              env: [],
              options: {
                baseURL: "http://localhost:11434/v1",
              },
              models: {
                "qwen3.5:0.8b": {
                  name: "Qwen 3.5 0.8B",
                  tool_call: true,
                  limit: { context: 16384, output: 4096 },
                },
                "llama3.2:1b": {
                  name: "Llama 3.2 1B",
                  tool_call: false,
                  limit: { context: 8192, output: 2048 },
                },
              },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const ollama = providers[ProviderID.make("ollama")]

      expect(ollama).toBeDefined()
      // 验证两个模型都已配置
      expect(ollama.models["qwen3.5:0.8b"]).toBeDefined()
      expect(ollama.models["llama3.2:1b"]).toBeDefined()
      expect(Object.keys(ollama.models).length).toBe(2)

      // 验证不同模型的不同配置
      expect(ollama.models["qwen3.5:0.8b"].capabilities.toolcall).toBe(true)
      expect(ollama.models["llama3.2:1b"].capabilities.toolcall).toBe(false)
    },
  })
})
test("model variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      // max variant should still exist
      expect(model.variants!["max"]).toBeDefined()
    },
  })
})

/**
 * 测试：通过配置自定义模型变体
 */
test.only("model variants can be customized via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: {
                      thinking: {
                        type: "enabled",
                        budgetTokens: 20000,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants!["high"]).toBeDefined()
      expect(model.variants!["high"].thinking.budgetTokens).toBe(20000)
    },
  })
})

test("disabled key is stripped from variant config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    max: {
                      disabled: false,
                      customField: "test",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants!["max"]).toBeDefined()
      expect(model.variants!["max"].disabled).toBeUndefined()
      expect(model.variants!["max"].customField).toBe("test")
    },
  })
})

test("all variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: { disabled: true },
                    max: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants!).length).toBe(0)
    },
  })
})

test("variant config merges with generated variants", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: {
                      extraOption: "custom-value",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants!["high"]).toBeDefined()
      // Should have both the generated thinking config and the custom option
      expect(model.variants!["high"].thinking).toBeDefined()
      expect(model.variants!["high"].extraOption).toBe("custom-value")
    },
  })
})

test("variants filtered in second pass for database models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            openai: {
              models: {
                "gpt-5": {
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENAI_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.openai].models["gpt-5"]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      // Other variants should still exist
      expect(model.variants!["medium"]).toBeDefined()
    },
  })
})

test("custom model with variants enabled and disabled", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "custom-reasoning": {
              name: "Custom Reasoning Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "reasoning-model": {
                  name: "Reasoning Model",
                  tool_call: true,
                  reasoning: true,
                  limit: { context: 128000, output: 16000 },
                  variants: {
                    low: { reasoningEffort: "low" },
                    medium: { reasoningEffort: "medium" },
                    high: { reasoningEffort: "high", disabled: true },
                    custom: { reasoningEffort: "custom", budgetTokens: 5000 },
                  },
                },
              },
              options: { apiKey: "test-key" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.make("custom-reasoning")].models["reasoning-model"]
      expect(model.variants).toBeDefined()
      // Enabled variants should exist
      expect(model.variants!["low"]).toBeDefined()
      expect(model.variants!["low"].reasoningEffort).toBe("low")
      expect(model.variants!["medium"]).toBeDefined()
      expect(model.variants!["medium"].reasoningEffort).toBe("medium")
      expect(model.variants!["custom"]).toBeDefined()
      expect(model.variants!["custom"].reasoningEffort).toBe("custom")
      expect(model.variants!["custom"].budgetTokens).toBe(5000)
      // Disabled variant should not exist
      expect(model.variants!["high"]).toBeUndefined()
      // disabled key should be stripped from all variants
      expect(model.variants!["low"].disabled).toBeUndefined()
      expect(model.variants!["medium"].disabled).toBeUndefined()
      expect(model.variants!["custom"].disabled).toBeUndefined()
    },
  })
})

/**
 * ============================================================================
 * 第七部分：特殊 Provider 测试
 * 测试 Google Vertex、Cloudflare AI Gateway 等特殊 Provider
 * ============================================================================
 */

/**
 * 测试：Google Vertex 保留自定义代理的 baseURL
 */
test("Google Vertex: retains baseURL for custom proxy", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "vertex-proxy": {
              name: "Vertex Proxy",
              npm: "@ai-sdk/google-vertex",
              api: "https://my-proxy.com/v1",
              env: ["GOOGLE_APPLICATION_CREDENTIALS"], // Mock env var requirement
              models: {
                "gemini-pro": {
                  name: "Gemini Pro",
                  tool_call: true,
                },
              },
              options: {
                project: "test-project",
                location: "us-central1",
                baseURL: "https://my-proxy.com/v1", // Should be retained
              },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("GOOGLE_APPLICATION_CREDENTIALS", "test-creds")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("vertex-proxy")]).toBeDefined()
      expect(providers[ProviderID.make("vertex-proxy")].options.baseURL).toBe("https://my-proxy.com/v1")
    },
  })
})

test("Google Vertex: supports OpenAI compatible models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "vertex-openai": {
              name: "Vertex OpenAI",
              npm: "@ai-sdk/google-vertex",
              env: ["GOOGLE_APPLICATION_CREDENTIALS"],
              models: {
                "gpt-4": {
                  name: "GPT-4",
                  provider: {
                    npm: "@ai-sdk/openai-compatible",
                    api: "https://api.openai.com/v1",
                  },
                },
              },
              options: {
                project: "test-project",
                location: "us-central1",
              },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("GOOGLE_APPLICATION_CREDENTIALS", "test-creds")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.make("vertex-openai")].models["gpt-4"]

      expect(model).toBeDefined()
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
    },
  })
})

/**
 * 测试：Cloudflare AI Gateway 通过环境变量加载
 */
test("cloudflare-ai-gateway loads with env variables", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("CLOUDFLARE_ACCOUNT_ID", "test-account")
      Env.set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
      Env.set("CLOUDFLARE_API_TOKEN", "test-token")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")]).toBeDefined()
    },
  })
})

test("cloudflare-ai-gateway forwards config metadata options", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "cloudflare-ai-gateway": {
              options: {
                metadata: { invoked_by: "test", project: "opencode" },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("CLOUDFLARE_ACCOUNT_ID", "test-account")
      Env.set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
      Env.set("CLOUDFLARE_API_TOKEN", "test-token")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")]).toBeDefined()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")].options.metadata).toEqual({
        invoked_by: "test",
        project: "opencode",
      })
    },
  })
})
