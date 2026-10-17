# 悦见硬件清单与开测边界（USB，不用 Wi‑Fi）

此文件供组员在**拿到实物时核对型号并开始第一阶段 USB 测试**。不是已验证的接线图。详细操作见 [ESP32S3 USB 本地联调](../docs/ESP32S3-USB本地联调.md)。2026-10-17：尚无开发板串口、编译烧录或外设接线实测。

| 模块 | 信息来源与已知项 | 目前如何处理 |
| --- | --- | --- |
| Seeed XIAO ESP32S3 Sense | [官方入门](https://wiki.seeedstudio.com/cn/xiao_esp32s3_getting_started/)；实物照片可见 XIAO ESP32S3 主板和摄像头扩展板 | 核对 USB 数据线、扩展板牢固连接。官方资料说明 Sense 扩展板含 PDM 麦克风与 microSD 卡槽，照片不等于各器件已实测。摄像头型号按**实物**核对，不能只按批次介绍推断。 |
| PDM 麦克风 | [Seeed 麦克风教程](https://wiki.seeedstudio.com/xiao_esp32s3_sense_mic/)给出 GPIO42 时钟、GPIO41 数据及 16 kHz/16 位单声道 WAV 示例 | 本阶段不录音；将来另做 USB 媒体传输协议。 |
| microSD/TF | 官方 Sense 扩展板为 microSD 卡槽，教程建议 FAT32、至多 32 GB | USB 基础测试**不需要卡**；日后使用须核对 SD 与 LCD 等 SPI 模块引脚冲突。 |
| HENOPI-98357 I²S 功放及喇叭 | 商家描述 + 组员照片可见功放排针、喇叭插头；照片上有 `VCC/GND/BCLK/LRC/DIN` 等标记 | 具体供电和排针方向须以**商家规格/模块丝印**核对；I²S 需要解码后 PCM，不是把 MP3 文件字节直接送给功放。尚未接线。 |
| 1.83 英寸触摸 LCD | 组员照片背板写 `1.83inch Touch LCD Module 240 × 284 Pixels`；能辨出 `LCD_DIN/CLK/CS/DC/RST/BL`、`TP_SDA/SCL/RST/INT` 等字样 | 仅能初步判断显示 SPI、触摸另走控制线；须取得**准确控制器型号、供电/逻辑电平、完整接线图**再写屏幕驱动。尚未接线。 |

## 开测最小清单

1. **不要接 LCD、功放、TF 卡或电池**。先用可靠的 USB-C **数据线**连接 Sense；电脑设备管理器确认新 COM 口，记下编号，不把 BOOT 键当业务按钮。
2. 按[USB 联调文档](../docs/ESP32S3-USB本地联调.md)安装 Arduino ESP32 **3.x** 开发板包和 **ArduinoJson 7.x**，板选 `XIAO_ESP32S3`、`USB CDC On Boot: Enabled`，编译并烧录 `xiao-esp32s3-usb/xiao-esp32s3-usb.ino`。若无编译环境或烧录失败，先记录错误，不当作硬件坏了；找不到 COM 口可按[官方 BootLoader 指南](https://wiki.seeedstudio.com/cn/xiao_esp32s3_getting_started/)恢复。
3. 同一台电脑启动项目后端，在网页为**虚构演示商品**创建护理流程；运营端签发**绑定该用户**的设备 token 并存入电脑私有文件。关掉串口监视器，再开 Python 桥接。默认无外接按钮时，电脑应每约 3 秒打印 `USB state: active step=0`，而不是原文或凭据。
4. 如果组员准备了外接**瞬时按钮**，先核对 D0(GPIO1) 和 GND 再断电接线；按下只发 `repeat`，后端不会产生完成记录。不接按钮也能测试读取状态。**绝不**用 GPIO0/BOOT 代替该按钮，也不要在未核对排针时盲插。
5. 记录板型、Arduino/ArduinoJson 版本、COM 号、后端返回、断线重连、按钮操作及护理事件条数；不得将 token、用户资料、照片或原始录音贴到公开日志。实际通过后才写“USB 实物联调成功”。

屏幕、功放、麦克风、摄像头的功能验收属于后续阶段；第一阶段不是多模态或整机验收。
