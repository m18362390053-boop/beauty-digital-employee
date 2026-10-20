# XIAO ESP32S3 Sense 全输入/输出 USB 协议 v3（独立整合候选）

**状态：电脑网关、后端 TTS 入口与离线替身测试已实现；尚无配套整机固件、接线验收或实物端到端测试。** 本协议提供 B 的 LCD/触摸/摄像头/板载麦克风/功放整合输入输出契约，不宣称把 `usb_lcd_test`、`usb_touch_test` 或媒体试验工程合并了。保持原 v1 桥接和 v2 媒体脚本可用；v3 网关**只能搭配实现本文件的固件**，三者不能同时占用同一串口。无 Wi-Fi，电脑后端只监听本机地址。

## 通道和边界

```text
触摸、LCD、Sense 摄像头/板载 PDM 麦克风、I²S 功放
  ⇄ 唯一 USB CDC 115200 串口（控制 JSON 行；传输阶段独占二进制）
  ⇄ scripts/usb-unified-gateway.py（唯一串口所有者、单次操作人确认、绑定用户的设备 token）
  ⇄ 127.0.0.1 后端（护理状态/动作、图片候选、转写草稿、限定来源 TTS）
```

板上不保存模型密钥或设备 token；电脑私有文件存设备 token，模型 Key 仅后端。每次拍摄、录音、提交外部服务和 TTS 朗读都需本人可见的单次触发；当前网关**另外要求电脑终端操作人输入 `YES <任务id>`**，未输入则返回取消且不采集/外发。此电脑确认是集成期安全门，不是最终无人值守体验，也不能由脚本代替真人填写。LCD 可以在发意图前依次询问本次采集及提交同意，但网关仍要二次确认；以后换成可审计设备侧同意时需重新评审网关。

## 状态帧：屏幕、触摸、护理

每行至多 **1024 UTF-8 字节**，一行一个完整 JSON，`v:3`；`step` 为 0 基，显示时 `step+1`。设备上电/断线恢复发 `{"v":3,"type":"get"}`，电脑返回：

```json
{"v":3,"type":"state","screen":"routine_step","status":"active","routineId":"care-1","step":0,"stepCount":2,"productName":"虚构演示商品","instruction":"当前指导","requestId":""}
```

无活动流程返回 `status:"idle",screen:"home"`，不保留旧产品；已结束流程的动作回执可能带 `finished/stopped`，下次 GET 通常为 `idle`。`productName` 和 `instruction` 来自后端绑定用户的流程，最多 40/170 字符；字段上限以网关的 UTF-8 帧校验为准。连续护理天数、睡觉时间、高亮区域、照片缩略图**不是当前护理 API 事实字段**，可由固件在明确 `DEMO` 标识下画占位值，不能伪称后端下发。

触摸“好了/重说/跳过/停止”发（设备必须在收到真实触摸并松开后产生唯一 requestId，同一动作重试保留原 ID）：

```json
{"v":3,"type":"action","requestId":"tap-001","routineId":"care-1","expectedStep":0,"action":"confirm"}
```

网关使用绑定用户的设备 token 调后端动作接口，回 `state` + 匹配的 `requestId` 和 `eventId`（仅有确认才可能非空）；等待回执期间锁住同一操作。`STEP_CHANGED`、`ROUTINE_NOT_ACTIVE` 等只返回 `{"v":3,"type":"error","code":"STEP_CHANGED"}`，板端须重查状态，**不自动把旧触摸应用到新步骤**。重复投递只重用原 ID；后端负责同编号幂等，板端点击时不能先画成完成。组员 H04 固件和正式 v1 桥接还未合入本协议。

## 摄像头、麦克风：上行

只有用户在 LCD 上选择并确认后，板端发 `{"v":3,"type":"intent","id":"shot-001","kind":"image"}` 或 `kind:"audio"`。未获操作人本次确认，网关仅返回 `{"v":3,"type":"task","id":"shot-001","status":"cancelled"}`。获确认后，网关**在同一串口**发送现有 v2 `capture` 命令；板端使用现有独立媒体协议发头、512 字节停等块、CRC32 和 `end`。照片 ≤900000 字节且须 JPEG；板载录音 ≤160000 字节且须 RIFF/WAVE；损坏、超限、超时不得调用模型。媒体传输期间不处理其他 JSON 消息；中断后关闭串口重连并重新同意，不做断点续传。

后端只返回候选/草稿；网关将结果缩短后下发：

```json
{"v":3,"type":"task","id":"shot-001","status":"candidate_ready","candidates":["已导入商品候选"]}
{"v":3,"type":"task","id":"mic-001","status":"transcript_ready","draft":"转写文字"}
```

最多 2 个名称，各 35 字符；转写文字最多 120 字符，长文本应去电脑端查看。**Demo 不另设候选或转写的二次确认按钮**：本次采集/外发同意后可直接显示结果并进入咨询演示画面。后端识图/转写 API 的原始状态仍为 `confirmation_required` / `review_required`，网关只把它们映射为 LCD 展示状态；这个映射**不等于**后端已经确认 SKU 或把消息发给客服。图片空候选不得臆造商品；转写“好了”不能当护理 `confirm`，也不自动启动护理或记完成。当前仍没有设备端“识别/转写结果→绑定用户客服会话”的真实持久化入口，不能把模拟器里的示例咨询冒称已接通。

## TTS：音频下行与 LCD 文本兜底

用户明确选择“重听步骤”或朗读已保存答复时，板端发以下其一，不能自带任意 `text`：

```json
{"v":3,"type":"intent","id":"speak-001","kind":"speak","routineId":"care-1"}
{"v":3,"type":"intent","id":"speak-002","kind":"speak","messageId":"saved-answer-1"}
```

同意后网关调 `POST /api/device/speech/synthesize`：后端校验 token 所属用户、当前活动步骤或本人已保存且可朗读的回复，只返回 `audio/mpeg` MP3。电脑验文件格式/上限 2 MB 后发送一行 `{"v":3,"type":"binary","id":"speak-001","kind":"speech","format":"mp3","size":12345,"crc32":"12345678"}`；板端回单字节 `R`；电脑每次发送最多 512 字节原始二进制，板端每块回 `A`；最终发送 `{"v":3,"type":"end","id":"speak-001"}` 和 `{"v":3,"type":"task","id":"speak-001","status":"audio_sent"}`。板端先验长度/CRC32，再解码 MP3 为 PCM 送 I²S 功放；**绝不能把 MP3 字节直接写功放 DIN**。`audio_sent` 不是“已播放成功”，实际播放、停止、重播需固件 ACK/实物验收；失败保留 LCD 上的原指导文字。当前已验证的是电脑端 MP3 合成，不是设备播放。

## 执行与验收范围

电脑端离线测试：`python -m unittest discover -s tests -p usb_unified_test.py -v`、`npm test`。启动命令（**仅在 B 提供并编译 v3 配对固件后**）：`python scripts/usb-unified-gateway.py --port COM3 --token-file data/device-token.txt`。本机串口、token 和型号按实物核对。**不要把 v3 网关对着现有 H02/H03/H04 固件或媒体 v2 固件启动**，也不要让两个网关同时占口。

设备侧待 B 实现并测试：单一固件中的 LCD/触摸、上行媒体、下行音频的模式切换及拒绝并发、断线/取消、二进制校验、MP3 解码、I²S 播放。沿用现有 Sense 摄像头和 `10PI-AMP&MIC V3`，但触摸的 SDA/SCL/RST 与旧 I²S 测试脚位 5/6/43 冲突；**协议文档不是新的接线方案**，未复核当前实际接线和电源前不改线/烧录。设备实拍、录音、外部模型提交仍须用户逐次明确同意，和离线测试分别记证据。

| LCD 模拟器入口 | v3 框架现有输出 | 仍须补足 |
| --- | --- | --- |
| 护理状态与四动作 | `get/state/action` → 本人流程/后端事件 | 配对固件、触摸实测、正式 H04/H02 协议合并 |
| 识别包装 | `intent image` → 已校验 JPEG → `candidate_ready` 供直接展示 | 结果进入绑定用户客服会话的入口；实物采集/模型验收 |
| 说句话 | `intent audio` → 已校验 WAV → `transcript_ready` 供直接展示 | 结果进入绑定用户客服会话的持久化入口；不能映射为护理指令 |
| 重听/朗读 | `intent speak` → 绑定用户的已保存文字 → MP3 下行 | 板端 MP3 解码、播放/停止/重播和实际播放回执 |
| 脸部高亮 | 状态帧暂不下发 `region` | 已审区域来源、LCD 内置图层及高亮渲染 |
| 悦见时刻 | 暂无对应的 v3 媒体目的地 | 独立拍照用途授权、存储/删除与回显协议，不能借包装识图冒充 |
