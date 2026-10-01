# 美妆客服 Demo · Harness + 独立业务后端

单产品美妆客服比赛Demo。当前已具备可执行的客服工作流和四个演示页面，业务内容仍是明确标注的演示样例。项目范围见 [项目范围与状态](docs/项目范围与状态.md)。

```text
DeepSeek Harness → MCP工具 ─┐
                          ├→ 同一个客服后端 → SQLite
四个Web演示页面 ───────────┘      ├→ TypeSafe Jev判断
                                ├→ Skill + 审核资料 + 回复模型
                                └→ 风险规则 / 人工状态 / 反馈 / 看板
```

## 已实现

- 产品知识/匿名评论JSON导入、来源和版本校验、事务与去重。
- 用户卡、版本检查、跨会话记忆、会话消息和咨询请求幂等性。
- 3个可配置Skill、4类意图、情绪、3级风险；Jev API适配与原始路由记录。
- 审核资料按Skill范围筛选、OpenAI兼容回复接口、引用ID校验、明确的失败降级。
- 风险规则优先、AI暂停、待人工/人工中/已结束状态、来源消息摘要、真实本地坐席回复。
- “有帮助/没解决/转人工”反馈，可替换不重复计数；评论与服务数据分区的追溯看板。
- 四个Web页面，以及10个Harness MCP工具（含完整 `customer_service_consult`）。
- schema v1→v2迁移、SQLite一致性备份、进程中断恢复、取消和迟到结果拦截。

## 当前边界

- `config/business.demo.json` 是**开发用暂定配置**，不是业务B审核完成的内容；阈值未用真实金标校准。
- 当前样例为1个虚构产品、3条虚构评论；业务需交付真实资料、至少200条匿名评论和50条Case。
- **已完成真实模型端到端冒烟联调**：Jev `jev-1.13.0` → `product_consult` → DeepSeek `deepseek-flash`，返回有来源的生成回答；约1.7秒。单条演示请求不代表业务准确率验收。
- 未配置密钥时，普通问题明确返回 `degraded` 模板；明确风险和人工请求仍能走真实本地接管流程。
- 人工摘要用来源消息模板，不自动推断症状起始时间；坐席需查看原话核实。
- 当前评论用于限量证据上下文和确定性标签统计；独立洞察JSON导入、CSV、完整文本检索尚待后续。
- 本机演示身份与坐席页不提供生产登录/权限隔离；监听固定为127.0.0.1。

## 启动后端和页面

在本目录打开PowerShell：

```powershell
npm ci
npm run build
# 仅初始化虚构演示库；已导入过可重复执行
npm run seed:demo
npm start
```

- 四页工作台：http://127.0.0.1:3090/demo/
- 健康检查：http://127.0.0.1:3090/health
- 模型/策略配置状态：http://127.0.0.1:3090/api/status
- 默认数据库：`data/beauty.sqlite`，重启自动恢复已保存资料。
- `npm run dev` 可在开发时自动重启；Ctrl+C停止服务。
- 端口或数据库可通过 `PORT`、`DATABASE_PATH` 设置；`.env.example`只作说明，不自动加载。

## 配置真实模型

可通过 `config/local.json` 引用仓库根目录的两份本地密钥文件：`typesafe_apikey.txt`、`deepseek_api.txt`。
启动时只读取到进程环境，不复制密钥内容；配置文件和密钥文件均已加入Git忽略，仓库不含这些文件。
填写本机密钥并复制配置后，`npm start` 会加载模型配置。示例模型名是 `deepseek-flash`，采用非思考模式与JSON输出。

交付组员时，复制 `config/local.example.json` 为本机的 `config/local.json`，修改文件路径；路径相对于该配置文件解析。
也可以使用下面的环境变量方式，**已有环境变量优先于密钥文件**。它们应设置在启动3090后端的终端，不只是Harness终端。

```powershell
$secret = Read-Host 'TypeSafe API Key' -AsSecureString
$env:TYPESAFE_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
$secret = Read-Host 'Chat provider API Key' -AsSecureString
$env:CHAT_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
$env:CHAT_BASE_URL = 'https://api.deepseek.com/v1'
$env:CHAT_MODEL = Read-Host 'Chat model available in your account'
npm start
```

`CHAT_BASE_URL` 也可以使用其他实际支持OpenAI Chat Completions的服务；具体模型名按账号可用列表填写。
Jev负责结构化判断，回复模型负责生成答案，二者各自计费。当前没有自动重试付费请求。
策略文件用 `BUSINESS_CONFIG` 指定；本地运行配置用 `BEAUTY_LOCAL_CONFIG` 指定，默认可选加载 `config/local.json`。改配置后需重启。
真实business产品必须配 `reviewStatus: reviewed` 的已审核策略。演示策略当前为 `demo-policy-v2`，修正了基础介绍和信息充分性的判断口径，未降低置信度阈值。
单次咨询整体上限45秒（Jev15秒、回复25秒）；取消会传播，并在人工接管后阻止迟到回答。

## 在Harness中调用

保持后端运行，在beauty-demo目录另开PowerShell执行：

```powershell
.\start-harness.ps1
```

使用新打开的3002网页。默认绑定 `demo-user-a`，更新代码后要重启Harness以加载新的MCP子进程。
工具与提示词见 [Harness接入](docs/Harness接入.md)，完整流程见 [阶段三使用](docs/阶段三使用.md)。

## 验证与备份

```powershell
npm test            # 35项接口/存储/路由/状态机/MCP/凭据加载测试；不消耗模型额度
npm run test:ui     # 本机Edge/Chrome浏览器验收；生成test-results/ui-demo.png
npm run smoke:mcp   # 对运行中的后端做只读MCP验证
npm run eval:route  # 离线规则冒烟：未调用Jev的案例明确标记not_run
npm run backup     # 一致性备份到data/backups，含WAL已提交内容
npm run check:config # 只检查本地加载状态，不打印密钥、不调用模型
npm run check:live   # 一条真实咨询，会消耗少量Jev和回复模型额度
```

`test:ui`优先使用系统Edge/Chrome；其他位置通过 `BROWSER_PATH` 指定，无浏览器时明确skip。
付费路由评测需显式 `npm run eval:route -- --live --cases 路径.json`；它只检查路由字段，不等于回复质量或50条业务验收。
`npm run verify:live-mcp -- test-results/live-check-<requestId>.json` 可重放已有成功请求，验证MCP返回同一runId和答案，不发起新的模型调用。

## 关键文档与目录

- [项目范围与状态](docs/项目范围与状态.md)：团队范围、实现状态和待办。
- [本轮验收记录](docs/验收记录.md)：真实做过的验证及未验证事项。
- [业务交付模板](docs/业务交付模板.md)：组员填写资料的格式。
- `server/core/`：Skill注册、Jev/回复适配、客服编排与契约。
- `server/storage/`：基础数据、运行记录、人工接管、反馈与统计。
- `server/mcp/`：Harness工具入口；不直接访问数据库。
- `web/`：四页工作台；`config/`：暂定业务配置。
- `tests/`：隔离自动测试；`evals/`：开发冒烟案例，不冒充金标。
