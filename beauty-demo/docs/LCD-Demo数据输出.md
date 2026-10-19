# LCD Demo 数据输出（USB，本机桥接）

浏览器中的 240×284 全流程模拟器：启动本机服务后打开 `/lcd-demo/`（默认 `http://127.0.0.1:3090/lcd-demo/`）。主页可分别走包装识图（拍摄同意→外发同意→候选核对）、语音输入（录音同意→外发同意→草稿人工修改→主动发送咨询）、护理步骤、咨询/朗读状态和悦见时刻。**模拟器是独立的静态演示页**，不读取本段桥接状态、不连接设备、不申请摄像头或麦克风、不调用真实模型、不写护理记录；转写草稿在页面右侧控制区手动修改。

这是展示用的**可选**扩展，不是实际打卡统计或已审核商品用法。默认桥接输出不变；用 `python scripts/usb-bridge.py --port COM3 --token-file data/device-token.txt --lcd-demo` 启动后，板子发 `{"v":1,"type":"get"}`，电脑从绑定用户的当前护理流程获取步骤，在原 `state` 帧上增加展示字段。端口号按实际设备调整；先在网页启动虚构演示商品护理。只有电脑持有设备 token，不使用 Wi-Fi。

活动中的示例（产品名、步骤编号、总步数、指导文字以实际后端为准）：

```json
{"v":1,"type":"state","routineId":"...","status":"active","step":0,"instruction":"轻轻清洁面部。","eventId":"","requestId":"","screen":"routine_step","demo":true,"stepCount":2,"productName":"虚构演示洁面","streakDays":4,"weekCount":5,"bedtime":"23:00","areaLabel":"区域以已确认步骤为准","region":null,"buttons":["repeat"]}
```

`step` 从 0 开始，LCD 显示时用 `step+1`（例如“第 1 步 / 2 步”）。`productName` 和 `instruction` 来自当前流程快照；`streakDays=4`、`weekCount=5`、`bedtime=23:00` 是固定的 **Demo 占位值**，须在屏幕上标注“演示”，不要作为真实记录或习惯建议。`region=null` 表示目前没有经核对的部位编码，不应凭商品名自动高亮全脸/眼周。`areaLabel` 也是占位提示。无活动流程时 `status=idle,screen=waiting,demo=true`；不应显示上一次的商品或完成画面。`voiceText` 暂不下发；电脑生成 MP3 不等于设备可以播放。

**按钮边界：**目前正式 `usb-bridge.py` 仍只接收 `repeat`；`--lcd-demo` 只增加状态字段，不开放 `confirm/skip/stop`，也不写入完成记录。屏上不要把未接通的“好了”画成可点击按钮。组员若用 H04 独立网关演示四动作，需按其固件/网关配对及真人触摸验收，不能把这份第一阶段桥接与 H04 固件混跑。

本仓库没有组员的 LCD 固件工程，以上新增字段**只通过电脑端离线测试**；组员应在其 LCD 工程中实现 `demo` 标识和步骤显示，并检查额外字段能否被现有解析器接受、串口帧上限、中文渲染、更新/断线行为。未获实板证据前不能标记 LCD 新布局完成。正式 SKU、按摩/冲洗内容和用户作息由后续资料/偏好提供，此 Demo 不做推断。
