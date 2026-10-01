# 在 Harness 中调用客服数据与完整咨询

## 已接通的链路

```text
DeepSeek Harness（新实例默认3002）
  → @deepseek-ai/dsh-mcp-client
    → 本地stdio MCP子进程
      → HTTP API（默认127.0.0.1:3090）
        → 原有SQLite数据库
```

MCP只调用HTTP，不直接打开数据库，因此与网页、API使用同一份数据。
现已提供完整的 `customer_service_consult` 及人工/反馈入口，执行路径与Web页面相同。
是否真正调用模型看返回的route/status，后端未配置密钥时明确降级。

## 启动

1. 保持原来的 `beauty-demo` 服务运行在3090。如果没有运行，在项目目录执行 `npm start`。
2. 在beauty-demo目录的另一个PowerShell窗口执行：

```powershell
.\start-harness.ps1
```

脚本会检查数据库健康、绑定用户及产品，然后启动带有新MCP配置的Harness。
使用这次自动打开的网页，或终端打印的带token完整地址；新会话选择标准模式和已配置好的DeepSeek模型。
数据工具不需要TypeSafe Key。Harness自身的模型仍使用你已经配置的模型凭据。
保持两个终端窗口运行；关闭Harness不会停止3090后端。

默认绑定 `demo-user-a`。绑定身份由启动配置决定，不接受模型传入任意userId。
用户B隔离演示可以用 `-UserId demo-user-b -Port 3003` 启动另一个Harness实例。
这是本机演示身份隔离，尚不是正式登录认证。

等价命令：

```powershell
dsh --profile web --patch ./harness.patch.yml --host 127.0.0.1 --port 3002
```

可通过 `BEAUTY_API_URL`、`BEAUTY_USER_ID` 改变MCP连接配置；启动脚本则使用对应参数。
启动脚本自动传入编译入口绝对路径，移动目录无需修改patch。手工运行等价命令时应位于beauty-demo目录；其他目录启动可显式设置 `BEAUTY_MCP_ENTRY`。

## 工具清单

| Harness工具名 | 功能 | 是否写数据 |
|---|---|---|
| `mcp__beauty__get_context` | 读取绑定用户卡、审核产品资料及来源；可附带指定会话上下文 | 否 |
| `mcp__beauty__get_comments` | 分页查询匿名评论、标签和来源 | 否 |
| `mcp__beauty__list_sessions` | 找回当前用户会话 | 否 |
| `mcp__beauty__create_session` | 创建新会话，用户卡保持共享 | 是 |
| `mcp__beauty__record_message` | 保存用户原话，返回可追溯messageId | 是 |
| `mcp__beauty__update_card` | 保存用户确认的偏好/事实，带版本检查 | 是 |
| `mcp__beauty__customer_service_consult` | Jev路由、Skill回复、风险和人工流程 | 是，可调用付费模型 |
| `mcp__beauty__consultation_status` | 查询咨询运行/原结果 | 否 |
| `mcp__beauty__request_handoff` | 暂停AI并请求本地人工 | 是 |
| `mcp__beauty__submit_feedback` | 保存或替换反馈，必要时进入人工流程 | 是 |

原先的 `mcp__typesafe__evaluate` 来自另一个patch，本启动配置加载的是beauty数据工具。
如果需要同时保留原工具，可在等价命令中另加原 `typesafe-mcp/harness.patch.yml` 的 `--patch`，并在该终端设置原有 `TYPESAFE_API_KEY`。

## 验收提示词

### 完整客服流程

> 请先用mcp__beauty__create_session创建会话，再调用mcp__beauty__customer_service_consult，传入原话“用了以后脸肿了，请转人工”。保留返回的风险提示和状态，展示真实runId与handoffId。如果是rule_override，说明是规则命中；如果是pending，只能说等待人工，不要继续推荐产品。

该演示通过显式规则即可完成，不消耗Jev或回复模型额度。人工接管可在 http://127.0.0.1:3090/demo/ 操作。
普通问题要真实调用Jev和回复模型，需在3090后端终端配置两套密钥，详见README。

### 1. 只读验收

> 请实际调用 mcp__beauty__get_context 和 mcp__beauty__get_comments。告诉我当前绑定用户ID、数据卡版本、产品名称、已审核事实数量、评论总数，以及dataKind。请保留来源ID，并明确这些数据是真实还是虚构示例。不要模拟结果，也不要修改数据。

预期：用户demo-user-a、演示产品、1条已审核事实、3条评论、dataKind=demo。
数据卡版本可能随之前修改而变化，不应硬编码为0。

### 2. 写入与跨会话验收

> 我确认要保存一个演示偏好：“偏好清爽”。请先读取我的数据卡，再创建一个客服会话，把这条原话记录进去，并保留原有有效信息更新资料卡。使用记录返回的messageId作为事实来源。随后再创建第二个会话，调用get_context读取它，检查同一偏好是否被带入。展示真实的两个sessionId、messageId和更新后的数据卡版本。不要声称已执行Jev业务路由或专家Skill。

预期：两个sessionId不同，第二个会话消息为空但用户卡含新偏好；新偏好已写入SQLite。
可以刷新 `/api/users/demo-user-a/card` 独立核对实际保存结果。

### 3. 后端中断验收

> 实际调用get_context；如果服务不可用，请报告工具的真实错误，不生成替代数据。

暂停3090服务时应返回失败工具结果；重启服务后再次调用可恢复。

## 验证命令

```powershell
npm test
npm run smoke:mcp
```

- 测试使用临时数据库和真实MCP子进程，验证读写、来源、用户隔离、版本冲突、超时和取消。
- `smoke:mcp` 需要3090服务运行，只调用get_context/get_comments，不修改用户资料、不请求付费模型。
- `npm run mcp` 是stdio服务入口，通常由Harness启动；直接运行后等待输入是正常行为，不是网页服务。
- 编译或修改MCP代码后重启对应Harness实例，以加载新的子进程代码。
- 新consult工具请求上限55秒，Harness工具超时75秒；原数据工具仍为10秒HTTP上限。

## 常见错误

- `BACKEND_UNAVAILABLE`：3090未启动或地址不匹配。
- `PRODUCT_SETUP_REQUIRED`：数据库没有唯一产品，先导入资料。
- `USER_NOT_FOUND`：绑定用户不存在；演示库先执行 `npm run seed:demo`，业务库应创建对应用户。
- `CARD_VERSION_CONFLICT`：版本已更新；重新读取、保留仍有效内容后再保存。
- `SESSION_NOT_FOUND`：会话ID不属于当前绑定用户或不存在。
- Harness找不到工具：确认是新启动的带beauty patch页面，而不是原3000/3001实例。

工具异常使用MCP `isError: true` 返回；不会自动重试写请求。超时/取消不保证远端写操作未发生，先查询状态再决定是否重试。
