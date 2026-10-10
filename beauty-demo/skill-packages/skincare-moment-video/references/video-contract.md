# 约15秒护肤纪念视频能力边界

## 标准输入

```json
{
  "userId": "当前用户",
  "selectedAssetIds": ["用户从候选列表中确认的素材ID"],
  "targetDurationSeconds": 15,
  "faceAwareCropAllowed": false
}
```

候选素材必须由服务端从当前用户已授权的记录中产生。不得允许客户端用路径绕过授权检查。

## 标准结果

状态可为 `queued`、`generating`、`completed`、`insufficient_assets`、`failed`、`python_missing` 或 `not_configured`。

成功结果至少包含输出路径、实际时长、实际使用的素材ID、最早和最晚素材日期。只有输出文件存在、非空且可读时才能返回 `completed`。

## 隐私与失败处理

- 未授权、缺失、空文件或不支持格式的素材必须排除。
- 用户撤回授权后不得继续使用对应素材。
- 人脸定位仅用于构图，不做身份、情绪、颜值、年龄、性别或健康推断。
- 视频不超过15秒，默认无音频。
- 未接通真实生成器时返回 `not_configured`，不输出假路径或空视频。
- Python、FFmpeg或编码失败时保留明确错误原因，便于用户重试或选择其他素材。
