# 悦见｜长辈 AI 美护陪伴

悦见希望让护肤从复杂的产品信息与步骤记忆，变成更容易理解、可以慢慢完成的日常陪伴。面向熟龄用户，演示以**网页为主要体验载体**：读懂需求、找到有来源的说明、分步展示护理流程，并在需要时转交人工。产品展示 PPT 与视频由团队另行提供；本仓库交付可运行的演示源码及可选的硬件对接原型。

## 体验亮点

- **陪伴式咨询**：用户表达需求后，Jev 参与结构化意图与风险判断，DeepSeek 用经筛选的资料生成可追溯的回复；模型不可用时明确降级，不冒充已生成的答案。
- **一看就懂的护理**：包装文字/照片辅助查找演示商品，用户主动进入护理流程；按步展示名称、用法和面部区域示意，完成和撤销均由用户操作。
- **用户与运营双端**：用户可查看咨询、资料和护理记录；运营端管理 Skill、知识资料、人工接管、反馈与运行记录。
- **可扩展的线下形态**：提供 240×284 LCD 网页模拟器、USB CDC 协议/电脑网关及独立固件候选，展示未来小屏陪伴设备的交互方向。

## 展示与实现边界

这是**软件演示和设备对接原型**，不是已经完成实物整机验收的量产产品。演示资料及部分画面使用明确标记的虚构数据；真实商品用法以包装及审核资料为准，不能将示例当成个性化医疗或功效建议。LCD 网页模拟器不等于实体屏幕已经接通；摄像头、麦克风、触摸屏、喇叭尚未在同一份实板固件上完成闭环。照片/录音及外部服务提交需要主动授权，识别/转写不会自动启动护理或记录完成。

主要代码采用 Node.js 24 + TypeScript、Express、SQLite，前端为浏览器页面。演示的客服路由与回复可使用 Jev、DeepSeek；图像理解、转写、语音合成也留有**独立可选的第三方服务适配接口**，实际启用取决于服务器私有配置，并非 Jev/DeepSeek 的实现或替代能力。公开仓库不包含任何模型密钥、设备 token、用户数据或组员私有素材。

## 源码目录

| 位置 | 内容 |
| --- | --- |
| [`beauty-demo/server/`](beauty-demo/server/) | 业务接口、护理状态、模型适配、权限与数据持久化 |
| [`beauty-demo/web/`](beauty-demo/web/) | 用户页、运营页及 LCD 页面模拟器 |
| [`beauty-demo/skill-packages/`](beauty-demo/skill-packages/) | 示例 Skill 和面部区域图示 |
| [`beauty-demo/hardware/`](beauty-demo/hardware/) · [`beauty-demo/scripts/`](beauty-demo/scripts/) | USB 协议候选固件、电脑网关与独立验证脚本 |
| [`beauty-demo/tests/`](beauty-demo/tests/) · [`beauty-demo/docs/`](beauty-demo/docs/) | 自动测试、API/协议与安全边界说明 |

## 本地运行网页演示

需要 Node.js **24.x**、npm；首次在仓库根目录执行：

```sh
cd beauty-demo
npm ci
npm run build
npm run seed:demo
npm start
```

浏览器打开 `http://127.0.0.1:3090/chat/` 体验用户端，`http://127.0.0.1:3090/ops/` 为运营端；首次运营口令在本机 `beauty-demo/data/operator-password.txt`。LCD 页面模拟器位于 `http://127.0.0.1:3090/lcd-demo/`。模型密钥不是运行演示页面的前提；无密钥时智能回复将明确提示降级。只有在持有合法凭据并获得用户授权后才启用相关外部模型能力。不要把私有凭据放到固件、网页或 Git 提交中。

验证：在 `beauty-demo/` 执行 `npm test`；浏览器自动化可运行 `npm run test:ui`（需要本机 Edge/Chrome）。详细环境见 [REQUIREMENTS.md](REQUIREMENTS.md)，工程使用说明见 [应用源码说明](beauty-demo/README.md)，协议与接口见 [技术文档](beauty-demo/docs/README.md)。
