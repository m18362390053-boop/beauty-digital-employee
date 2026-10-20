# 后端 API 概览

默认仅在 `http://127.0.0.1:3090` 提供本机服务；`GET /health` 为健康检查。实际请求校验和返回结构以 [`server/app.ts`](../server/app.ts)、[`server/customer-api.ts`](../server/customer-api.ts) 和对应的服务/契约源码为准。不是面向公网部署的开放 API。

| 范围 | 代表接口 | 用途 |
| --- | --- | --- |
| 用户身份 | `/api/auth/customer/*`、`/api/customer/bootstrap` | 浏览器 Cookie 绑定用户；修改请求使用 CSRF 保护 |
| 用户咨询 | `/api/customer/sessions`、`/api/customer/sessions/:sessionId/consult` | 咨询、消息与来源记录；只能访问本人的会话 |
| 资料与护理 | `/api/customer/card`、`/api/customer/routines/*`、`/api/customer/care-events` | 用户资料、步骤、确认与撤销 |
| 图片与声音 | `/api/customer/packaging/recognize`、`/api/customer/speech/*` | 本次明确授权后请求已配置的媒体服务；不可由识别文字自动完成护理 |
| 运营端 | `/api/auth/operator/*`、`/api/skills/*`、`/api/ops/*` | 登录、Skill、人工接管、审核资料和运行记录 |
| 设备端 | `/api/device/routines/*`、`/api/device/media/*`、`/api/device/speech/synthesize` | 仅绑定用户的设备凭据可访问，凭据保存在电脑端 |

例如设备确认步骤：在网页由用户选定演示商品、启动流程后，绑定用户的设备网关读取 `GET /api/device/routines/current`，再使用 `POST /api/device/routines/:routineId/actions` 发送 `{ "requestId": "tap-001", "expectedStep": 0, "action": "confirm" }`。相同请求编号用于重试以避免重复记账；`repeat` 不会记完成。运营端凭据、用户浏览器身份、设备 token 与模型 Key 不能互换。

演示商品为虚构资料；真实商品护理须有经过审核的资料、产品版本及适用时段。静态 LCD 网页预览 `/lcd-demo/` 不会调用这些设备 API 或写入护理记录。设备消息格式见 [USB v3 协议](ESP32S3-统一USB协议v3.md)。
