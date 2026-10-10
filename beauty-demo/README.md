# 美妆客服 Demo · Harness + 独立业务后端

美妆客服比赛Demo。现已拆分用户客服端与运营端，提供权限校验、可读执行记录、Skill版本预览/导出/回滚，以及有来源的多商品推荐卡。业务内容仍是明确标注的演示样例。

```text
DeepSeek Harness → MCP工具 ─┐
                          ├→ 同一个客服后端 → SQLite
用户端 / 运营端 ────────────┘      ├→ TypeSafe Jev判断
                                ├→ Skill + 审核资料 + 回复模型
                                └→ 风险规则 / 人工状态 / 反馈 / 看板
```

## 已实现

- **业务配置页面**：模型设置与实际连接验证、Markdown/JSON/ZIP Skill上传、随包知识、即时启停。详见 [组员上手](docs/组员上手与Skill上传.md)。

- 产品知识/匿名评论JSON导入、来源和版本校验、事务与去重。
- 用户卡、版本检查、跨会话记忆、会话消息和咨询请求幂等性。
- 默认3个Skill，可上传扩展；4类意图、情绪、3级风险；Jev API适配与原始路由记录。
- 审核资料按Skill范围筛选、OpenAI兼容回复接口、引用ID校验、明确的失败降级。
- Jev路由保留已匹配Skill；导购Skill可声明商品类别和最多追问轮数。商品卡只从已审核商品资料生成，并在用户端显示来源。
- 风险规则优先、AI暂停、待人工/人工中/已结束状态、来源消息摘要、真实本地坐席回复。
- “有帮助/没解决/转人工”反馈，可替换不重复计数；评论与服务数据分区的追溯看板。
- 用户端只显示自己的聊天/资料/反馈；运营端提供模型/Skill/坐席/看板/测试和执行记录。另有10个Harness MCP工具。
- schema v1/v2/v3→v4迁移，包含访问会话、用户绑定MCP凭据、运行事件与文档快照。

## 当前边界

- `config/business.demo.json` 是**开发用暂定配置**，不是业务B审核完成的内容；阈值未用真实金标校准。
- 当前样例为1个基础虚构产品、2个虚构演示口红和3条虚构评论；商品卡只用于验证流程，业务需交付真实商品、审核资料、至少200条匿名评论和50条Case。
- **已完成真实模型端到端冒烟联调**：Jev `jev-1.13.0` → `product_consult` → DeepSeek `deepseek-flash`，返回有来源的生成回答；约1.7秒。单条演示请求不代表业务准确率验收。
- 未配置密钥时，普通问题明确返回 `degraded` 模板；明确风险和人工请求仍能走真实本地接管流程。
- 人工摘要用来源消息模板，不自动推断症状起始时间；坐席需查看原话核实。
- 当前评论用于限量证据上下文和确定性标签统计；独立洞察JSON导入、CSV、完整文本检索尚待后续。
- 已实现匿名浏览器身份、运营登录、CSRF与用户归属校验；不是完整的多坐席账号平台。默认仍只监听127.0.0.1。

## 启动后端和页面

在本目录打开PowerShell：

```powershell
npm ci
npm run build
# 仅初始化虚构演示库；已导入过可重复执行
npm run seed:demo
# 将新版导购Skill和两件演示口红同步到已有演示数据库
npm run sync:recommendation-demo
npm start
```

- 用户客服：http://127.0.0.1:3090/chat/
- 运营工作台：http://127.0.0.1:3090/ops/（口令见本机data/operator-password.txt）
- 健康检查：http://127.0.0.1:3090/health
- 模型/策略配置状态在运营端查看，API需要运营登录。
- 默认数据库：`data/beauty.sqlite`，重启自动恢复已保存资料。
- `npm run dev` 可在开发时自动重启；Ctrl+C停止服务。
- 端口或数据库可通过 `PORT`、`DATABASE_PATH` 设置；`.env.example`只作说明，不自动加载。

## 配置真实模型

推荐登录运营端，在“业务配置”直接填写密钥和模型参数，保存后验证连接，无需重启。运营口令不是模型Key。
设置保存在data/model-settings.json，不回显密钥，不进入Git；网页保存值优先于下列文件/环境配置。

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
Jev负责结构化判断，回复模型负责生成答案，二者各自计费。仅对明确发生在建立连接前的DNS/连接错误重试一次；不自动重试HTTP拒绝、用户取消或可能已计费的断连。
策略文件用 `BUSINESS_CONFIG` 指定；本地运行配置用 `BEAUTY_LOCAL_CONFIG` 指定，默认可选加载 `config/local.json`。改配置后需重启。
产品知识仍只读取approved条目。策略reviewStatus用于标识版本状态，不再阻塞全部business资料。演示策略为demo-policy-v3，上传Skill后版本附加内容指纹，阈值未降低。
推荐商品在产品JSON中使用可选的 `recommendation` 字段，包含 `category`、`shade`、`texture`、`keywords`、指向已审核事实的 `sourceId`，以及可选的HTTPS `imageUrl`、`price`。导购Skill的 `manifest.json` 可声明 `recommendation: {"category":"口红","maxClarifications":1}`。仅导入该Skill不会自动生成商品卡，还需导入带已审核事实的商品资料；业务商品与演示商品不能混在同一数据库。`npm run check:recommendation-live` 可用独立验收用户进行一次实际模型联调。
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
npm test            # 54项接口/权限/版本/路由/网络/MCP测试；不消耗模型额度
npm run test:ui     # 本机Edge/Chrome浏览器验收；生成test-results/ui-demo.png
npm run smoke:mcp   # 对运行中的后端做只读MCP验证
npm run eval:route  # 离线规则冒烟：未调用Jev的案例明确标记not_run
npm run backup     # 一致性备份到data/backups，含WAL已提交内容
npm run check:config # 只检查本地加载状态，不打印密钥、不调用模型
npm run check:live   # 一条真实咨询，会消耗少量Jev和回复模型额度
npm run check:authoring # 四类组员使用场景的真实模型验证
npm run diagnose:recent # 只读最近5条运行记录，显示失败阶段和错误码
npm run mcp:token -- --user demo-user-a # 为本机Harness申请绑定用户的后端访问凭据
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
- `web/customer/`：用户前端；`web/operator/`：运营前端；`web/shared/`：公共主题。
- [双端权限与Skill验收](docs/双端权限与Skill验收.md)：角色、登录、版本和执行证据。
- `tests/`：隔离自动测试；`evals/`：开发冒烟案例，不冒充金标。
