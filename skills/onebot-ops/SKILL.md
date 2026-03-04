---
name: onebot-ops
description: OneBot (QQ/Lagrange) 消息发送与文件操作技能包。用于：发送文本/图片、上传文件、接收消息说明。
---

# OneBot 运维/使用规范（本地技能）

本技能针对 OpenClaw + OneBot 渠道（QQ/Lagrange.Core），提供可复用的工具说明。

## 0) 快速判断：你要做哪一类事？

- **A. 发送文本**：使用 `onebot_send_text`，target 为 `user:QQ号` 或 `group:群号`
- **B. 发送图片**：使用 `onebot_send_image`，image 为本地路径、`file://`、`http://`、`base64://` 或 data URL
- **C. 上传文件**：使用 `onebot_upload_file`，file 为本地绝对路径，name 为显示名
- **D. 接收消息**：私聊全部回复，群聊仅当用户 @ 机器人时回复
- **E. 文本里发图**：在回复中写 `<qqimg>图片路径或URL</qqimg>`

---

## 1) target 与发送目标

### 1.1 target 格式

- `user:123456789` 或 `123456789`：私聊该 QQ 号
- `group:987654321`：群聊该群号

### 1.2 工具调用示例

**发送文本：**
```
onebot_send_text(target="user:1193466151", text="你好")
onebot_send_text(target="group:123456789", text="群公告内容")
```

**发送图片：**
```
onebot_send_image(target="user:1193466151", image="file:///tmp/screenshot.png")
onebot_send_image(target="group:123456789", image="https://example.com/pic.jpg")
```

**上传文件：**
```
onebot_upload_file(target="group:123456789", file="/path/to/document.pdf", name="文档.pdf")
```

---

## 2) 消息接收规则

- **私聊 (private)**：所有消息 AI 都会回复
- **群聊 (group)**：仅当用户 @ 机器人时 AI 才回复（可配置 `requireMention: false` 改为全部回复）

---

## 3) 新成员入群欢迎

在 `openclaw.json` 中配置：

```json
{
  "channels": {
    "onebot": {
      "groupIncrease": {
        "enabled": true,
        "message": "欢迎 {userId} 加入群聊！"
      }
    }
  }
}
```

`{userId}` 会被替换为新成员的 QQ 号。

---

## 4) 配置参数（TUI 或 openclaw.json）

| 参数 | 说明 |
|------|------|
| type | forward-websocket / backward-websocket |
| host | OneBot 主机地址 |
| port | 端口 |
| accessToken | 访问令牌（可选） |
| requireMention | 群聊是否需 @ 才回复，默认 true |
| thinkingEmojiEnabled | 回复中是否加临时 emoji，默认 false |
| thinkingEmojiId | emoji ID，默认 60 |
| qqimgTagEnabled | 是否启用 `<qqimg>` 解析，默认 true |
| qqimgTagCloseVariants | 允许的结束标签，默认 `qqimg,img` |
| imageCacheDir | 图片缓存目录，需与 NapCat 共享挂载 |

运行 `openclaw onebot setup` 进行交互式配置。

---

## 参考

- OneBot 11: https://github.com/botuniverse/onebot-11
- Lagrange.Core: https://github.com/LSTM-Kirigaya/Lagrange.Core
