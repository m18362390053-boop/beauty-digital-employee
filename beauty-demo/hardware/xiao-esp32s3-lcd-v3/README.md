# LCD 状态显示候选固件

`xiao-esp32s3-lcd-v3.ino` 使用 USB CDC 发送 v3 `get`，接收 `state` 和部分 `task` 帧，在 240×284 屏上显示中文步骤、结果及断线提示。依赖 Arduino ESP32 3.x、ArduinoJson 7.x、Arduino_GFX 1.4.9 与 U8g2；需要启用 USB CDC On Boot。消息契约见 [USB v3 协议](../../docs/ESP32S3-统一USB协议v3.md)。

**未编译或在实体屏幕上验证。**`SCK=7 MOSI=9 CS=1 DC=2 RST=4 BL=3`、ST7789 控制器参数及背光极性必须以实际电路核对；GPIO1 已用作 LCD CS，不能再作外接 D0 按钮。代码不含触摸、摄像头、麦克风、MP3 解码或喇叭播放，不能与 v1/v2 网关混用。未核对电气规格前不要上电。
