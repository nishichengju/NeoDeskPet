# NeoDeskPet (Electron)

NeoDeskPet 是一个基于 **Electron + React + TypeScript + Vite** 的 AI 桌宠/聊天工具原型：
- Live2D 桌宠（模型扫描、表情/动作触发）
- 聊天窗口 + 工具面板（Tool Calling）
- MCP（Model Context Protocol）示例：屏幕截图 `screen.capture`、多模态向量 `mmvector` 等

本仓库以“能跑起来 + 方便二次开发”为目标，默认只提交必要源码与少量示例资源；本地配置、缓存输出、体积过大的文件、以及可能涉及版权的第三方模型文件会被忽略。

## 开发环境

- Node.js >= 18
- Windows（当前默认脚本/工具以 Windows 为主）

## 快速开始

```powershell
cd NeoDeskPet-electron
npm install
npm run dev
```

构建打包：

```powershell
npm run build
```

## Live2D 模型

- 开发环境下，Live2D 模型目录为：`public/live2d/`
- 运行时会自动扫描该目录，生成“可用模型列表”
- 出于体积/版权原因，本仓库不会收录第三方 Live2D 模型文件；你可以把自己的模型放到 `public/live2d/<ModelName>/`（目录结构参考已有示例）
- 仓库内保留的示例模型仅用于演示用途；使用前请自行确认并遵守 Live2D 官方 Sample Data 的许可条款：https://www.live2d.com/download/sample-data/

## MCP（可选）

- `mcp/screen-server/`：提供 `screen.capture`、`screen.watch_*` 等工具
- `mcp/mmvector-server/`：提供 `mcp.mmvector.*` 多模态向量工具（需要你自行准备 OpenAI-compatible embeddings 服务）

每个 MCP server 目录下都提供了 `deskpet-mcp-settings.json` 示例配置；其中的 `cwd` 需要改成你本机的项目绝对路径。

## 开源协议

本项目采用 **AGPL-3.0-only** 开源，详见 `LICENSE`。
