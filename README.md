# @winterfell2021/openclaw-onebot

将 **OneBot v11 协议**（NapCat/Lagrange.Core/go-cqhttp）接入 [OpenClaw](https://openclaw.ai) Gateway 的渠道插件。

[![npm version](https://img.shields.io/npm/v/@winterfell2021/openclaw-onebot.svg)](https://www.npmjs.com/package/@winterfell2021/openclaw-onebot)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 功能

- ✅ 私聊：所有消息 AI 都会回复
- ✅ 群聊：仅当用户 @ 机器人时回复（可配置）
- ✅ 正向 / 反向 WebSocket 连接
- ✅ TUI 配置向导：`openclaw onebot setup`
- ✅ 新成员入群欢迎
- ✅ Agent 工具：`onebot_send_text`、`onebot_send_image`、`onebot_upload_file`
- ✅ 回复文本内 `<qqimg>...</qqimg>` / `<qqimg>...</img>` 自动解析并发图
- ✅ 回复 emoji 可选（默认关闭）

## 安装

```bash
openclaw plugins install @winterfell2021/openclaw-onebot
```

或从 GitHub 安装：

```bash
openclaw plugins install https://github.com/winterfell2021/openclaw-onebot.git
```

## 配置

### 方式一：TUI 向导（推荐）

```bash
openclaw onebot setup
```

### 方式二：手动编辑 `~/.openclaw/openclaw.json`

```json
{
  "channels": {
    "onebot": {
      "type": "forward-websocket",
      "host": "napcat",
      "port": 3001,
      "accessToken": "可选",
      "enabled": true,
      "requireMention": true,
      "thinkingEmojiEnabled": false,
      "thinkingEmojiId": 60,
      "qqimgTagEnabled": true,
      "qqimgTagCloseVariants": ["qqimg", "img"],
      "imageCacheDir": "/data/.openclaw/workspace/.onebot-image-cache",
      "groupIncrease": {
        "enabled": true,
        "message": "欢迎 {userId} 加入群聊！"
      }
    }
  }
}
```

### `<qqimg>` 使用示例

```text
这是文本
<qqimg>https://pbs.twimg.com/media/HCjDCAKawAMLnvE.jpg</qqimg>
```

也支持本地路径：

```text
<qqimg>/data/.openclaw/workspace/images/demo.png</qqimg>
```

## NapCat 挂载要求

如果要发送本地路径图片，OpenClaw 与 NapCat 需要共享同一路径。

推荐将宿主机目录 `./workspace` 同时挂载到两个容器的：

```text
/data/.openclaw/workspace
```

## 环境变量（可选）

| 变量 | 说明 |
|------|------|
| `LAGRANGE_WS_TYPE` | forward-websocket / backward-websocket |
| `LAGRANGE_WS_HOST` | 主机地址 |
| `LAGRANGE_WS_PORT` | 端口 |
| `LAGRANGE_WS_ACCESS_TOKEN` | 访问令牌 |
| `ONEBOT_IMAGE_CACHE_DIR` | 图片缓存目录 |

## Agent 工具

| 工具 | 说明 |
|------|------|
| `onebot_send_text` | 发送文本，target: `user:QQ号` 或 `group:群号` |
| `onebot_send_image` | 发送图片，image: 路径/URL/base64/data URL |
| `onebot_upload_file` | 上传文件，file: 本地路径，name: 文件名 |

## 本地验证

```bash
npm run test
npm run build
npm run test:connect
```

## 协议参考

- [OneBot 11](https://11.onebot.dev/)
- [NapCat 文档](https://www.napcat.wiki/)
- [go-cqhttp](https://docs.go-cqhttp.org/)

## License

MIT © [LSTM-Kirigaya](https://github.com/LSTM-Kirigaya)
