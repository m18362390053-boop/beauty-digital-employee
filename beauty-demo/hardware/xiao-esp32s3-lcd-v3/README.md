# v3 状态 → 实体 LCD 显示候选固件（尚未实板验证）

与 `scripts/usb-unified-gateway.py` 中的 `get/state` 和 `task candidate_ready/transcript_ready` 对接：USB CDC 发送 v3 `get`，接收带商品名、步数、指导文字的 JSON 行并绘制在 240×284 ST7789 屏上；UTF-8 使用 Arduino_GFX + U8g2 的 GB2312 字体。屏幕保持连接/断线提示、只在内容变化时更新，长文字按页切换。`screen=home` 时不继续显示旧步骤。**代码只显示，不发送触摸动作，不触发摄像头/麦克风，也不处理二进制 TTS 下行**；本目录不能冒充全输入/输出整机固件。

本候选工程根据组员报告 H03 引脚写出 `SCK=7 MOSI=9 CS=1 DC=2 RST=4 BL=3`、显示分辨率 240×284、rotation=0。**尚未获得 H03 实际 `usb_lcd_test` 源码，无法核实 `Arduino_ST7789` 控制器构造参数、偏移、背光极性、供电和中文字体是否与实板一致**。不要直接覆盖、烧录或拔改已经通过的 H03/H04；由 B 在独立工程里对比实际驱动/接线后再编译、烧录与拍照记录。GPIO1 被 LCD CS 使用，不能沿用第一阶段 D0 重说按键。未确认电平/电源前不要上电。

依赖：Arduino ESP32 3.x、ArduinoJson 7.x、GFX Library for Arduino 1.4.9、U8g2。USB CDC On Boot Enabled。此环境本机没有 Arduino CLI/开发板，**尚未编译或实板显示**。切勿与 v1 桥接、媒体 v2 试验固件混用；v3 网关只有在实际配对固件和端口确认后才可启动。

下一步请 B 提供 H03/H04 的驱动初始化和触摸工程源码，以实际屏幕偏移/字体配置替换候选值，核验实板断线、中文换行、长文翻页，然后将触摸和媒体收发按 [`v3 协议`](../../docs/ESP32S3-统一USB协议v3.md) 合入，单独验收。
