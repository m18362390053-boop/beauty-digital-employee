# XIAO ESP32S3 Sense：USB 串口联调第一阶段

**状态：仅协议、电脑桥接与固件草案；尚未在 Windows/Mac 上完成实物烧录和串口联调。** 不使用 Wi‑Fi，不改变现有数据库或用户侧认证。组员开测的型号和模块核对见[硬件清单](../hardware/README.md)；本地原始 `esp32s3_hardware.md` 和组员照片不随本次代码提交。

## 硬件与本阶段范围

- Seeed XIAO ESP32S3 Sense 的摄像头扩展板、PDM 麦克风、microSD 卡槽以[官方入门](https://wiki.seeedstudio.com/cn/xiao_esp32s3_getting_started/)及[麦克风教程](https://wiki.seeedstudio.com/xiao_esp32s3_sense_mic/)为准；摄像头实际传感器批次仍应核对实物。暂不录音、拍照或读写卡。
- 组员照片中的独立 I²S 功放和喇叭，以及标注 `1.83 inch Touch LCD Module, 240 × 284 Pixels` 的触摸屏尚**未**接线；需要模块供电、控制器型号、显示/触摸引脚与板载摄像头/SD 冲突核对后才编写驱动。不要以照片推断完整引脚电压，或把 MP3/WAV 文件直接发送到功放引脚。
- 第一阶段只有 **USB CDC 串口 + 本地电脑桥接 + 已有设备护理 API**。开发板的外接 D0→GND 按键仅演示 `repeat`（重说），**不会**生成完成事件。现有后端支持 `confirm/skip/stop`，但**本阶段桥接程序也会拒绝这些指令**；待按钮、安全交互和接线验收后再开放。

## 数据路径和安全边界

```text
XIAO (USB CDC，115200，逐行 UTF-8 JSON)
   ⇄ 电脑 scripts/usb-bridge.py (pyserial)
   ⇄ 127.0.0.1 本机后端 /api/device/routines/current 与 /api/device/routines/:id/actions
   ⇄ 本机 SQLite 护理状态
```

电脑桥接才持有**绑定某用户的设备专用 token**；它不会发到串口、固件或日志，不能访问其他用户和运营接口。后端仍监听 `127.0.0.1`，桥接拒绝非本机后端 URL。模型密钥只在后端。本协议没有上传媒体，也没有替代浏览器图片/语音的用户授权。产品必须先由用户在网页确认并启动护理，设备不能自行创建或审核商品计划。

协议 v1：一行一个完整 JSON，开发板发 `{"v":1,"type":"get"}` 获取状态；按键请求为 `{"v":1,"type":"action","requestId":"boot-1","routineId":"...","expectedStep":0,"action":"repeat"}`。电脑返回 `{"v":1,"type":"state","routineId":"...","status":"active","step":0,"instruction":"...","eventId":"","requestId":"boot-1"}`；无运行流程返回 `status: "idle"`，错误只返回格式受限的 `code`，不回传服务端原始异常。`requestId` 只在动作回执中回显，开发板仅收到匹配回执才清除待重发动作；断线超时用相同 requestId、routineId 和 expectedStep 重发，后端保证同动作幂等。`STEP_CHANGED` 后重新 GET，**绝不**自动把旧按键应用到新步骤。

## 电脑端准备（实物到手后再执行）

1. 需要 Node.js **≥24** 和 Python 3。升级旧 SQLite 之前先备份：在 `beauty-demo/` 中 Windows 用 `npm.cmd run backup`，Mac 用 `npm run backup`；随后分别使用 `npm.cmd run build` / `npm run build` 与 `npm.cmd start` / `npm start`。先用网页创建并确认**虚构演示商品**护理。正式 SKU 不得无审核计划启动。
2. 在运营端登录后，按[护理对接说明](护理与多模态对接说明.md)的 `POST /api/ops/device-credentials` 为**网页用户 ID**签发设备专用 token。只把本次返回的 token 写进本机私有文件 `beauty-demo/data/device-token.txt`（此目录被 Git 忽略），**不要复制到聊天、仓库、固件或串口**。运营密码/模型 Key 不是设备 token。用完或丢失时调用 `DELETE /api/ops/device-credentials/<userId>` 撤销。
3. 刷入下述固件后，关闭 Arduino 串口监视器（同一串口不能同时被桥接占用）。**Windows**：安装 `python -m pip install pyserial`，在设备管理器确认 COM 号；在 `beauty-demo/` 运行：

   ```powershell
   python scripts/usb-bridge.py --port COM5 --token-file data/device-token.txt
   ```

   **Mac**：在 `beauty-demo/` 下使用虚拟环境安装 pyserial（虚拟环境位于已忽略的 `data/` 内），插拔开发板后查看新出现的 `/dev/cu.usbmodem*`，以实际设备名替换下方示例：

   ```bash
   python3 -m venv data/usb-venv
   data/usb-venv/bin/python -m pip install pyserial
   ls /dev/cu.usbmodem*
   data/usb-venv/bin/python scripts/usb-bridge.py --port /dev/cu.usbmodemXXXX --token-file data/device-token.txt
   ```

   `COM5` 和 `/dev/cu.usbmodemXXXX` 都仅是示例；若未出现新端口，先检查 USB **数据线**、USB CDC 选项和烧录状态。可用 `--backend http://127.0.0.1:3090` 显式指定本机服务。不要对公网或同网段其他主机运行本桥接。**跨平台共用同一份固件和桥接源码只是设计目标；Mac 上尚未完成实物编译/串口验收。**

## 固件及后续联调

`hardware/xiao-esp32s3-usb/xiao-esp32s3-usb.ino` 针对 Arduino ESP32 3.x + ArduinoJson 7.x，板选 `XIAO_ESP32S3`，**USB CDC On Boot = Enabled**。当前只有 USB 状态轮询与可选的外接 D0→GND 重说按键；不拿 BOOT/GPIO0 充当业务按键，也不接 LCD、功放、麦克风/摄像头/SD。屏幕/喇叭无供电与引脚表前不得照猜测接线。固件尚未在 Arduino CLI 或实际板子上编译/烧录。

离线检查：Windows 用 `python -m unittest discover -s tests -p usb_bridge_test.py -v`，Mac 用 `python3 -m unittest discover -s tests -p usb_bridge_test.py -v`。实际联调需记录系统、串口名、板子 USB CDC 配置、固件编译结果、串口回执、断线重连和按键重复提交结果；这些证据与离线单元测试分开保存。下一阶段另行设计 USB 图片/音频分帧、大小/校验/超时与用户逐次授权；不能让设备仅凭转写“好了”自动记录完成。
