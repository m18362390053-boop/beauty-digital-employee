# 组员上手：让它能回答，再上传自己的Skill

## 先说明上一个版本的问题

上一版没有业务上传入口，Skill被固定在启动JSON中；干净克隆不含密钥，却缺少网页配置入口。
回复执行器还把“必须有产品事实”用于所有场景，导致寒暄和情绪支持也受阻，追问经常重复同一句话。
这轮已补齐配置入口并修复上述条件。具体问题仍取决于模型连接和资料，不能用虚构资料回答真实商品功效。

## 第一次使用（只需一个网页）

1. 安装Node.js 24，进入beauty-demo，运行 `npm ci`、`npm run build`、`npm start`。
2. 用户端是 `http://127.0.0.1:3090/chat/`；运营端是 `http://127.0.0.1:3090/ops/`，使用本机data/operator-password.txt里的口令登录。
3. 运营登录后，如果数据库为空，在“业务配置 · Skill上传”点击“初始化演示数据”。无需先手工编辑数据库。
4. 在同一页填写TypeSafe Key、回复模型Key、Base URL和模型名。
   - DeepSeek官方地址：`https://api.deepseek.com/v1`
   - 模型名：`deepseek-flash`
5. 点击“保存模型配置”，然后“验证连接”。连接测试会产生少量模型调用。
6. 用户在 `/chat/` 发消息；运营也可在“客服测试”用测试用户验证。用户页不显示Key或调试JSON。

缺密钥时会明确告诉你去哪里配置，不会假装模型已经回复。网页保存的设置在data/model-settings.json，重启仍有效，不进入Git。
优先级：网页保存配置 > 启动环境/本地文件配置。修改启动环境但网页配置仍存在时，以网页保存的为准。

## 上传方式一：直接上传 SKILL.md

可用示例在 `content/templates/SKILL.example.md`。最小格式：

```markdown
---
name: gentle-beauty-companion
version: 1.0.0
description: 用户表达美妆挫败、分享心得或想聊聊时，提供温和回应
intents:
  - emotional_support
requiresKnowledge: false
---

# 温和美妆助手
先回应用户感受，再问一个与其原话相关的问题。
不主动推荐产品，不做诊断，不假装真人。
```

在“上传Skill”选择文件，点击“导入并启用Skill”。
没有YAML头的普通Markdown也支持，但需要在页面补填ID和职责描述。
页面字段可覆盖文件里的ID、版本、描述、意图和知识要求。

## 上传方式二：ZIP包含说明和知识

页面提供“下载可直接导入的ZIP模板”，可以先原样上传验证操作，再替换自己的内容。

```text
your-skill.zip
├── manifest.json
├── SKILL.md
└── knowledge/
    └── guide.md
```

manifest示例：

```json
{
  "id": "product-usage-guide",
  "version": "1.0.0",
  "description": "回答本产品的使用顺序、用量与注意事项",
  "intents": ["product_advice"],
  "knowledgeScopes": ["product"],
  "requiresKnowledge": true
}
```

- `SKILL.md` 写“如何处理用户问题”，`knowledge/*.md` 或 `references/*.md` 写实际资料。
- 包内知识会进入被选中Skill的回答上下文，并返回 `skill-…` 来源ID；不是只存文件名。
- ZIP可以有一个外层目录，但只能有一个SKILL.md，文件都应位于同一根目录。
- 支持Markdown、文本、JSON声明；不会执行脚本。assets里的常见图片可被忽略，但不会进行图片识别。
- 单个上传文件最大2MB，ZIP总解压量最多512KB；知识总正文最多120000字符。

也支持上传完整Skill JSON，字段为id/version/description/intents/knowledgeScopes/requiredFields/instructions/requiresKnowledge/knowledge。

## 启用、更新、停用

- 初始有3个内置Skill，现在可以扩展，不再限制恰好3个；最多30个同时启用。
- 上传后立即启用，下一条新咨询就会使用新的注册表，不需要重启。
- 同ID表示更新；如果文件有明确version，修改内容请增加版本（如1.0.0→1.0.1）。
- 未指定version时，根据内容自动生成版本。
- “已注册的Skill”中可查看完整说明、知识及启用状态，也能停用/启用。
- “文档 / 历史版本”可预览SKILL.md、导出ZIP、切换旧版本；“执行记录”保留每次当时实际使用的文档和知识。
- 正在处理的请求使用开始时的配置快照，避免上传过程中半旧半新。
- 相似职责可能竞争路由；优先改清楚description，或替换同职责的旧Skill，不要堆放多个完全相同的描述。

## 意图与知识要求怎么填

当前业务意图仍为product_advice、after_sales、emotional_support、safety。新Skill选择其中一个或多个，不需要自己写Jev分类代码。

- 产品功效、成分、售后政策：通常 `requiresKnowledge: true`，提供对应知识。
- 寒暄、情绪承接、服务引导：通常 `requiresKnowledge: false`。
- 缺知识不等于可以编造；系统会针对问题说明缺失内容或追问。
- 高风险/明确人工请求仍优先进入人工流程，Skill不能覆盖这个优先级。

## 怎样证明上传真的生效

1. 上传模板ZIP，确认列表里出现 `beauty-usage-guide · 已启用`。
2. 发：“演示套装里，演示精华和演示面霜应该怎么安排顺序？”
3. 查看处理结果的 `generation.skillId` 与 `sourceRefs`。
4. 被选择的应是已上传Skill，引用应包含 `skill-…`，回答应与knowledge文件内容一致。
5. 本轮真实模型验证已经完成该路径，另外验证了寒暄、情绪表达和缺售后资料时的具体追问。

## 排查顺序

1. 先看“业务配置”的模型状态，并点击真实连接测试。
2. 再看Skill是否启用、职责描述是否匹配。
3. 产品事实不在资料中时，补知识；不要把模型拒绝编造视为接口没工作。
4. 检查会话是否已转人工或结束，必要时新建会话。
5. 查看结果的warnings、route.reasonCodes和generation.skillId。

本地API：`GET /api/skills`、`POST /api/skills/import`、`PATCH /api/skills/:id`、`GET/PUT /api/settings/models`、`POST /api/settings/models/check`。

## API已经配置却报错？

- `configured=true`仅表示已经读取配置；点击“验证连接”才会实际请求两家服务。
- `PROVIDER_NOT_CONFIGURED`：缺少配置。
- `PROVIDER_HTTP_401`：对应服务拒绝凭据。
- `PROVIDER_UNAVAILABLE`：请求连接失败；看diagnostics.stage确定Jev还是回复服务，以及networkCode是否有具体原因。
- 连接恢复后发送一条新消息。旧失败记录会保留，相同requestId的重放仍返回原结果。
- 可运行 `npm run diagnose:recent` 读取最近运行的状态，不会显示密钥或重新调用模型。
