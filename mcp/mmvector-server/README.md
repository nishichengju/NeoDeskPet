# NDP 多模态向量 MCP（mmvector）

日期：2026-01-13  
作者：Codex

这是一个给 NeoDeskPet 使用的本机 MCP server：  
调用 `多模态向量/server.py` 提供的 OpenAI-compatible embeddings API，维护一个本地向量索引，并把“搜索结果（含 imagePath/videoUrl）”返回给 LLM/聊天工具卡片使用。

## 1) 前置条件

- 先启动多模态 embedding 服务（示例）：`python 多模态向量/server.py`（默认 `http://0.0.0.0:7860/v1`）
- Node 版本建议 >= 18（需要内置 `fetch/FormData/Blob`）

## 2) 工具列表

工具名会显示为 `mcp.<serverId>.<toolName>`（serverId 取决于你在 DeskPet 里配置的 ID）。

- `health`：检查 embedding 服务是否在线（GET `/`）
- `index_stats`：索引统计（数量/维度）
- `index_add_image`：添加图片到索引（本地文件 → dataUrl → `/v1/embeddings`）
- `index_add_video`：添加视频到索引（上传 `/v1/upload/video` → `/v1/embeddings`）
- `index_delete`：删除索引项（视频会尝试调用 `/v1/file` 删除服务器文件）
- `index_clear`：清空索引（不删服务器文件）
- `search_by_text` / `search_by_image` / `search_by_video`：检索（返回 compact JSON，包含 `imagePath`/`videoUrl` 便于聊天卡片内预览/播放）

## 3) 环境变量

- `NDP_MMVECTOR_BASE_URL`：例如 `http://127.0.0.1:7860/v1`
- `NDP_MMVECTOR_API_KEY`：可选（默认不带 Authorization）
- `NDP_MMVECTOR_MODEL`：默认 `qwen3-vl-embedding-8b`
- `NDP_MMVECTOR_DATA_DIR`：索引持久化目录（默认：`<cwd>/mcp-output/mmvector`）

## 4) 快速自测（不走 MCP）

在 `NeoDeskPet-electron` 目录运行：

```powershell
node mcp/mmvector-server/server.mjs --selftest
```

成功会输出 JSON（含 `dim` 与 `index` 统计）。

## 5) DeskPet 配置

示例配置文件：`NeoDeskPet-electron/mcp/mmvector-server/deskpet-mcp-settings.json`

## 6) 参数说明（重要）

为避免 LLM 在“参数命名”上犯错，图片/视频相关工具同时兼容两种字段：

- 图片：`imagePath`（推荐）或 `path`（别名）
- 视频：`videoPath`（推荐）或 `path`（别名）

另外也兼容“直接传字符串”的情况（上游可能把原始输入放到 `value`）：

- `value`: `"C:\\path\\to\\file.jpg"` 或者 `"{\"imagePath\":\"C:\\\\path\\\\to\\\\file.jpg\"}"`
