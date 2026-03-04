# OneBot 接收规则

- 私聊：默认全部回复
- 群聊：默认仅在 `@机器人` 时回复（`requireMention=true`）

## 入站消息处理

1. 提取消息文本
2. 判断是否满足回复条件
3. 进入 OpenClaw runtime 生成回复
4. 发送文本/图片（支持 `<qqimg>` 与 `payload.mediaUrl`）

## 错误处理

- 发送失败会记录日志
- 回复失败时尝试回送简短错误提示
