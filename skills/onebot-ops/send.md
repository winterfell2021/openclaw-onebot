# OneBot 发送规则

## 文本发送

工具：`onebot_send_text`

- `target`: `user:QQ号` 或 `group:群号`
- `text`: 文本内容

## 图片发送

工具：`onebot_send_image`

- `target`: `user:QQ号` 或 `group:群号`
- `image`: 支持
  - 本地路径
  - `file://...`
  - `http(s)://...`
  - `base64://...`
 - `data:image/...;base64,...`

## 视频发送

工具：`onebot_send_video`

- `target`: `user:QQ号` 或 `group:群号`
- `video`: 支持
  - 本地路径
  - `file://...`
  - `http(s)://...`
  - `base64://...`
  - `data:video/...;base64,...`

## `<qqimg>` 标签

如果文本中包含：

```text
<qqimg>图片地址</qqimg>
```

插件会按原文顺序拆分并发送文本/图片。

也兼容 `</img>` 作为闭合标签。

## `<qqvideo>` 标签

如果文本中包含：

```text
<qqvideo>视频地址</qqvideo>
```

插件会按原文顺序拆分并发送文本/视频。

也兼容 `</video>` 作为闭合标签。
