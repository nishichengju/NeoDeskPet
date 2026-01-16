# NDP 屏幕截图 MCP（screen.capture）

日期：2026-01-05  
作者：Codex

这是一个给 NeoDeskPet 使用的本机 MCP server，提供按需截图与低频“持续观察”（watch + peek）。

## 1) 工具列表

- `monitors`：列出显示器与虚拟桌面坐标（工具名会显示为 `mcp.screen.monitors`）
- `capture`：截图（默认主屏），返回本地文件路径；可选返回 `dataUrl/base64`（工具名 `mcp.screen.capture`）
- `watch_start` / `watch_peek` / `watch_stop`：后台轮询截图，只缓存最新一帧（避免刷屏）

## 2) 快速自测（不走 MCP）

在 `NeoDeskPet-electron` 目录运行：

```powershell
node mcp/screen-server/server.mjs --selftest
```

成功会输出一个 JSON（含 `path`），并在输出目录生成截图文件。

## 3) DeskPet 配置

示例配置文件：`NeoDeskPet-electron/mcp/screen-server/deskpet-mcp-settings.json`（可直接粘贴到 DeskPet 设置页的“导入/导出（JSON）”文本框）

关键字段（导入后 DeskPet 会自动补齐 stdio/启用状态等字段）：

- `command`: `node`
- `args`: `["mcp/screen-server/server.mjs"]`
- `cwd`: `<ABSOLUTE_PATH_TO_YOUR_NeoDeskPet-electron>`（确保能找到 `node_modules/@modelcontextprotocol/sdk`）
- `env.NDP_SCREEN_OUT_DIR`: 截图输出目录（可改）

## 4) 重要限制（关于“视觉”）

当前 DeskPet 的工具返回值类型是纯文本（`ToolExecuteResult.output: string`），所以就算 MCP 工具返回了截图文件路径或 `dataUrl`，模型也只会“读到一段文本”，并不会把它当作视觉输入自动送进模型。

如果你希望模型真的“看图理解”，需要桌宠侧把截图作为 `image_url` 类型内容拼进下一次请求（或把截图写入 `ChatMessageRecord.image` 并参与上下文构造）。
