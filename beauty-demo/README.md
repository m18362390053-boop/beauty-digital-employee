# 悦见演示应用 · 源码说明

本目录提供可运行的用户端、运营端、客服与护理服务、Skill、数据存储，以及独立的 USB 设备对接原型。赛事展示以网页流程为主，硬件示例不代表线下整机已经完成。

```text
用户网页 / 运营网页 / 可选 MCP 工具
                   ↓
          Express 业务后端 ── SQLite
                   ├─ Jev：结构化判断与 Skill 路由
                   ├─ DeepSeek：基于资料的客服回复
                   └─ 可选媒体适配接口：按授权调用独立服务

LCD 页面模拟器        USB 电脑网关 ⇄ 实验性固件
```

## 能力与边界

用户端提供咨询、资料卡、商品查找及护理步骤演示；运营端提供知识/Skill 配置、人工接管、反馈与可读运行记录。虚构商品、评论和护理示例用于演示软件流程，不能代替真实 SKU 审核。图片候选及音频转写文本不自动确认产品、不自动完成护理。语音合成后端与设备端播放是两个不同环节；USB 媒体、LCD、触摸及喇叭整合尚未在同一套实板固件上验收。

## 快速启动

Node.js 24.x、npm；在此目录执行：

```sh
npm ci
npm run build
npm run seed:demo
npm start
```

默认仅监听 `127.0.0.1:3090`。用户页 `/chat/`，运营端 `/ops/`，LCD 网页模拟器 `/lcd-demo/`。首次运营口令在 Git 忽略的 `data/operator-password.txt`；演示数据库位于 `data/`。已存在数据库升级前先运行 `npm run backup`。无模型密钥也可体验基础页面与演示数据；真实模型问答需要在运营端配置合法凭据并验证连接。Jev/DeepSeek 配置与可选媒体接口是不同配置，不应互换密钥；仓库不包含私有配置。不要把本机服务直接暴露到公网。

## 验证与代码索引

```sh
npm test
npm run test:ui
python -m unittest discover -s tests -p 'usb*_test.py' -q
```

浏览器测试需要本机 Edge/Chrome，USB 离线测试不要求真实开发板。`server/` 为 API、权限和业务状态；`web/` 为网页；`skill-packages/` 为演示 Skill；`hardware/` 为分阶段固件；`scripts/usb-*.py` 为独立 USB 工具。可选的模型适配实现以 `server/core/` 实际源码为准；不把其他服务能力归于 Jev 或 DeepSeek。

详细 API 与设备协议见 [技术文档导航](docs/README.md)，运行环境见仓库根目录 [REQUIREMENTS.md](../REQUIREMENTS.md)。
