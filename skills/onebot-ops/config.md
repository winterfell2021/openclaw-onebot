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
- `imageCacheDir`: URL/base64 图片落盘缓存目录，默认 `/data/.openclaw/workspace/.onebot-image-cache`

## NapCat 挂载建议

`imageCacheDir` 必须同时对 OpenClaw 与 NapCat 可见。

推荐共享：`/data/.openclaw/workspace`
