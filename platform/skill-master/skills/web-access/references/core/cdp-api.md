# CDP Proxy API Reference

HTTP API for controlling the currently active managed Chrome profile via a local CDP proxy.

## 基础信息

- 地址：`http://127.0.0.1:${CDP_PROXY_PORT:-3456}`
- Node.js 22+ required（native WebSocket + fetch）
- 认证：请求需带 `x-cdp-proxy-token`，可通过 `CDP_PROXY_TOKEN` 指定；未指定时会写入 `os.tmpdir()/web-access-cdp-proxy.token`
- 推荐启动方式（在仓库根目录）：`node ./scripts/core/check-deps.mjs --profile default`
- 直接启动 proxy：`node ./scripts/core/cdp-proxy.mjs &`
- 启动后持续运行，不建议主动停止（重启可能触发 Chrome 重新授权）
- 强制停止：`pkill -f cdp-proxy.mjs`
- profile 决定浏览器身份和登录态；proxy 只暴露当前 active managed profile 的 CDP 能力
- 固定 `remote-debugging-port` 的新版 Chrome 可能监听端口但不写 `DevToolsActivePort`；managed-profile core 会在文件探测失败时只回退到配置端口并通过 `/json/version` 解析 live WebSocket endpoint。

```bash
export CDP_PROXY_PORT="${CDP_PROXY_PORT:-3456}"
export TOKEN_FILE="$(node -p "require('node:os').tmpdir() + '/web-access-cdp-proxy.token'")"
export CDP_PROXY_TOKEN="${CDP_PROXY_TOKEN:-$(cat "$TOKEN_FILE")}"
export PROXY_BASE="http://127.0.0.1:${CDP_PROXY_PORT}"
```

## API 端点

### GET /health

健康检查，返回连接状态。

```bash
curl -s -H "x-cdp-proxy-token: $CDP_PROXY_TOKEN" "$PROXY_BASE/health"
```

### GET /targets

列出所有已打开的页面 tab。返回数组，每项含 `targetId`、`title`、`url`。

```bash
curl -s -H "x-cdp-proxy-token: $CDP_PROXY_TOKEN" "$PROXY_BASE/targets"
```

### GET /new?url=URL

创建新后台 tab，自动等待页面加载完成。返回 `{ targetId }`.

```bash
curl -s -H "x-cdp-proxy-token: $CDP_PROXY_TOKEN" "$PROXY_BASE/new?url=https://example.com"
```

### GET /close?target=ID

关闭指定 tab。

```bash
curl -s -H "x-cdp-proxy-token: $CDP_PROXY_TOKEN" "$PROXY_BASE/close?target=TARGET_ID"
```

### GET /navigate?target=ID&url=URL

在已有 tab 中导航到新 URL，自动等待加载。

```bash
curl -s -H "x-cdp-proxy-token: $CDP_PROXY_TOKEN" "$PROXY_BASE/navigate?target=ID&url=https://example.com"
```

### GET /back?target=ID

后退一页。

```bash
curl -s -H "x-cdp-proxy-token: $CDP_PROXY_TOKEN" "$PROXY_BASE/back?target=ID"
```

### GET /info?target=ID

获取页面基础信息（title、url、readyState）。

```bash
curl -s -H "x-cdp-proxy-token: $CDP_PROXY_TOKEN" "$PROXY_BASE/info?target=ID"
```

### POST /eval?target=ID

执行 JavaScript 表达式，POST body 为 JS 代码。

```bash
curl -s -X POST -H "x-cdp-proxy-token: $CDP_PROXY_TOKEN" "$PROXY_BASE/eval?target=ID" -d 'document.title'
```

### POST /click?target=ID

JS 层面点击（`el.click()`），POST body 为 CSS 选择器。自动 scrollIntoView 后点击。简单快速，覆盖大多数场景。

```bash
curl -s -X POST -H "x-cdp-proxy-token: $CDP_PROXY_TOKEN" "$PROXY_BASE/click?target=ID" -d 'button.submit'
```

### POST /clickAt?target=ID

CDP 浏览器级真实鼠标点击（`Input.dispatchMouseEvent`），POST body 为 CSS 选择器。先获取元素坐标，再模拟鼠标按下/释放。算真实用户手势，能触发文件对话框、绕过部分反自动化检测。

```bash
curl -s -X POST -H "x-cdp-proxy-token: $CDP_PROXY_TOKEN" "$PROXY_BASE/clickAt?target=ID" -d 'button.upload'
```

### POST /setFiles?target=ID

给 file input 设置本地文件路径（`DOM.setFileInputFiles`），完全绕过文件对话框。POST body 为 JSON。

```bash
curl -s -X POST -H "x-cdp-proxy-token: $CDP_PROXY_TOKEN" "$PROXY_BASE/setFiles?target=ID" -d '{"selector":"input[type=file]","files":["/path/to/file1.png","/path/to/file2.png"]}'
```

### GET /scroll?target=ID&y=3000&direction=down

滚动页面。`direction` 可选 `down`（默认）、`up`、`top`、`bottom`。滚动后自动等待 800ms 供懒加载触发。

```bash
curl -s -H "x-cdp-proxy-token: $CDP_PROXY_TOKEN" "$PROXY_BASE/scroll?target=ID&y=3000"
curl -s -H "x-cdp-proxy-token: $CDP_PROXY_TOKEN" "$PROXY_BASE/scroll?target=ID&direction=bottom"
```

### GET /screenshot?target=ID&file=/tmp/shot.png

截图。指定 `file` 参数保存到本地文件；不指定则返回图片二进制。可选 `format=jpeg`。

```bash
curl -s -H "x-cdp-proxy-token: $CDP_PROXY_TOKEN" "$PROXY_BASE/screenshot?target=ID&file=/tmp/shot.png"
```

## /eval 使用提示

- POST body 为任意 JS 表达式，返回 `{ value }` 或 `{ error }`
- 支持 `awaitPromise`：可以写 async 表达式
- 返回值必须是可序列化的（字符串、数字、对象），DOM 节点不能直接返回，需要提取属性
- 提取大量数据时用 `JSON.stringify()` 包裹，确保返回字符串
- 根据页面实际 DOM 结构编写选择器，不要套用固定模板

## 错误处理

| 错误 | 原因 | 解决 |
|------|------|------|
| `No active managed profile` | 尚未启动 managed profile | 先运行 `node ./scripts/core/check-deps.mjs --profile default` |
| `attach 失败` | targetId 无效或 tab 已关闭 | 用 `/targets` 获取最新列表 |
| `CDP 命令超时` | 页面长时间未响应 | 重试或检查 tab 状态 |
| `端口已被占用` | 另一个 proxy 已在运行 | 已有实例可直接复用 |
