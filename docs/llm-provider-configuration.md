# 如何配置 LLM 密钥
参考官方文档 [Providers Directory](https://opencode.ai/docs/providers#directory)，在 OpenCode 中配置 LLM 密钥和自定义提供商主要通过以下两个核心步骤：
## 1. 添加并保存 API 凭证 (Credentials)
OpenCode 不要求你把密钥直接写死在代码里（除非你愿意）。你可以通过 `/connect` 交互式命令，将 API Key 安全地添加到本地本地存储中（默认保存在 `~/.local/share/opencode/auth.json`）。
步骤如下：
在 项目根目录 下运行以下命令进入 TUI 交互界面
```bash
bun run dev
```
(这会自动执行 package.json 中的 bun run --cwd packages/opencode --conditions=browser src/index.ts 脚本)
当你运行 bun run dev 后，你会看到 OpenCode 的欢迎提示符（像聊天框一样）。 在这个交互式提示符内，输入 /connect 并回车即可。
如果你想直接通过命令行附带参数的方式运行（类似你之前截图中想要执行的单次指令），正确的语法结构是：
```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts run -- "请帮我写一个Python的冒泡排序算法"

```
```bash
$ /connect
┌  Add credential
│
◇  Enter provider id
│  myprovider       <-- (输入你自定义的供应商 ID)
│
◇  Enter your API key
│  sk-xxxxxxxxx     <-- (粘贴对应的 API Key)
└
```
## 2. 在配置文件中注册 Provider (Config)
配置完密钥后，你需要告诉 OpenCode 如何调用这个提供商的模型。在你的全局配置文件（`~/.config/opencode/opencode.jsonc`）或者项目级的 `opencode.json` 中，添加对应的 provider 配置，注意其 key 与你在上一步输入的 `provider id` 必须保持一致。
示例配置 (配置 OpenAI 兼容的第三方服务)：
```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "自定义模型服务 (显示用名称)",
      "options": {
        "baseURL": "https://api.myprovider.com/v1"
      },
      "models": {
        "my-model-name": {
          "name": "模型UI显示名称"
        }
      }
    }
  }
}
```
### 常用可配置参数解析：
- **`npm`**: 定义使用的 SDK。对于各类兼容 OpenAI 请求格式的厂商，统一使用?a│  sk-xxxxxxxxx     e`└
```
## 2. 在配置文件中注册 Provider (C? ``K ##????置完- **`name`**: 提供商在你使用 `/mo示例配置 (配置 OpenAI 兼容的第三方服务)：
```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "自定义模型服务 (显示用名称)",
      "options": {
        "baseURL": "https://api.myp??```json
{
  "$schema": "https://opencode.ai/config.jsonco{
  "$??? "provider"- **`models`**: 定义你可以调?   "myprovide?     "npm": "@ai-??     "name": "自定义模型???后，?     "options": {
        "baseURL": "https://api.myprod        "baseURL"?     },
      "models": {
        "my-model-name?     "?       "my-mode?         "EOF
cat docs/llm-provider-configuration.md
find . -name "cli.ts" -o -name "index.ts" | grep packages/opencode || echo "No packages/opencode"
