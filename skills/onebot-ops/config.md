# OneBot 配置说明

## 关键配置

- `type`: `forward-websocket` 或 `backward-websocket`
- `host`: OneBot 服务主机
- `port`: OneBot 服务端口
- `accessToken`: 访问令牌（可选）
- `requireMention`: 群聊是否必须 @ 才回复（默认 `true`）

## 回复行为配置

- `thinkingEmojiEnabled`: 是否启用“回复中临时 emoji”功能（默认 `false`）
- `thinkingEmojiId`: emoji ID（默认 `60`）
- `qqimgTagEnabled`: 是否启用 `<qqimg>` 标签发图（默认 `true`）
- `qqimgTagCloseVariants`: 允许的结束标签，默认 `["qqimg", "img"]`
- `qqvideoTagEnabled`: 是否启用 `<qqvideo>` 标签发视频（默认 `true`）
- `qqvideoTagCloseVariants`: 允许的结束标签，默认 `["qqvideo", "video"]`
- `imageCacheDir`: URL/base64 图片落盘缓存目录，默认 `/data/.openclaw/workspace/.onebot-image-cache`
- `videoCacheDir`: URL/base64 视频落盘缓存目录，默认 `/data/.openclaw/workspace/.onebot-video-cache`
- `videoMaxBytes`: 视频大小限制，默认 `52428800`（50MB）
- `videoFailureFallback`: 视频发送失败时兜底策略，`none` / `upload-file` / `gif`
- `autoDetectVideoFromMediaUrls`: 是否自动识别 mediaUrls 中的视频，默认 `true`
- `groupChatLogEnabled`: 是否记录群聊日志（默认 `true`）
- `groupChatLogDir`: 群聊日志目录，默认 `/data/.openclaw/workspace/.onebot-group-chat-logs`
- `groupChatLogTimeZone`: 群聊日志按日分桶时区，默认 `Asia/Shanghai`
- `groupChatLogMaxTextLength`: 日志文本最大长度，默认 `2000`
- `groupChatLogIncludeRawMessage`: 是否记录 raw_message（默认 `false`）

## NapCat 挂载建议

`imageCacheDir` 与 `videoCacheDir` 必须同时对 OpenClaw 与 NapCat 可见。

推荐共享：`/data/.openclaw/workspace`
