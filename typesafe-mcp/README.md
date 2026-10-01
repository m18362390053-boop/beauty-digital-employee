# DeepSeek Harness → TypeSafe AI 工具

通过 Harness 内置的 `@deepseek-ai/dsh-mcp-client` 连接本地 MCP 服务。
模型可调用的工具名：`mcp__typesafe__evaluate`。

## 安装与启动（Windows PowerShell）

本目录首次使用先运行 `npm ci`。这是可选的通用Jev工具；主客服应用位于 `../beauty-demo/`。

在 typesafe-mcp 目录打开 PowerShell，设置密钥，然后从同一个窗口启动 Harness：

```powershell
# 隐藏输入，密钥不会出现在输入历史中
$secret = Read-Host 'TypeSafe API Key' -AsSecureString
$env:TYPESAFE_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password

dsh --profile web --patch ./harness.patch.yml --host 127.0.0.1 --port 3001
```

打开此次启动自动弹出的网页，或终端打印的带 token 完整地址。
3001 用于与先前的 3000 实例区分；先前实例不会自动获得这个工具或新环境变量。
这个命令在前台运行，Ctrl+C 停止。密钥只在当前终端环境中保存；新终端需重新设置。
通过 TypeSafe 控制台 https://console.typesafe.ai/keys 获取 API Key。

配置使用当前Node路径和当前工作目录。从其他目录启动时，应将 `TYPESAFE_MCP_ENTRY` 环境变量设置为server.mjs的绝对路径。
工具使用 stdio，无需单独开 HTTP 端口。Harness 会管理其子进程。
Harness 会过滤子进程中的敏感环境变量，所以 patch 中的显式 `env` 转发必不可少。

## 在 Harness 中测试

新建标准模式会话，发送：

> 请调用 mcp__typesafe__evaluate，判断“我付款三天了还没收到货，今天必须处理”应该归入物流、支付还是技术问题，并判断是否紧急。展示工具真实返回的概率和用量。

对应工具参数示例：

```json
{
  "state": "我付款三天了还没收到货，今天必须处理。",
  "questions": {
    "category": {
      "type": "choice",
      "instructions": "这条消息主要属于哪种问题？",
      "criteria": {
        "shipping": "配送、物流或未收到货",
        "payment": "付款失败、重复扣费或支付问题",
        "technical": "软件故障或技术问题"
      }
    },
    "urgent": {
      "type": "noul",
      "instructions": "这条消息是否表达了需要尽快处理的紧迫性？"
    },
    "frustration": {
      "type": "score",
      "instructions": "客户表达的不满程度如何？",
      "criteria": ["平静陈述", "不满但克制", "强烈愤怒"]
    }
  }
}
```

`score` 的等级从 0 开始，上例范围为 0–2，并可能是小数。
`noul` 是“是”的概率，不另有 `confidence`；Choice/Score 同时返回概率和置信度。
所有问题针对同一份 state 独立计算，不会看到其他问题的答案。
结果保留 API 原始 `answers`、`model`、`usage`。每次真实调用会使用你的 TypeSafe 额度。
工具请求只发送传入的 state/questions，不自动发送整个会话。

## 文件与验证

- `server.mjs`：MCP 工具定义、stdio 通信、错误返回。
- `evaluate.mjs`：参数验证、45 秒超时、请求取消、TypeSafe HTTP 调用。
- `harness.patch.yml`：Harness 的真实 patch-list 格式配置。
- `evaluate.test.mjs`：模拟 HTTP 和真实 MCP 子进程协议测试，`npm test` 不消耗额度。

API Key 在本地设置后才可以完成真实付费调用验证。模型主服务仍需在 Harness 中配置好。
没有自动重试：避免超时后重复提交付费请求；429/529 会明确报错，可稍后重试。

参考：https://docs.typesafe.ai/api ｜ 当前安装的 dsh-mcp-client/README.md
