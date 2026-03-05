# OneBot 接收规则

- 私聊：默认全部回复
- 群聊：默认仅在 `@机器人` 时回复（`requireMention=true`）

## 入站消息处理

1. 提取消息文本
2. 群聊消息按日期落盘到 JSONL（可关闭）
3. 判断是否满足回复条件
4. 进入 OpenClaw runtime 生成回复
5. 发送文本/图片/视频（支持 `<qqimg>`、`<qqvideo>` 与 `payload.mediaUrl(s)`）

## 错误处理

- 发送失败会记录日志
- 回复失败时尝试回送简短错误提示
