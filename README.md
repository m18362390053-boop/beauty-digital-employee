# Beauty Digital Employee · 美妆数字客服

面向单产品场景的比赛 Demo：**Jev 负责结构化判断和 Skill 调度，DeepSeek Flash 负责有依据的客服回复**。支持网页操作，也可作为 MCP 工具供 DeepSeek Harness 调用。

## 组员先看这里

**先在自己的电脑运行后端，再打开网页。GitHub提供的是源码，不是已部署的网站。**

| 你要做什么 | 去哪里 |
|---|---|
| 第一次安装 | 下方“1. 首次安装与启动” |
| 已经下载过旧版 | 下方“1.2 从旧版升级” |
| 扮演普通用户提问 | `http://127.0.0.1:3090/chat/` |
| 配模型、上传Skill、接管客服、看运行记录 | `http://127.0.0.1:3090/ops/`，需要本机运营口令 |
| 不懂代码，只想上传业务Skill | 下方“3. 上传你们的Skill并验收” |

三个容易混淆的凭据：

- **运营口令**：本机首次启动自动生成，用来登录运营页面；不是API Key。
- **TypeSafe / DeepSeek API Key**：调用真实模型时需要，从运营页面填写；仓库不包含，也不会自动继承开发者的额度。
- **MCP访问凭据**：可选的Harness集成使用，由启动脚本申请，普通网页使用者不用填写。

## 可以做什么

**组员请先看：[上手与Skill上传](beauty-demo/docs/组员上手与Skill上传.md)。** 现在网页内可以配置模型、验证连接、上传/启停Skill；不必修改源码。
用户与运营现已拆分；登录与版本验收见 [双端权限与Skill验收](beauty-demo/docs/双端权限与Skill验收.md)。

- **客服咨询**：产品知识、意图/情绪/风险路由、来源引用、明确降级。
- **用户资料卡**：保存用户确认的偏好，跨会话读取并支持修改。
- **人工接管**：暂停 AI、查看原话摘要、实际人工回复、结束处理；丢弃转人工后的迟到 AI 结果。
- **反馈与看板**：有帮助/没解决/转人工；评论标签、共现、日期趋势和客服风险统计分区展示。
- **Harness 工具**：10 个 MCP 工具，包括 `customer_service_consult` 完整客服入口。
- **业务配置**：上传SKILL.md、JSON或ZIP知识包，立即启用；保存模型配置并验证连接。
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

## 1. 首次安装与启动（Windows / macOS / Linux）

### 1.1 第一次运行

先安装Node.js 24和Git。打开PowerShell或终端，确认 `node --version` 显示 `v24.x`。这个仓库是私有仓库，组员需先取得GitHub访问权限。

逐行执行，**上一行成功后再执行下一行**：

```sh
git clone https://github.com/m18362390053-boop/beauty-digital-employee.git
cd beauty-digital-employee/beauty-demo
npm ci
npm run build
npm run seed:demo
npm start
```

- 用户端：**http://127.0.0.1:3090/chat/**
- 运营端：**http://127.0.0.1:3090/ops/**

首次启动会生成 `beauty-demo/data/operator-password.txt`，运营人员从本机文件取得登录口令。用户端无需运营口令，也不需要填写模型Key。

`npm start` 启动后会一直运行，这是正常现象。保持这个终端打开，再打开浏览器；按Ctrl+C才是停止服务。
在资源管理器中打开 `beauty-demo/data/operator-password.txt`，把里面的一整行复制到运营登录页即可。每台电脑生成自己的口令，不要使用别人电脑上的口令。
也可以在**另一个位于beauty-demo目录的PowerShell**里运行 `notepad .\data\operator-password.txt` 打开文件。

首次没有配置模型时，可以操作页面和人工流程，但智能回复会提示暂不可用。请先完成第2节模型配置，再测试智能回答。

- `seed:demo` 创建 1 个虚构产品、3 条虚构评论和 2 个演示用户，可以重复执行。
- 数据保存于 `beauty-demo/data/beauty.sqlite`，关闭和重新启动不会丢失。
- 默认仅本机可访问；已提供匿名用户身份、运营登录及后端权限检查，公网部署后续另配。
- 无 API Key 也能演示数据卡、人工接管和统计；普通咨询会明确返回降级模板，不伪造模型结果。
- Node 24 出现 SQLite experimental 提示是运行时提示，不是数据库连接错误。

### 1.2 从旧版升级

1. 在旧服务终端按Ctrl+C停止后端；如果开着Harness，也先停止它。
2. 在旧的 `beauty-demo` 目录执行 `npm run backup` 备份已有数据库。如果此前从未创建数据库，可以跳过备份。
3. 打开**仓库根目录**（含这个README的目录），执行：

```sh
git status --short
git pull --ff-only
cd beauty-demo
npm ci
npm run build
npm start
```

如果 `git status` 显示你修改过代码，或 `git pull` 提示冲突，先保留自己的修改并联系开发处理，不要用强制重置覆盖。

- 正常更新会保留Git忽略的 `data/`、API配置和运营口令；不要删除data目录或拿别人的数据库覆盖。
- 新版会自动升级数据库到schema 4。旧版尚无运营口令时，第一次启动新版会生成。
- 旧 `/demo/` 会跳到运营登录页；日常用户体验请使用 `/chat/`。
- 旧演示用户/历史会话仍可在运营测试台查看。新的用户端按浏览器建立匿名身份，不会自动冒充旧的demo-user-a，这不代表旧数据被删除。
- 更新后若仍是旧界面，按Ctrl+F5强制刷新。

## 2. 配置真实模型（选择一种方式）

**推荐：登录运营端，打开“业务配置 · Skill上传”，填写两套Key及模型参数，先保存再验证。** 设置仅保存在本机的Git忽略目录，立即生效。
没有执行seed命令时，也可在这个页面点击“初始化演示数据”。下列文件/环境变量方式仍可用，但网页已保存的配置优先。

推荐先按下面填写：

| 页面字段 | 填写内容 |
|---|---|
| TypeSafe / Jev API Key | 你自己的或团队通过私下渠道提供的TypeSafe Key |
| 回复模型 API Key | DeepSeek Key，与TypeSafe Key不同 |
| 回复API Base URL | `https://api.deepseek.com/v1` |
| 回复模型名 | `deepseek-flash` |

点击**保存模型配置**，再点**验证连接**。只有显示两家服务都成功，才继续做真实问答；连接测试会使用少量额度。
保存后密钥输入框会清空，这是正常的，页面不会把已保存的密钥重新显示出来。以后留空保存表示保留原密钥。
网页保存的设置重启后仍有效，不需要每次输入。换电脑首次运行则需要重新配置。

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

在运营页检查状态并验证连接。`/api/status` 已受运营权限保护；`configured=true`表示已配置，不等于已经验收凭据或模型效果。

**仓库不包含任何真实 API Key。** 密钥文件、`config/local.json`、数据库与运行报告都已被 Git 忽略。

## 3. 上传你们的Skill并验收

### 3.1 最快的体验方法

1. 登录 `/ops/`，进入**业务配置 · Skill上传**。
2. 点击**下载可直接导入的ZIP模板**，先原样上传一次，确认“已注册的Skill”出现 `beauty-usage-guide · 已启用`。
3. 打开客服测试，问“演示套装里，演示精华和演示面霜应该怎么安排使用顺序？”
4. 在**执行记录**查看实际Skill、版本、知识片段与引用；不要只根据回答里的自述判断有没有调用Skill。

这是演示资料，不是真实产品知识。流程跑通后，再把模板里的说明和知识换成你们审核过的内容。

### 3.2 上传自己的文档

支持三种形式：

- **Markdown**：直接上传 `SKILL.md`，示例见 [`SKILL.example.md`](beauty-demo/content/templates/SKILL.example.md)。普通Markdown没有头部时，可在页面补ID和职责描述。
- **JSON**：填写 [`skill.template.json`](beauty-demo/content/templates/skill.template.json) 中的说明、适用意图和知识要求。
- **ZIP**：用于说明＋知识资料，结构如下：

```text
my-skill.zip
├── manifest.json       # ID、版本、描述、意图等
├── SKILL.md            # 业务处理步骤和回答要求
└── knowledge/
    └── product.md      # 实际产品/售后等依据
```

业务同学重点写清楚：**处理什么问题、不处理什么、需要问用户什么、回答依据是什么**。
Jev主要根据Skill职责描述与意图范围选择，选中后才加载完整说明和知识；不要把所有Skill都描述成“回答美妆问题”。

- 产品功效、用法、售后政策等需要事实依据，通常选择“必须有知识依据”，并提供知识文档。
- 寒暄、情绪承接、服务引导通常不需要产品事实。
- 上传后立即启用，下一条新咨询生效，不需要手动把文件放进源码目录，也不需要重启。
- 默认内置3个Skill，可以扩展；重叠职责可能竞争路由，应该用案例确认边界。

### 3.3 更新、回滚和停用

- 相同ID表示同一个Skill。修改文件内容后增加版本号，例如 `1.0.0` → `1.0.1`；也可在上传页面覆盖版本。
- 未写版本时按内容自动生成；同版本不同内容会拒绝覆盖。
- 在**文档 / 历史版本**中预览SKILL.md、导出ZIP，或启用旧版本。
- 停用后不再参与新请求；旧会话仍保留当时的文档快照。
- “去测试实际选择”只标记预期目标，**不会强制Jev选中它**。用正例、反例和停用后的问题验证。

详细步骤：[组员上手与Skill上传](beauty-demo/docs/组员上手与Skill上传.md) · [双端权限与版本验收](beauty-demo/docs/双端权限与Skill验收.md)

## 4. 用户与运营配合演示

1. 用户打开 `/chat/`，保存自己的偏好并发送问题；匿名身份由服务器绑定，不选择其他用户。
2. 已配置模型时，询问“请介绍当前产品已审核的说明”。用户查看回答与来源，运营在“执行记录”查看实际路由和文档快照。
3. 输入“用了以后脸肿了，请转人工”。该示例命中演示规则，停止推荐并进入等待人工。
4. 运营登录 `/ops/` 的“人工接管”，点击接管、输入实际回复；用户页收到消息。
5. 用户点击有帮助/没解决；运营进入“风险看板”查看统计与证据 ID。
6. 结束人工处理后，新建会话继续咨询；用户资料卡仍可带入。

## 5. 可选：接入 DeepSeek Harness

网页不依赖 Harness。需要展示 AI 工具调用时，可安装经过本项目验证的版本：

```sh
npm install -g @deepseek-ai/dsh@0.1.5-rc.3
```

先保持后端运行，再在 `beauty-demo` 目录的另一个 PowerShell 中执行：

```powershell
.\start-harness.ps1
```

默认在3002启动 Harness，绑定 `demo-user-a`。使用自动打开的带 token 页面，并配置 Harness 自身的主模型。
启动脚本自动申请用户绑定的后端访问凭据，MCP没有运营权限。

macOS/Linux 或手工启动：

```sh
# 必须位于 beauty-demo 目录
npm run mcp:token -- --user demo-user-a
dsh --profile web --patch ./harness.patch.yml --host 127.0.0.1 --port 3002
```

推荐提示词：

> 先创建客服会话，再调用 mcp__beauty__customer_service_consult 处理“请介绍当前产品已审核的说明”。展示真实路由、来源和处理状态，不要模拟工具结果。

Harness 的主模型凭据与客服后端凭据分别配置。详见 [Harness接入](beauty-demo/docs/Harness接入.md)。

## 6. 测试、真实联调和备份

在 `beauty-demo` 目录：

```sh
npm test              # 54项工程测试，不调用付费模型
npm run test:ui       # 可选：本机Edge/Chrome界面测试
npm run smoke:mcp     # 后端运行时的只读MCP检查
npm run eval:route    # 规则冒烟；需Jev的案例标记not_run
npm run check:config  # 只检查加载状态，不显示密钥
npm run check:live    # 一条真实咨询，会使用少量模型额度
npm run check:authoring # 真实验证寒暄/情绪/售后追问/上传Skill，会消耗少量额度
npm run backup       # 数据库一致性备份
npm run check:versions -- v1  # 真实版本验收，会调用模型；其后可分别运行v2、rollback、disable
```

浏览器测试不下载浏览器；找不到系统Edge/Chrome时，可设置 `BROWSER_PATH`，否则该项明确skip。
真实调用报告写入 `test-results/`；`verify:live-mcp` 可重放已有成功请求验证幂等。

## 业务同学如何参与

- 业务A：产品相关匿名评论、标签、来源和统计口径。
- 业务B：官方产品事实、3个Skill的内容、意图与风险定义、50条金标Case。
- 开发：加载、执行、存储、模型调用、页面与回归。

文件模板在 [`beauty-demo/content/templates/`](beauty-demo/content/templates/)，先阅读 [业务交付模板](beauty-demo/docs/业务交付模板.md) 和 [Skill上传说明](beauty-demo/docs/组员上手与Skill上传.md)。业务同学可直接上传Markdown或ZIP，不需要自行移植后端代码。

## 项目结构

```text
beauty-demo/          主应用：独立用户/运营前端、后端、SQLite、10个MCP工具
typesafe-mcp/         可选的通用Jev evaluate工具，独立于主应用
REQUIREMENTS.md       环境和依赖要求
.github/workflows/   不含密钥、不调用付费API的工程CI
```

## 当前状态与边界

已跑通真实 Jev `jev-1.13.0` → `product_consult` → DeepSeek `deepseek-flash` 的单条调用，并验证 MCP 重放不重复调用模型。
**这不代表已完成50条业务金标验收。** 当前数据、分类、规则与阈值仍是演示版本，需用团队的正式内容替换和评测。
本期范围及待办见 [项目范围与状态](beauty-demo/docs/项目范围与状态.md)。服务器部署后续另配；当前无需服务器即可在各自电脑演示。

### 常见问题

- **不知道运营口令**：后端首次成功启动后，打开本机 `beauty-demo/data/operator-password.txt`。如果明确设置了 `BEAUTY_OPERATOR_PASSWORD`，使用该环境变量的值。不是API Key，也不是开发者电脑的口令。
- **只有用户页，看不到Skill上传**：进入 `/ops/` 并登录；用户页故意不显示后台控件。
- **下载代码后无法智能回答**：仓库不含密钥。先在运营页保存并验证两套API；`configured=true`只是有配置，不代表连接测试通过。
- **回答不知道产品内容**：初始只有虚构样例。补充真正的产品资料或Skill知识；不能要求模型编造没有依据的功效/价格。
- **输入问题提示等待人工**：该会话已被接管，AI会暂停。让坐席处理，或在处理结束后新建咨询。
- **运营API返回401/403**：新版有权限检查。运营页需要登录，MCP需要用户绑定凭据；不要去掉校验来“解决”错误。
- **端口在监听但页面还是旧的**：确认先停止旧服务，再运行新版 `npm run build` 和 `npm start`，随后强制刷新浏览器。
- **PowerShell禁止执行npm.ps1**：可使用 `npm.cmd`（例如 `npm.cmd ci`），或在命令提示符中执行npm命令。Harness脚本受限时可按手工启动步骤使用 `dsh.cmd`。
- `EADDRINUSE`：端口被占用。关闭旧实例，或设置 `PORT` 后启动；MCP同步设置 `BEAUTY_API_URL`。
- `PROVIDER_NOT_CONFIGURED`：后端未读取到密钥。检查本地配置或后端终端的环境变量，重启。
- `degraded`：查看返回的 `warnings`；不是成功生成的答案。
- Harness看不到新工具：确认使用带本项目patch启动的新页面，修改编译代码后重启Harness。
- 组员不能访问你的127.0.0.1：这是本机地址，需要各自运行或后续部署共享后端。

更多说明：[主应用README](beauty-demo/README.md) · [完整流程/API](beauty-demo/docs/阶段三使用.md) · [基础API](beauty-demo/docs/API.md)
