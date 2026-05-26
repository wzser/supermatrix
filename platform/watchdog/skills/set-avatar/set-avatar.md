# Set Avatar — 更新飞书群头像

更新当前 session 或指定群的飞书群头像。

## 用法

- `/set-avatar` — 使用用户最近发送的图片作为头像
- `/set-avatar <图片路径>` — 使用指定的本地图片文件

## 你的任务

### 1. 获取图片

- 如果用户指定了图片路径，直接使用
- 如果没有指定，查找用户最近发送的图片（在 `.attachments/` 目录下）
- 支持格式：PNG、JPG。如果是 SVG，先用 `qlmanage -t -s 512 -o /tmp <svg路径>` 转为 PNG

### 2. 上传图片获取 image_key

```bash
cd <图片所在目录> && lark-cli im images create \
  --as bot \
  --data '{"image_type":"avatar"}' \
  --file "image=<图片文件名>"
```

从返回的 JSON 中提取 `data.image_key`。

注意：`--file` 参数必须用相对路径，先 cd 到图片目录。

### 3. 更新群头像

确定目标群的 chat_id。如果在 session 群中使用，从 supermatrix.db 查询当前 session 绑定的群：

```bash
sqlite3 <SM_DB_PATH> \
  "SELECT b.group_id FROM bindings b JOIN sessions s ON b.session_id = s.id WHERE s.name = '<session名>';"
```

然后更新头像：

```bash
lark-cli api PUT /open-apis/im/v1/chats/<chat_id> \
  --as bot \
  --data '{"avatar":"<image_key>"}'
```

### 4. 确认结果

返回 `code: 0` 表示成功。告知用户头像已更新。
