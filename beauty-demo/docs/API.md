# 基础API v0.1

本文保留基础数据接口。新增咨询、人工、反馈、看板接口见 [阶段三使用](阶段三使用.md)，数据库当前schemaVersion为2。

基址：`http://127.0.0.1:3090`。请求采用JSON；错误统一 `{ "error": { "code", "message", "traceId", "issues"? } }`。
422的 `issues[].path` 可定位到如 `comments.1.sourceRef` 的具体输入；验证失败整批不写入。
ID只允许字母、数字、下划线、短横线，最长100字符。示例请求可参考数据模板。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 数据库可用状态，不调用模型 |
| GET | `/api/products` | 当前单产品信息 |
| POST | `/api/imports/products` | 导入产品JSON，新版本成为当前版本 |
| GET | `/api/products/:productId/knowledge` | 已审核事实及其来源，明确demo/business |
| POST | `/api/imports/comments` | 导入评论JSON批次 |
| GET | `/api/products/:productId/comments?limit=50&offset=0` | 评论分页、来源、首次导入批次 |
| GET | `/api/users` | 演示用户列表 |
| POST | `/api/users` | `{ "userId"?: "id", "displayName": "名字" }` |
| GET | `/api/users/:userId/card` | 用户卡，含版本 |
| PATCH | `/api/users/:userId/card` | 确认或修改用户卡 |
| POST | `/api/users/:userId/sessions` | `{ "productId": "..." }`，新建会话 |
| GET | `/api/users/:userId/sessions` | 仅该用户的会话 |
| POST | `/api/users/:userId/sessions/:sessionId/messages` | `{ "requestId": "...", "content": "..." }`，仅保存用户消息 |
| GET | `/api/users/:userId/sessions/:sessionId/messages?limit=50&offset=0` | 分页读取消息 |
| GET | `/api/users/:userId/sessions/:sessionId/context` | 会话、当前用户卡、最近20条消息 |

## 导入与版本规则

- 每库只支持一个产品；换真实产品使用新的 `DATABASE_PATH`，避免混入样例。
- 同产品同版本同内容重复导入返回 `unchanged`，不同内容返回409；改内容请增加版本。
- 重导入旧版本不会将当前版本回滚。
- 知识接口只返回 `approved`；没有已审核事实返回 `status: insufficient_evidence`。
- 评论批次重复导入不增加记录；已有评论ID且内容/标签/来源一致则跳过。
- 同评论ID对应不同内容时409，整批回滚，包括冲突之前已处理的行。修订工作流后续实现。
- 不自动按相同正文删除评论：不同用户可能写相同短句，业务清洗要分配稳定ID。
- 评论来源表保留在导入批次和逐条查询结果中。未知发布日期必须为null。
- `dataKind` 不匹配会409；demo资料必须与真实business资料隔离。
- 第一阶段支持JSON；CSV转换和文件上传界面尚未实现。

## 用户卡更新

```json
{
  "expectedVersion": 0,
  "confirmedFacts": {
    "skinType": { "value": "用户自己确认的倾向", "sourceMessageId": null }
  },
  "preferences": ["用户确认的偏好"],
  "concerns": []
}
```

`expectedVersion` 必须匹配当前卡，否则409要求重新读取；成功版本加一。
省略的字段保持原值，提供的对象/数组**整体替换**；传空对象/空数组可清空相应内容。
`sourceMessageId: null` 表示手工确认，有ID时必须是同一用户的原话消息。
数据库保留修订快照；此阶段不提供正式个人数据删除/清理接口。

## 消息和归属

仅接受 `requestId` 与 `content`，不允许客户端伪装 `assistant` 或 `human` 角色。
同会话同 `requestId` 同内容返回同一 `messageId`，重复提交不同内容返回409。
会话ID与路径userId不匹配时返回404，读消息、写消息、读取上下文均检查。
这些检查是数据归属保护，不代替登录认证；同机演示操作者可以选择任意演示用户。
当前消息返回 `processing: not_implemented`，没有业务路由或AI回复。
