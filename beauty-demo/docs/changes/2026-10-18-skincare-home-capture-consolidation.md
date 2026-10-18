# 护肤双面识别与首页凝珠版本整合

**整合分支：** `feature/skincare-home-capture-consolidation`

**代码来源：** `feature/skincare-milestone-video-skill` 与 `feature/home-portal-crystal-interaction`

## 本版本包含

- 护肤品录入支持正面与背面分开拍摄/选图；先做本机文字读取，另经单独授权后可调用已配置的视觉识别服务。
- 将识别候选与欧莱雅资料卡匹配，提供类别、产品名、使用部位和时段建议；由用户核对后保存，并通过共享日程同步到电脑顾客端。
- 开封后建议期限可以留空；未开封期限不会冒充开封后期限。资料卡来源及冲突会显示给用户核对。
- 首页三颗凝珠在悬停、键盘聚焦、点击选中时提亮并降低金色饱和度；文字保持黑色，焦点提示由凝珠光效呈现，底色、布局和入口行为不变。

## 主要实现文件

- `web/customer/skincare-schedule.js`
- `web/customer/loreal-product-cases.js`
- `web/customer/index.html`
- `web/customer/customer.css`
- `web/customer/app.js`
- `server/customer-api.ts`
- `web/customer/motion/home-portal.css`

本次整合没有新增或修改 Jev 路由、多 skill 命中逻辑。整合分支从已包含这些功能版本的功能分支派生；基线中的既有历史保留原样。

## 验证记录

双面识别和共享日程版本已通过 TypeScript 构建、`git diff --check`，并在本地顾客端预览检查；首页凝珠版本已在浏览器预览检查键盘聚焦效果。真实商品照片仍需在 OPPO 手机上完成端到端识别验收。
