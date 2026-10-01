# Beauty Digital Employee · 美妆数字客服

面向单产品场景的比赛 Demo：**Jev 负责结构化判断和 Skill 调度，DeepSeek Flash 负责有依据的客服回复**。支持网页操作，也可作为 MCP 工具供 DeepSeek Harness 调用。

## 可以做什么

- **客服咨询**：产品知识、意图/情绪/风险路由、来源引用、明确降级。
- **用户资料卡**：保存用户确认的偏好，跨会话读取并支持修改。
- **人工接管**：暂停 AI、查看原话摘要、实际人工回复、结束处理；丢弃转人工后的迟到 AI 结果。
- **反馈与看板**：有帮助/没解决/转人工；评论标签、共现、日期趋势和客服风险统计分区展示。
- **Harness 工具**：10 个 MCP 工具，包括 `customer_service_consult` 完整客服入口。
- **数据底座**：SQLite、JSON 导入、来源追踪、版本检查、幂等请求和一致性备份。

网页采用浅薰衣草与深紫配色。当前资料和业务策略明确标记为 **demo**，不是官方品牌产品资料。

## Requirements

| 依赖 | 要求 | 用途 |
|---|---|---|
| Node.js | **24.x LTS** | 后端与内置 SQLite |
| npm | 建议随 Node 24 安装的 11.x | 安装锁定依赖、构建、测试 |
| Git | 能访问本仓库 | 获取源码 |
| 浏览器 | Chrome / Edge 等现代浏览器 | 网页演示 |
| TypeSafe API Key | 真实智能路由时需要 | Jev |
| DeepSeek 或兼容服务 API Key | 真实生成回复时需要 | 默认推荐 `deepseek-flash` |
| DeepSeek Harness | 可选 | MCP 集成演示 |

**这是 Node.js/TypeScript 项目，不需要 Python、pip、GPU，也不需要单独安装 SQLite。** 完整依赖由两个子项目的 `package.json` / `package-lock.json` 管理。详见 [REQUIREMENTS.md](REQUIREMENTS.md)。

## 1. 克隆与启动（Windows / macOS / Linux）

```sh
git clone https://github.com/m18362390053-boop/beauty-digital-employee.git
cd beauty-digital-employee/beauty-demo
npm ci
npm run build
npm run seed:demo
npm start
```

打开：**http://127.0.0.1:3090/demo/**

- `seed:demo` 创建 1 个虚构产品、3 条虚构评论和 2 个演示用户，可以重复执行。
- 数据保存于 `beauty-demo/data/beauty.sqlite`，关闭和重新启动不会丢失。
- 默认仅本机可访问；本版本还没有公网部署、正式登录或坐席权限控制。
- 无 API Key 也能演示数据卡、人工接管和统计；普通咨询会明确返回降级模板，不伪造模型结果。
- Node 24 出现 SQLite experimental 提示是运行时提示，不是数据库连接错误。

## 2. 配置真实模型（选择一种方式）

### 方式 A：本地密钥文件

在仓库根目录自行创建两个文件，每个仅填写一行密钥：

```text
beauty-digital-employee/
├── typesafe_apikey.txt      # 你自己的 TypeSafe API Key
├── deepseek_api.txt         # 你自己的 DeepSeek API Key
└── beauty-demo/
    └── config/
        ├── local.example.json
        └── local.json      # 从示例复制，Git忽略
```

在 `beauty-demo` 目录复制配置：

```powershell
# Windows PowerShell
Copy-Item config/local.example.json config/local.json
```

```sh
# macOS / Linux
cp config/local.example.json config/local.json
```

默认使用 `https://api.deepseek.com/v1`、`deepseek-flash`、非思考模式与 JSON 输出。密钥路径相对于配置文件解析。然后重新执行 `npm start`。

### 方式 B：环境变量

在**启动客服后端的同一终端**设置，环境变量优先于本地文件：

```powershell
# Windows PowerShell：隐藏输入
$secret = Read-Host 'TypeSafe API Key' -AsSecureString
$env:TYPESAFE_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
$secret = Read-Host 'DeepSeek API Key' -AsSecureString
$env:CHAT_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
$env:CHAT_BASE_URL = 'https://api.deepseek.com/v1'
$env:CHAT_MODEL = 'deepseek-flash'
npm start
```

macOS/Linux 设置同名环境变量即可。项目不会自动加载 `.env` 文件；`.env.example` 是变量说明。

检查状态：`http://127.0.0.1:3090/api/status`。`configured=true` 表示已配置，不等于已经验收凭据或模型效果。

**仓库不包含任何真实 API Key。** 密钥文件、`config/local.json`、数据库与运行报告都已被 Git 忽略。

## 3. 一条完整演示流程

1. 进入网页，选择演示用户，保存偏好并新建会话。
2. 已配置模型时，询问“请介绍当前产品已审核的说明”。查看真实路由、回复与来源。
3. 输入“用了以后脸肿了，请转人工”。该示例命中演示规则，停止推荐并进入等待人工。
4. 切换“人工接管”，点击接管、输入实际回复，再回到客服页查看。
5. 点击有帮助/没解决；进入“风险看板”查看统计与证据 ID。
6. 结束人工处理后，新建会话继续咨询；用户资料卡仍可带入。

## 4. 可选：接入 DeepSeek Harness

网页不依赖 Harness。需要展示 AI 工具调用时，可安装经过本项目验证的版本：

```sh
npm install -g @deepseek-ai/dsh@0.1.5-rc.3
```

先保持后端运行，再在 `beauty-demo` 目录的另一个 PowerShell 中执行：

```powershell
.\start-harness.ps1
```

默认在3002启动 Harness，绑定 `demo-user-a`。使用自动打开的带 token 页面，并配置 Harness 自身的主模型。

macOS/Linux 或手工启动：

```sh
# 必须位于 beauty-demo 目录
dsh --profile web --patch ./harness.patch.yml --host 127.0.0.1 --port 3002
```

推荐提示词：

> 先创建客服会话，再调用 mcp__beauty__customer_service_consult 处理“请介绍当前产品已审核的说明”。展示真实路由、来源和处理状态，不要模拟工具结果。

Harness 的主模型凭据与客服后端凭据分别配置。详见 [Harness接入](beauty-demo/docs/Harness接入.md)。

## 5. 测试、真实联调和备份

在 `beauty-demo` 目录：

```sh
npm test              # 35项工程测试，不调用付费模型
npm run test:ui       # 可选：本机Edge/Chrome界面测试
npm run smoke:mcp     # 后端运行时的只读MCP检查
npm run eval:route    # 规则冒烟；需Jev的案例标记not_run
npm run check:config  # 只检查加载状态，不显示密钥
npm run check:live    # 一条真实咨询，会使用少量模型额度
npm run backup       # 数据库一致性备份
```

浏览器测试不下载浏览器；找不到系统Edge/Chrome时，可设置 `BROWSER_PATH`，否则该项明确skip。
真实调用报告写入 `test-results/`；`verify:live-mcp` 可重放已有成功请求验证幂等。

## 业务同学如何参与

- 业务A：产品相关匿名评论、标签、来源和统计口径。
- 业务B：官方产品事实、3个Skill的内容、意图与风险定义、50条金标Case。
- 开发：加载、执行、存储、模型调用、页面与回归。

文件模板在 [`beauty-demo/content/templates/`](beauty-demo/content/templates/)，先阅读 [业务交付模板](beauty-demo/docs/业务交付模板.md)。业务同学不需要自行移植后端代码。

## 项目结构

```text
beauty-demo/          主应用：网页、后端、SQLite、10个MCP工具
typesafe-mcp/         可选的通用Jev evaluate工具，独立于主应用
REQUIREMENTS.md       环境和依赖要求
.github/workflows/   不含密钥、不调用付费API的工程CI
```

## 当前状态与边界

已跑通真实 Jev `jev-1.13.0` → `product_consult` → DeepSeek `deepseek-flash` 的单条调用，并验证 MCP 重放不重复调用模型。
**这不代表已完成50条业务金标验收。** 当前数据、分类、规则与阈值仍是演示版本，需用团队的正式内容替换和评测。
本期范围及待办见 [项目范围与状态](beauty-demo/docs/项目范围与状态.md)。服务器部署后续另配；当前无需服务器即可在各自电脑演示。

### 常见问题

- `EADDRINUSE`：端口被占用。关闭旧实例，或设置 `PORT` 后启动；MCP同步设置 `BEAUTY_API_URL`。
- `PROVIDER_NOT_CONFIGURED`：后端未读取到密钥。检查本地配置或后端终端的环境变量，重启。
- `degraded`：查看返回的 `warnings`；不是成功生成的答案。
- Harness看不到新工具：确认使用带本项目patch启动的新页面，修改编译代码后重启Harness。
- 组员不能访问你的127.0.0.1：这是本机地址，需要各自运行或后续部署共享后端。

更多说明：[主应用README](beauty-demo/README.md) · [完整流程/API](beauty-demo/docs/阶段三使用.md) · [基础API](beauty-demo/docs/API.md)
