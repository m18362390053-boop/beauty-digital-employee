# Sense USB 实物图片与语音 → 本机模型测试（第二阶段试验版）

**状态：代码与替身测试通过；尚未在 Sense 实物上编译、烧录、拍照、录音或实际通过 USB 调用模型。** 此方案不使用 Wi-Fi、LCD、功放或 TF 卡，不会自动创建客服消息、确认商品、启动护理或执行转写出的口令。第一阶段 USB 护理状态与按钮回归仍使用[原固件和桥接](ESP32S3-USB本地联调.md)；本草案是**另刷一份媒体试验固件**，不能同时运行两个串口程序。

## 最小闭环与授权

操作人每次在电脑终端输入 `YES image` 或 `YES audio`，确认**用户同意这一次拍摄/录音及提交到外部模型**；工具才发 `capture` 命令。此键入确认不是防止持有设备 token 的恶意软件滥用的强安全机制；请让拍摄/录音动作对被拍摄/录音者明确可见，不得在无人知情时远程启动。开发板只在收到命令时采集，向同一 USB 串口发送 1 张 JPG 或 3 秒 16 kHz 单声道 WAV；电脑校验字节数、CRC32 和媒体签名，随后使用绑定用户的设备 token 请求本机后端。后端复用当前 `ProductVision.recognize`（返回 `confirmation_required`）或 `SpeechService.transcribe`（返回 `review_required`），由后端调用已配置的模型；**不自动进入客服咨询工作流**，模型结果需本人查看/修改/确认后才能用于咨询，尤其不能因为 ASR 输出“好了”完成护理。

接口：`POST /api/device/media/image/recognize`（请求 `{ "authorized":true,"image":{"mediaType":"image/jpeg","dataBase64":"..."}}`）、`POST /api/device/media/audio/transcribe`（请求 `{ "authorized":true,"mediaType":"audio/wav","dataBase64":"..."}`）；只接受**本机电脑持有的设备 Bearer token**，不能用网页登录 Cookie 或运营密码。模型 Key 仅在后端。媒体只驻留板上/电脑临时内存，不保存原始图片/WAV 到仓库、数据库或公开日志。结果可能含包装上的可见文字或转写，应只在授权的本机终端查看，别直接贴公开聊天。

串口媒体协议 v2 是本工具**独立的一次性试验协议**，不改变原 v1：电脑发一行 `{"v":2,"type":"capture","kind":"image"}`（或 `audio`）；设备回应 JSON 头 `{"v":2,"type":"media","kind":"image","size":12345,"crc32":"12345678"}`；电脑发单字节 `R`，设备发不超过 512 字节的原始二进制块，每块等单字节 `A` 再续发，最后发 `{"v":2,"type":"end"}\n`。单文件最大图片 900 KB、录音 160 KB；超限/缺块/校验失败不调用模型。**不是把 base64 媒体塞进 v1 的 1 KB JSON 行。** 未实现可恢复续传；超时后退出并重新取得授权，再次采集。

## 组员实测步骤

1. 按[硬件清单](../hardware/README.md)核对 Sense 扩展板和摄像头实物，USB 数据线连接电脑；**不要接** LCD、独立麦克风、功放或 TF 卡。先记录第一阶段原固件/桥接的结果，再另刷 `hardware/xiao-esp32s3-media/xiao-esp32s3-media.ino`。Arduino ESP32 **3.x**、ArduinoJson **7.x**，选择 `XIAO_ESP32S3`、USB CDC On Boot **Enabled**、PSRAM **Enabled**。固件使用官方 XIAO 摄像头引脚映射与 GPIO42/41 的板载 PDM 麦克风；如果该批次摄像头初始化失败，先核对传感器和驱动兼容性，不能声称图像链路已通过。**固件尚未实物编译。**
2. 在 `beauty-demo/` 下启动本机后端（升级旧库前先备份），配置可用的火山方舟视觉/ASR 模型；若无模型配置，预期返回 `VISION_NOT_CONFIGURED` 或 `ASR_NOT_CONFIGURED`，不代表采集硬件失效。为正在操作的用户签发设备 token，仅放 `data/device-token.txt`；安装 `pyserial`。关闭 Arduino 串口监视器与原 `usb-bridge.py`，确保本脚本**独占**串口。
3. 对**实物产品包装**取得用户单次同意后，运行：Windows `python scripts/usb-media-check.py --port COM5 --token-file data/device-token.txt --kind image`；Mac `python3 scripts/usb-media-check.py --port /dev/cu.usbmodemXXXX --token-file data/device-token.txt --kind image`。替换实际端口；终端输入 `YES image`。`status: confirmation_required` 才说明模型返回候选，仍须人工核对包装、SKU 资料及版本；空候选/不可辨认不能擅自确认。
4. 对用户明确同意的**短语音**，用同一命令把 `--kind image` 改为 `--kind audio`，输入 `YES audio`。预期 `status: review_required` 且 `text` 是草稿；用已知台词和回放/现场验证声音来自板载麦克风，而不是电脑麦克风或本地音频文件。无逐字标准稿时不能宣称识别准确。
5. 脱敏记录：板型/摄像头批次、系统/COM 或 `/dev/cu.*`、Arduino 配置、固件编译/烧录结果、单张 JPG/3 秒 WAV 大小、传输时间、返回状态、故障码、用户单次授权证据；不公开媒体、token 或密钥。测试授权拒绝、USB 断线、无模型配置、图片超限/低光、静音与噪声。要确认撤销设备 token 后模型不再被调用。

目前工程离线验证：`python -m unittest discover -s tests -p 'usb*_test.py' -v` 和 `npm test`；这些测试用假串口/假模型，**不能替代实物、真实模型或客服工作流验收**。若需要“拍照/说话 → 客服 Agent 回答”，下一步必须设计用户逐次确认采集结果、显式发送到绑定用户的客服会话及可追踪消息，不能直接把未经确认的识别文本作为指令。
