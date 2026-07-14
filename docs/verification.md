# NeoDeskPet 验证记录

## P1-4：正式发布配置与安装包优化

- 验证日期：2026-07-13
- 平台：Windows 10 22H2 x64
- Node.js：24.18.0
- Electron：30.5.1

### 自动化与静态检查

| 检查 | 结果 |
| --- | --- |
| `npm test` | 20 个测试文件、74 个用例通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run ui:baseline` | 13 个截图场景通过，无 console/page error 或布局溢出 |
| `git diff --check` | 通过 |

### 打包与运行验证

| 检查 | 结果 |
| --- | --- |
| 精简版 Windows 构建 | 通过，安装器 95.31 MiB |
| 离线完整版 Windows 构建 | 通过，安装器 176.98 MiB |
| 精简版安装器 smoke | 安装、启动、同版本升级、卸载全部通过 |
| 完整版安装器 smoke | 安装、启动、同版本升级、卸载全部通过 |
| `npm run ipc:smoke` | 五类窗口权限、密钥脱敏、AI 代理、重启迁移通过 |
| `npm run media:smoke` | 附件、媒体 URL、Range、删除失效和路径拒绝通过 |
| 完整版浏览器 | 从发行目录启动 Chromium 149.0.7827.55 并完成页面操作 |
| 精简版首次浏览器使用 | 打包 EXE 下载 Chromium/FFmpeg/Winldd 到全新用户目录后成功启动 |

### 发行内容检查

- 精简包不包含 `playwright-browsers`，完整版包含 273.07 MiB 浏览器资源。
- 两种包均只包含 Haru、Hiyori、Mao、Mark、Natori、Rice、Wanko 七个 Live2D 示例模型。
- `app.asar.unpacked` 包含 `better-sqlite3` native addon 与 `playwright-core` CLI。
- `gh-pages`、React、Pixi 等已由 Vite 打包或不参与运行的重复依赖不再进入 `app.asar`。
- EXE 的 ProductName、CompanyName、版本、版权和 16 至 256 像素图标资源均通过读取验证。

### 未覆盖风险

- 安装器 smoke 使用当前 Windows 10 主机上的隔离目录模拟干净安装，并非独立 Windows 11 虚拟机。
- 发行包尚未配置代码签名证书；Windows SmartScreen 信誉需在正式发布签名后另行验证。
- 精简版首次浏览器下载依赖用户网络可访问 Playwright CDN；网络失败会保留明确错误并允许下次重试。

## P2-1：大型模块拆分与领域边界（第一批）

- 验证日期：2026-07-13
- 拆分范围：`electron/main.ts` 中全部 28 个 `settings:*` IPC 处理器

| 检查 | 结果 |
| --- | --- |
| `npm test` | 21 个测试文件、77 个用例通过 |
| 设置 IPC 行为测试 | 通道覆盖、密钥边界、Memory/MCP/ASR 副作用、AI Profile 通过 |
| IPC 权限结构测试 | 递归扫描全部 Electron TypeScript 源码，118 个通道与权限矩阵一致 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | 设置导航、密钥脱敏、AI 代理、重启迁移和五类窗口通过 |
| `npm run media:smoke` | 通过 |
| `npm run ui:baseline` | 13 个场景通过 |

本批未修改 renderer、preload、权限矩阵或数据库结构。P2-1 仍在进行中，后续继续拆分 Chat、Task、Memory、TTS 和 Window IPC。

## P2-1：大型模块拆分与领域边界（第二批）

- 验证日期：2026-07-13
- 拆分范围：Chat 会话持久化与长期记忆摄取 IPC

| 检查 | 结果 |
| --- | --- |
| `npm test` | 22 个测试文件、82 个用例通过 |
| Chat IPC 行为测试 | 14 通道、会话委托、三种消息更新、persona 采集策略和故障隔离通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | 真实 SQLite 会话在重启前后内容与元数据一致，增删改、清空、删除会话通过 |
| Chat → Memory | 打包环境触发 embedding 请求，鉴权仍由主进程密钥代理注入 |
| `npm run media:smoke` | 通过 |
| `npm run ui:baseline` | 13 个场景通过 |

本批未修改 Chat renderer、preload API、IPC 权限矩阵或 SQLite schema。当时尚未迁移的 Chat 附件与本地媒体 IPC 已在第三批完成。

## P2-1：大型模块拆分与领域边界（第三批）

- 验证日期：2026-07-13
- 拆分范围：Chat 附件保存、本地媒体读取与 URL 托管 IPC

| 检查 | 结果 |
| --- | --- |
| `npm test` | 23 个测试文件、87 个用例通过 |
| 附件 IPC 行为测试 | 三通道、data URL、选择文件复制、相对路径、opaque URL、错误脱敏和关闭失效通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run media:smoke` | 真实文件选择、伪造路径拒绝、Range 206、删除后 404 通过 |
| `npm run ipc:smoke` | 五类窗口、SQLite 重启往返、密钥代理和 IPC 权限通过 |
| `npm run ui:baseline` | 13 个场景通过 |

本批未修改 renderer、preload API、IPC 权限矩阵或媒体路径策略。Task IPC 已在第四批完成，后续继续拆分 Memory、TTS 和 Window IPC。

## P2-1：大型模块拆分与领域边界（第四批）

- 验证日期：2026-07-13
- 拆分范围：Task IPC 适配层

| 检查 | 结果 |
| --- | --- |
| `npm test` | 24 个测试文件、90 个用例通过 |
| Task IPC 行为测试 | 8 通道、未就绪返回语义和全部操作委托通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | Chat/Orb/Pet 任务能力表完整，五类窗口无运行时错误 |
| `npm run ui:baseline` | 13 个场景通过 |

本批未修改 TaskService 调度、任务存储、renderer、preload API 或 IPC 权限矩阵。P2-1 后续继续拆分 Memory、TTS 和 Window IPC。

## P2-1：大型模块拆分与领域边界（第五批）

- 验证日期：2026-07-13
- 拆分范围：Memory persona、检索、管理、版本与冲突 IPC 适配层

| 检查 | 结果 |
| --- | --- |
| `npm test` | 26 个测试文件、96 个用例通过 |
| Memory IPC 行为测试 | 19 通道、未就绪差异、禁用检索、CRUD、批量元数据、版本与冲突委托通过 |
| Persona 存储归一化测试 | SQLite `0/1` 正确转换为 boolean，空记录返回 `null` |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | 真实 persona 创建/更新/删除、手工记忆写入/编辑/版本/元数据/列表/删除通过 |
| `npm run media:smoke` | 路径拒绝、opaque URL、Range 206 与删除后 404 通过 |
| `npm run ui:baseline` | 13 个场景通过 |
| `git diff --check` | 通过 |

本批未修改 renderer、preload API、IPC 权限矩阵或 Memory SQLite schema。P2-1 后续继续拆分 TTS 与 Window IPC；记忆检索质量、维护任务和冲突算法属于后续 `memoryService.ts` 领域拆分范围。

## P2-1：大型模块拆分与领域边界（第六批）

- 验证日期：2026-07-13
- 拆分范围：TTS 选项、HTTP 代理、流生命周期与 Chat/Pet 状态转发 IPC

| 检查 | 结果 |
| --- | --- |
| `npm test` | 27 个测试文件、101 个用例通过 |
| TTS IPC 行为测试 | 11 通道、目录回退、同源/路径白名单、JSON/二进制响应、流分块/取消和窗口转发通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | 权重 JSON、6 字节音频 ArrayBuffer、6 字节分块流、非法路径拒绝及 Chat/Pet 双向转发通过 |
| `npm run media:smoke` | 路径拒绝、opaque URL、Range 206 与删除后 404 通过 |
| `npm run ui:baseline` | 13 个场景通过，Chat 停止操作继续同步停止 TTS |
| `git diff --check` | 通过 |

本批未修改 renderer、preload API、IPC 权限矩阵、TTS 请求协议或设置结构。P2-1 的 `electron/main.ts` IPC 拆分下一批仅剩 Window/Live2D/ASR/Orb 等窗口协调通道的边界整理。

## P2-1：大型模块拆分与领域边界（第七批）

- 验证日期：2026-07-13
- 拆分范围：Live2D、Bubble 与 ASR Presentation IPC

| 检查 | 结果 |
| --- | --- |
| `npm test` | 28 个测试文件、106 个用例通过 |
| Presentation IPC 行为测试 | 9 通道、Live2D 报告、气泡归一化、ASR 排队/就绪/auto-send 和错误 sender 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | 表情、气泡、preview、ASR compose/transcript 与 capabilities 上报通过，五类窗口无运行时错误 |
| `npm run media:smoke` | 路径拒绝、opaque URL、Range 206 与删除后 404 通过 |
| `npm run ui:baseline` | 13 个场景通过 |
| `git diff --check` | 通过 |

本批未修改 renderer、preload API、IPC 权限矩阵、ASR 设置或 Live2D 数据契约。P2-1 下一批继续拆分 Window/Orb/Drag/Pet 菜单与点击穿透协调逻辑。

## P2-1：大型模块拆分与领域边界（第八批）

- 验证日期：2026-07-13
- 拆分范围：Window、Orb、Drag 与 Pet 协调 IPC

| 检查 | 结果 |
| --- | --- |
| `npm test` | 29 个测试文件、111 个用例通过 |
| Window IPC 行为测试 | 20 通道、void 返回、深链、Orb、overlay、拖拽阈值/尺寸锁定/吸附、菜单与 hover 身份通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | Orb `ball → panel → ball`、overlay 设置/清理、displayMode、深链与五类窗口运行通过 |
| `npm run media:smoke` | 路径拒绝、opaque URL、Range 206 与删除后 404 通过 |
| `npm run ui:baseline` | 13 个场景通过，Orb ball/bar/panel 布局保持正常 |
| `git diff --check` | 通过 |

本批未修改 renderer、preload API、IPC 权限矩阵、WindowManager 行为或设置结构。`electron/main.ts` 计划内的 settings/chat/task/memory/tts/window 分域注册已完成；P2-1 后续按路线图进入 `ChatWindow.tsx`、`taskService.ts`、`memoryService.ts` 与 `OrbApp.tsx` 拆分。

## P2-1：大型模块拆分与领域边界（第九批）

- 验证日期：2026-07-13
- 拆分范围：Chat ImageViewer 子组件

| 检查 | 结果 |
| --- | --- |
| `npm test` | 30 个测试文件、113 个用例通过 |
| ImageViewer 渲染测试 | 选中图片、`1 / 2`、`100%`、首项导航禁用、提示与空 item 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | 通过，五类窗口无运行时错误 |
| `npm run media:smoke` | 图片/视频托管、Range 206、路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 14 个场景通过；图片查看器打开态、元数据、无溢出与 Esc 关闭通过 |
| `git diff --check` | 通过 |

本批未修改消息渲染契约、附件 URL 解析、样式 class 或 preload API。`ChatWindow.tsx` 后续继续拆分 `ChatMessageItem`、会话列表、composer 和 AI/TTS/ASR hooks。

## P2-1：大型模块拆分与领域边界（第十批）

- 验证日期：2026-07-13
- 拆分范围：Chat 消息附件归一化与渲染组件

| 检查 | 结果 |
| --- | --- |
| `npm test` | 31 个测试文件、116 个用例通过 |
| 消息附件测试 | attachments 清洗、resourceId/filename、legacy 回退、data URL、隐藏态通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | 通过，Chat 与五类窗口无运行时错误 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 14 个场景通过；消息图片经新附件组件打开 ImageViewer 并可 Esc 关闭 |
| `git diff --check` | 通过 |

本批未修改附件持久化结构、LocalMediaRegistry、安全权限、样式 class 或 preload API。`ChatWindow.tsx` 后续继续拆分工具运行卡、消息主体、会话列表与 composer。

## P2-1：大型模块拆分与领域边界（第十一批）

- 验证日期：2026-07-13
- 拆分范围：Chat 工具运行卡、多模态结果解析与 UI 基线

| 检查 | 结果 |
| --- | --- |
| `npm test` | 32 个测试文件、120 个用例通过 |
| 工具运行卡测试 | mmvector 解析、runId 精确选择、Agent 外壳过滤、图片筛选、多模态媒体和旧步骤兜底通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | 通过，Chat 与五类窗口无运行时错误，IPC/持久化/转发契约正常 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；工具卡摘要、展开详情、输入输出、无横向溢出和截图通过 |
| `git diff --check` | 通过 |

工具卡展开态截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改任务持久化结构、消息 block 契约、样式 class、preload API 或 IPC 权限；`ChatWindow.tsx` 后续继续拆分消息主体、会话列表与 composer。

## P2-1：大型模块拆分与领域边界（第十二批）

- 验证日期：2026-07-13
- 拆分范围：Chat 消息主体、分段气泡与行内编辑态

| 检查 | 结果 |
| --- | --- |
| `npm test` | 33 个测试文件、124 个用例通过 |
| 消息主体测试 | block 顺序、Markdown/status/tool、fallback、头像、overlay、编辑态和分段揭示通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | 通过，Chat 与五类窗口无运行时错误，IPC/持久化/转发契约正常 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；用户消息右键编辑、初值、保存更新、图片查看器和工具卡通过 |
| `git diff --check` | 通过 |

消息编辑态截图：`artifacts/ui-baseline/chat-compact-420x560-scale100-message-edit.png`。本批未修改消息持久化结构、block 契约、TTS 分段算法、样式 class、preload API 或 IPC 权限；`ChatWindow.tsx` 后续继续拆分会话列表与 composer。

## P2-1：大型模块拆分与领域边界（第十三批）

- 验证日期：2026-07-13
- 拆分范围：Chat 会话列表与重命名交互

| 检查 | 结果 |
| --- | --- |
| `npm test` | 34 个测试文件、127 个用例通过 |
| 会话列表测试 | 关闭态、当前会话、消息计数、活动态、可访问操作按钮和受控重命名输入通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | 通过，Chat 会话持久化与五类窗口运行无错误 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；会话列表打开、重命名初值、Enter 单次提交和名称更新通过 |
| `git diff --check` | 通过 |

会话重命名截图：`artifacts/ui-baseline/chat-compact-420x560-scale100-session-rename.png`。本批未修改会话持久化结构、IPC 通道、样式 class、preload API 或删除/切换语义；`ChatWindow.tsx` 后续继续拆分 composer。

## P2-1：大型模块拆分与领域边界（第十四批）

- 验证日期：2026-07-13
- 拆分范围：Chat composer、媒体选择与待发送附件预览

| 检查 | 结果 |
| --- | --- |
| `npm test` | 35 个测试文件、131 个用例通过 |
| composer 测试 | MIME 分类、禁用发送、隐藏 input、附件菜单、媒体预览、移除按钮和停止态通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | 通过，Chat 附件/发送所需 preload 权限与五类窗口运行正常 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；真实文件选择、附件预览/移除、多行输入、IME、发送和停止通过 |
| `git diff --check` | 通过 |

附件预览截图：`artifacts/ui-baseline/chat-compact-420x560-scale100-attachment-preview.png`。本批未修改附件大小限制、持久化结构、ASR 同步规则、发送链路、样式 class、preload API 或 IPC 权限；`ChatWindow.tsx` 后续继续拆分 AI/TTS/ASR hooks。

## P2-1：大型模块拆分与领域边界（第十五批）

- 验证日期：2026-07-13
- 拆分范围：Chat ASR renderer hook、compose preview 与自动发送队列

| 检查 | 结果 |
| --- | --- |
| `npm test` | 36 个测试文件、136 个用例通过 |
| ASR 控制器测试 | preview 去重/强制清空、手动追加、无会话排队、FIFO/串行发送、缓存 drain 合并和禁用态通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | 五类窗口无运行时错误，ASR compose preview 与 transcript 双向 relay 通过 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；默认与紧凑 Chat 输入区、附件预览无位移、遮挡或溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-default-720x620-scale100.png`、`artifacts/ui-baseline/chat-compact-420x560-scale100-attachment-preview.png`。本批未修改 ASR preload/IPC 协议、Pet 麦克风采集、AI 请求主体、聊天持久化或样式；未连接真实麦克风/OpenTypeless 服务做端到端识别，实际服务兼容性仍由后续人工 ASR 回归矩阵验证。`ChatWindow.tsx` 后续继续拆分 AI/TTS hooks。

## P2-1：大型模块拆分与领域边界（第十六批）

- 验证日期：2026-07-13
- 拆分范围：Chat 分段 TTS renderer 生命周期、逐段揭示与事件订阅

| 检查 | 结果 |
| --- | --- |
| `npm test` | 37 个测试文件、142 个用例通过 |
| TTS 控制器测试 | pending/注册、乱序 segment 单调揭示、非法事件、注册前失败、结束回调、中断/停止清理和订阅注销通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | 真实 TTS JSON/二进制/流代理、Chat → Pet enqueue、Pet → Chat segmentStarted 和五类窗口运行通过 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；紧凑 Chat 统一停止同时取消任务并调用 `stopTtsAll`，默认/紧凑布局无回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-default-720x620-scale100.png`、`artifacts/ui-baseline/chat-compact-420x560-scale100.png`。本批未修改 TTS preload/IPC 协议、Pet 音频播放、文本分句算法、AI 请求协议、消息持久化或样式；未连接真实 GPT-SoVITS 服务和声卡做端到端音频播放，服务端兼容性、音频设备错误与长文本连续播放仍由后续人工 TTS 回归矩阵验证。`ChatWindow.tsx` 后续继续拆分 AI 请求与流式响应 hooks。

## P2-1：大型模块拆分与领域边界（第十七批）

- 验证日期：2026-07-13
- 拆分范围：Chat AI 请求生命周期、普通流式/非流式响应与消息落盘

| 检查 | 结果 |
| --- | --- |
| `npm test` | 38 个测试文件、150 个用例通过 |
| AI 控制器测试 | 新旧请求 loading 竞态、前后台统一中断、流式成功/部分失败、占位插入顺序、迟到结果、Live2D 标签去重、非流式 metadata 和上下文错误通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` | 真实 AI 普通/流代理、鉴权注入、TTS 双向 relay、Chat 持久化和五类窗口运行通过，renderer 无运行时错误 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；默认/紧凑 Chat 输入区、空态与停止交互无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-default-720x620-scale100.png`、`artifacts/ui-baseline/chat-compact-420x560-scale100.png`。本批未修改 AI HTTP/preload/IPC 协议、provider 请求体、planner/Tool Agent 决策、记忆召回、上下文压缩算法、TTS 分句算法、消息 schema 或样式。未连接真实 OpenAI-compatible/Claude 模型做端到端生成，真实 provider 的 SSE 分块差异、长响应网络中断和计费 usage 仍需后续人工 AI 回归矩阵验证；当前证据覆盖 renderer runner、打包后的主进程普通/流代理和窗口运行。

## P2-1：大型模块拆分与领域边界（第十八批）

- 验证日期：2026-07-13
- 拆分范围：Chat 上下文预算、MCP/记忆 addon、自动压缩与 usage 发布

| 检查 | 结果 |
| --- | --- |
| `npm test` | 39 个测试文件、158 个用例通过 |
| 上下文测试 | 文本/图片 token 估算、最近消息截断、内置/MCP 工具目录、真实/预测 usage、压缩成功/失败回退和 250ms 最新值发布通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功 |
| `npm run ipc:smoke` | 真实 AI 普通/流代理、鉴权注入、TTS 双向 relay、Chat 持久化和五类窗口运行通过，renderer 无运行时错误 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；默认/紧凑 Chat、状态面板和工具卡无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-default-720x620-scale100.png`、`artifacts/ui-baseline/chat-compact-420x560-scale100-expanded.png`、`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改 AI HTTP/preload/IPC 协议、provider 请求体、token 估算系数、上下文阈值默认值、planner/Tool Agent 决策、消息 schema、TTS/ASR 或样式；仅修复清空输入/关闭召回后的迟到记忆结果写回。未连接真实 OpenAI-compatible/Claude 模型触发超长上下文压缩，也未连接外部 MCP server 验证实时工具刷新；provider tokenizer 差异、专用压缩 profile 可用性和真实长会话压缩质量仍由后续 AI/MCP 人工回归矩阵验证。

## P2-1：大型模块拆分与领域边界（第十九批）

- 验证日期：2026-07-13
- 拆分范围：Task 持久化归一化、读写接口与异常退出恢复

| 检查 | 结果 |
| --- | --- |
| `npm test` | 40 个测试文件、163 个用例通过 |
| Task 存储测试 | 损坏记录拒绝、step/toolRun/usage 清洗、200 条上限、排序/查询、单次写入通知和 pending/running/paused 重启恢复通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功 |
| `npm run ipc:smoke` | 打包应用创建并完成无工具任务、重启后逐字段读取、dismiss 移除通过；Chat/Memory/AI/TTS 与五类窗口继续通过且无运行时错误 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；任务工具卡展开态、默认/紧凑 Chat 和状态面板无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改任务 store 文件名/schema、Task IPC 通道与返回值、任务创建字段、调度并发数、step 执行、Tool Agent、视觉回执、暂停/恢复/取消语义或样式。真实打包 smoke 覆盖正常完成任务的落盘、重启读取和删除；未通过强制杀进程制造正在执行的真实任务，pending/running/paused 崩溃恢复目前由注入 backend 的单元测试证明，暂停/恢复/取消、工具重试和长任务并发仍由后续 Task 状态机批次扩大验证。

## P2-1：大型模块拆分与领域边界（第二十批）

- 验证日期：2026-07-13
- 拆分范围：Task 运行时状态、暂停 waiter、取消回调与并发调度器

| 检查 | 结果 |
| --- | --- |
| `npm test` | 41 个测试文件、168 个用例通过 |
| Task 运行时测试 | runtime 复用/删除、多个暂停 waiter、恢复唤醒、取消异常隔离、并发槽位、最早 pending 优先和 kick 合并通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功，品牌图标与版本信息写入成功 |
| `npm run ipc:smoke` | 打包应用暂停后 180ms step 游标保持不变，恢复后 12 步完成，取消后 180ms 仍为 canceled，两条任务 dismiss 成功；其余 IPC、持久化、AI/TTS 代理和五类窗口继续通过且无运行时错误 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；任务工具卡、默认/紧凑 Chat 和状态面板无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改任务 store 文件名/schema、Task IPC 通道与返回值、任务字段、3 并发与 30ms 调度参数、step/tool 执行、Tool Agent、视觉回执或样式。打包 smoke 已覆盖无工具任务的真实暂停、恢复、取消和清理，但未让外部 CLI/MCP/浏览器工具在执行中接受取消，也未启动三条真实长任务验证并发交错；这些路径继续由现有执行器行为与本批调度选择单元测试保护，并在后续工具执行拆分批次扩大真实回归。

## P2-1：大型模块拆分与领域边界（第二十一批）

- 验证日期：2026-07-13
- 拆分范围：Task Agent 工具目录、native/text 名称解析与文本工具协议

| 检查 | 结果 |
| --- | --- |
| `npm test` | 42 个测试文件、174 个用例通过 |
| Agent 工具协议测试 | 内部名/native callName/供应商前缀、VCP 噪声、旧 fetch 别名、建议、完整/未闭合请求、JSON/文本输入、展示隐藏、稳定键、结果块和工具指南通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功，品牌图标与版本信息写入成功 |
| `npm run ipc:smoke` | 打包应用完成两轮 `agent.run` 文本协议：解析 TOOL_REQUEST、执行并记录 `delay.sleep`、回送 TOOL_RESULT、持久化最终答复并 dismiss；两轮密钥注入、原有任务生命周期和其余 IPC smoke 全部通过 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；任务工具卡、默认/紧凑 Chat 和状态面板无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改工具定义/schema、启用策略、Task IPC、任务存储、模型参数、最大回合、视觉回执或界面样式。打包 smoke 已覆盖 OpenAI-compatible 文本工具协议和真实内置工具执行，但未连接真实 provider 验证 native `tool_calls`/legacy `function_call`、Claude Messages 流事件或供应商特有分块；native 名称与前缀解析目前由新增单元测试覆盖，这些传输差异将在下一批 LLM provider/SSE 拆分时扩大回归。

## P2-1：大型模块拆分与领域边界（第二十二批）

- 验证日期：2026-07-13
- 拆分范围：Task Agent provider payload、SSE 分片、native 调用累加、usage 与重试策略

| 检查 | 结果 |
| --- | --- |
| `npm test` | 43 个测试文件、183 个用例通过 |
| Agent provider 协议测试 | OpenAI/Claude 端点与鉴权、Claude system/角色/文本/图片/thinking payload、重试状态/取消/网络错误/退避、usage、native/legacy 调用、分片名称/参数、SSE 缓冲和双 provider 流事件通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功，品牌图标与版本信息写入成功 |
| `npm run ipc:smoke` | OpenAI text 首次 503 后重试并跨 chunk 完成 TOOL_REQUEST/RESULT；native 分片 tool_calls 合并后执行 `delay.sleep` 并通过 role=tool 往返；Claude `/v1/messages`、x-api-key、payload、分片 SSE 和 3/4/7 usage 均通过 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；任务工具卡、默认/紧凑 Chat 和状态面板无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改 Task IPC、任务 store/schema、工具定义、模型配置字段、最大回合、视觉路由策略或界面样式。打包 smoke 使用本地可控 provider 验证了 OpenAI text/native、Claude Messages、503 重试和跨 chunk 分帧，但未连接真实云端 provider 覆盖其私有事件、代理中断、长流断线或限流头，也未在真实视觉请求失败时触发外挂 fallback；这些请求生命周期和视觉编排仍留在 `TaskService`，由下一批继续拆分并扩大故障回归。

## P2-1：大型模块拆分与领域边界（第二十三批）

- 验证日期：2026-07-13
- 拆分范围：Task Agent HTTP 请求生命周期、取消/超时/重试与视觉恢复重新请求

| 检查 | 结果 |
| --- | --- |
| `npm test` | 44 个测试文件、189 个用例通过 |
| Agent LLM client 测试 | 6 个用例通过：跨 chunk 文本工具截停、503 重试与退避回调、主动取消与清理、视觉恢复请求取消回调不被旧清理覆盖、native 分片 tool_calls 合并、Claude payload 与 3/4/7 usage |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功，品牌图标与版本信息写入成功 |
| `npm run ipc:smoke` | OpenAI text 首次 503 后重试并跨 chunk 完成 TOOL_REQUEST/RESULT；native 分片名称/参数合并后执行 `delay.sleep`，第二轮携带 role=tool；Claude `/v1/messages`、x-api-key、payload 和 3/4/7 usage 通过 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；任务工具卡、默认/紧凑 Chat 和状态面板无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改 Task IPC、任务 store/schema、工具定义、模型配置字段、最大回合、视觉路由决策、工具执行结果或界面样式。视觉恢复回归测试让第二次请求保持 pending，等待旧请求退出 `finally` 后再断言新取消回调仍然存在，直接证明旧清理不会再覆盖恢复请求。打包 smoke 使用本地可控 provider 覆盖 OpenAI text/native、Claude Messages、503 重试和跨 chunk 分帧；尚未连接真实云端 provider 验证代理中断、长流断线、限流头和供应商私有事件，也未用真实外挂视觉服务制造主视觉失败，相关外部差异继续作为后续回归风险保留。

## P2-1：大型模块拆分与领域边界（第二十四批）

- 验证日期：2026-07-13
- 拆分范围：Task Agent native/text 工具解析、去重、执行记录、错误缓存与视觉结果会话

| 检查 | 结果 |
| --- | --- |
| `npm test` | 45 个测试文件、195 个用例通过 |
| Agent 工具会话测试 | 6 个用例通过：native 参数与 toolRun 生命周期/未知调用、文本别名/同参去重、未知工具建议、失败结果缓存、模型安全输出与视觉 parts/证据顺序 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功，品牌图标与版本信息写入成功 |
| `npm run ipc:smoke` | 文本模式首次 503 后重试并完成 TOOL_REQUEST/RESULT；native 分片名称/参数合并后只执行一次 `delay.sleep`，第二轮携带 role=tool；Claude `/v1/messages`、x-api-key、payload 和 3/4/7 usage 通过 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；任务工具卡 running/done 展示、默认/紧凑 Chat 和状态面板无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改 Task IPC、任务 store/schema、工具定义/schema、模型配置、最大回合、消息角色、视觉路由决策或界面样式。独立工具会话测试证明成功和失败的同名同参调用均不会重复触发执行器，错误仍写入 toolRun 和模型上下文，视觉工具的模型安全文本与 image parts 保持同行传递；打包 smoke 则覆盖真实 `delay.sleep` 工具执行、文本/原生第二轮结果往返和持久化。尚未用真实 MCP 图片工具、浏览器截图或生图服务验证多图片产物，也未制造 native 失败后自动回退 text 并重放多个历史工具结果，相关组合路径继续由模块测试与后续循环拆分扩大覆盖。

## P2-1：大型模块拆分与领域边界（第二十五批）

- 验证日期：2026-07-13
- 拆分范围：Task Agent 流式草稿、Live2D 标签、usage 累加与最终回复证据策略

| 检查 | 结果 |
| --- | --- |
| `npm test` | 46 个测试文件、202 个用例通过 |
| Agent 会话状态测试 | 7 个用例通过：Live2D 标签清洗、流式/跨轮草稿、文本工具块隐藏、usage 累加、无 toolRun 操作声称与内部名拒绝、URL 证据/末轮净化、空答复回退草稿 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功，品牌图标与版本信息写入成功 |
| `npm run ipc:smoke` | 文本/native 工具结果第二轮往返与最终答复持久化通过；Claude `/v1/messages` 分段 usage 经会话累加后仍为 prompt 3、completion 4、total 7 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；流式草稿关联的任务工具卡、默认/紧凑 Chat 和状态面板无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改 Task IPC、任务 store/schema、工具定义、模型配置、最大回合、视觉路由、消息角色或界面样式。会话测试直接覆盖草稿锚定、工具协议隐藏、Live2D 元数据、usage 与最终回复防幻觉规则；打包 smoke 覆盖正常最终答复和 Claude usage 持久化，但未让可控 provider 故意输出内部工具名、虚假执行声明或未验证 URL，也未触发最大回合净化，相关异常分支目前由纯状态测试证明，后续循环拆分将把 provider 级失败/重答场景纳入集成回归。

## P2-1：大型模块拆分与领域边界（第二十六批）

- 验证日期：2026-07-13
- 拆分范围：Task Agent native/text 多轮循环、消息追加、取消门禁与 auto fallback

| 检查 | 结果 |
| --- | --- |
| `npm test` | 47 个测试文件、207 个用例通过 |
| Agent 循环 runner 测试 | 5 个用例通过：native role=tool 第二轮、文本工具/视觉 parts/usage、Claude 强制文本、thought_signature fallback 顺序、已取消任务不请求模型/不 fallback |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功，品牌图标与版本信息写入成功 |
| `npm run ipc:smoke` | 既有 text/native/Claude 路径通过；新增 auto 路径依次验证 native tool call、role=tool 后模拟 400、文本 TOOL_RESULT 重放，3 次请求且 `delay.sleep` 只执行一次 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；任务工具卡、默认/紧凑 Chat 和状态面板无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改 Task IPC、任务 store/schema、工具定义、模型配置、最大回合、视觉路由决策或界面样式。runner 单测覆盖模式选择、消息顺序、视觉 parts、usage、取消和 fallback 时序；扩展后的打包 smoke 进一步证明 native 已完成工具结果会在兼容失败后按文本协议重放，且不会重复执行工具。尚未在 auto fallback 场景中同时附带主模型图片、外挂视觉观察或多个工具结果，这些视觉/多结果组合将在下一批视觉会话拆分时扩大覆盖。

## P2-1：大型模块拆分与领域边界（第二十七批）

- 验证日期：2026-07-13
- 拆分范围：Task Agent 视觉 artifact、初始路由、主视觉恢复、`vision.look` 与 fallback 消息重建

| 检查 | 结果 |
| --- | --- |
| `npm test` | 48 个测试文件、214 个用例通过 |
| Agent 视觉会话测试 | 7 个用例通过：图片/持久化 artifact 归一化、ID 顺序与硬上限、main/fallback/off 初始路由、unsupported 剥离/外挂观察/能力更新、取消传播、`vision.look` 三类路由、工具图片 ID/组序号/安全输出 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功，品牌图标与版本信息写入成功 |
| `npm run ipc:smoke` | text/native/Claude 与 auto fallback 全部通过；auto 路径三次请求均携带真实本地 PNG 的 `image_url`，第二次模拟 400 后第三次同时重放图片和 `TOOL_RESULT`，`delay.sleep` 仅执行一次 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；任务工具卡、默认/紧凑 Chat 和状态面板无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改 renderer、preload API、Task IPC、任务 store/schema、工具 schema、模型设置字段、最大回合或界面样式。独立会话测试证明 artifact 顺序和严格校验、主/外挂/关闭路由、unsupported 恢复、取消传播及工具图片登记；打包 smoke 进一步证明主模型图片会跨 native continuation 与 text fallback 重建保留。尚未连接真实云端视觉 provider 或真实外挂 Profile 制造供应商特有错误，也未用真实 MCP 多图片、浏览器截图和生图服务覆盖同一轮多个视觉结果；这些外部组合仍作为后续集成风险保留。

## P2-1：大型模块拆分与领域边界（第二十八批）

- 验证日期：2026-07-13
- 拆分范围：Task step 状态机、直接 toolRun、暂停/取消门禁与统一收尾

| 检查 | 结果 |
| --- | --- |
| `npm test` | 49 个测试文件、220 个用例通过 |
| Task execution runner 测试 | 6 个用例通过：多 step 顺序/直接工具记录/agent.run 壳卡排除、空任务单次清理、暂停恢复、取消 step/toolRun 收尾、失败 task/step/toolRun、门禁期间任务删除 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功，品牌图标与版本信息写入成功 |
| `npm run ipc:smoke` | 暂停/恢复继续通过；活跃 step 取消后为 skipped；直接 `delay.sleep` 生成 done step/toolRun；未知 `missing.tool` 生成 failed task/step 与 error toolRun；既有 Agent text/native/auto/Claude 路径全部通过 |
| `npm run media:smoke` | 图片/视频托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；取消/成功/失败任务工具卡、默认/紧凑 Chat 和状态面板无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改 renderer、preload API、Task IPC、任务 store/schema、工具定义、Agent 消息协议、模型配置或界面样式。runner 单测和打包 smoke 共同覆盖暂停、取消、成功、失败、空任务和资源清理；取消中的 Agent 内部外部工具是否都能立即响应仍取决于各执行器的 Abort/stop 实现，真实 CLI/MCP/浏览器长任务中断和三个并发槽位的长时间交错仍是后续集成风险。

## P2-1：大型模块拆分与领域边界（第二十九批）

- 验证日期：2026-07-13
- 拆分范围：Task 工具结构化图片落盘、文本图片引用提取与模型视觉 parts

| 检查 | 结果 |
| --- | --- |
| `npm test` | 50 个测试文件、226 个用例通过 |
| Task tool media 测试 | 6 个用例通过：显式 JSON 字段与顺序、远程缩略图过滤、本地/localhost 提取、数量/大小/MIME/Base64/内容去重与安全文件名、结构化图片优先/文本回退、本地/file/data/HTTP 模型 parts、超限/缺失/SVG/无效输入跳过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功，品牌图标与版本信息写入成功 |
| `npm run ipc:smoke` | 新增真实 `file.read` 图片清单任务，task/step/toolRun 均为 done、`imagePaths` 命中本地 PNG、dismiss 清理成功；既有 Agent text/native/auto/Claude 与三次视觉重放全部通过 |
| `npm run media:smoke` | 图片/视频/Task 媒体托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；任务工具卡、默认/紧凑 Chat 和状态面板无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改 renderer、preload API、Task IPC、任务 store/schema、工具定义、Agent 消息协议、模型配置或界面样式。媒体模块单测覆盖受限落盘和模型输入边界，打包 smoke 直接证明普通工具文本中的本地图片能进入持久化 toolRun，并继续证明图片可跨 native continuation 与 text fallback 重放。尚未连接真实 MCP 多图片工具、浏览器截图、生图服务或真实外挂视觉 Profile 覆盖供应商特有 MIME/URL 与多图片故障组合，这些外部差异继续作为后续集成风险保留。

## P2-1：大型模块拆分与领域边界（第三十批）

- 验证日期：2026-07-13
- 拆分范围：Task 统一工具执行适配、直接 MCP 结构化图片与 MMVector 视频问答工作流

| 检查 | 结果 |
| --- | --- |
| `npm test` | 52 个测试文件、237 个用例通过 |
| Task tool execution adapter 测试 | 5 个用例通过：MCP detailed/结构化图片、内置运行时与 Skills 刷新、workflow/受检子工具调度、禁用 workflow、缺失 MCP manager |
| MMVector workflow 测试 | 6 个用例通过：本地视频缓存与参数边界、无命中结果、远程 Web Stream 下载、流式超限清理、缓存同名保护、取消与总超时 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功，品牌图标与版本信息写入成功 |
| `npm run ipc:smoke` | 真实 stdio MCP 服务连接成功；直接 MCP task 持久化 1 张结构化 PNG；Agent 实际调用 MMVector workflow 并完成两轮 TOOL_REQUEST/RESULT、done toolRun、最终输出与清理；既有 text/native/auto/Claude 路径全部通过 |
| `npm run media:smoke` | 图片/视频/Task 媒体托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；任务工具卡、默认/紧凑 Chat 和状态面板无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改 renderer、preload API、Task IPC、任务 store/schema、工具定义/schema、模型配置或界面样式。单元测试验证远程视频 Web Stream、大小限制和残留清理，打包 smoke 则证明真实 MCP 进程、直接结构化图片和 Agent workflow 调度契约。尚未连接真实 MMVector 数据库、真实视频下载源、FFmpeg 抽帧和云端视觉模型跑完整 Video QA，供应商输出差异、超大视频长时间取消和真实网络中断仍需后续人工集成回归。

## P2-1：大型模块拆分与领域边界（第三十一批）

- 验证日期：2026-07-13
- 拆分范围：Task Agent 请求/LLM 配置解析与 TaskStore 运行状态持久化

| 检查 | 结果 |
| --- | --- |
| `npm test` | 54 个测试文件、247 个用例通过 |
| Task agent run config 测试 | 5 个用例通过：主 AI 默认、请求/history/视觉与嵌套 API 覆盖、专用工具 AI 与 Skills、Claude/视觉能力 key、空请求与缺失 LLM 配置 |
| Task agent task state 测试 | 5 个用例通过：运行前重置、日志/进度节流与 presentation、toolRun 合并/图片路径、取消与 toolsUsed 去重、最终 Live2D/toolRuns/3-4-7 usage 持久化 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功，品牌图标与版本信息写入成功 |
| `npm run ipc:smoke` | text 503 重试、真实 MCP 图片、Agent MMVector workflow、native role=tool、带本地 PNG 的 auto fallback、Claude Messages 与 3/4/7 usage 全部通过，任务清理成功 |
| `npm run media:smoke` | 图片/视频/Task 媒体托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；任务工具卡、默认/紧凑 Chat 和状态面板无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改 renderer、preload API、Task IPC、任务 store/schema、工具定义/schema、模型参数含义、Agent 消息协议或界面样式。纯配置测试覆盖主/专用 provider 与覆盖优先级，状态测试覆盖节流、toolRun、presentation 和 usage；打包 smoke 进一步证明这些适配器在 text/native/auto/Claude 与真实 MCP 组合下没有改变持久化结果。真实云端 provider 的私有错误、长轮次 usage 差异和 Skills 大目录性能仍需后续人工集成回归。

## P2-1：大型模块拆分与领域边界（第三十二批）

- 验证日期：2026-07-14
- 拆分范围：Task Agent Skills 准备、Live2D/system/history 消息装配与 text fallback 工具结果回放

| 检查 | 结果 |
| --- | --- |
| `npm test` | 56 个测试文件、256 个用例通过 |
| Task agent Skills 准备测试 | 5 个用例通过：模型提示、verbose/disabled 诊断、冲突前 5 条与候选前 3 条、显式命令、24000 字符技能正文、读取失败、160 字符异常隔离 |
| Task agent 消息会话测试 | 4 个用例通过：persona/Live2D/工具事实/视觉/Skills/history 顺序、历史尾部去重、带图请求强制追加、fallback 原位重建与多工具结果顺序/截断 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功，品牌图标与版本信息写入成功 |
| `npm run ipc:smoke` | text 503 重试、真实 MCP 图片、Agent MMVector workflow、native role=tool、带本地 PNG 的 auto fallback、Claude Messages 与 3/4/7 usage 全部通过；fallback 后视觉和 TOOL_RESULT 均重放且工具只执行一次 |
| `npm run media:smoke` | 图片/视频/Task 媒体托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；无 console error、无横向溢出，任务工具卡、默认/紧凑 Chat 和状态面板无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-tool-card-720x620-scale100-open.png`。本批未修改 renderer、preload API、Task IPC、任务 store/schema、工具定义/schema、模型配置字段、视觉路由决策或 provider 传输协议。Skills 和消息会话的聚焦测试锁定了提示顺序、显式技能改写、异常降级和 fallback 回放；打包 smoke 进一步证明这些新边界在 text/native/auto/Claude、真实 MCP 与本地图片组合下不改变行为。尚未用真实超大 Skills 目录测量扫描性能，也未连接真实云端 provider 与外挂视觉 Profile 组合验证供应商私有错误；这些外部差异继续作为人工集成风险保留。

## P2-1：大型模块拆分与领域边界（第三十三批）

- 验证日期：2026-07-14
- 拆分范围：Memory SQLite 打开/关闭、schema 初始化、旧库兼容列、依赖索引与首次 FTS 回填

| 检查 | 结果 |
| --- | --- |
| `npm test` | 57 个测试文件、261 个用例通过 |
| Memory database 生命周期测试 | 5 个用例通过：全新 schema/PRAGMA/默认 persona、旧列回填与索引顺序、幂等/自定义 persona/更新触发器、旧 KG 实体 FTS、初始化失败关闭且保留原始错误 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建成功，品牌图标与版本信息写入成功 |
| `npm run ipc:smoke` | 启动前写入旧版 persona/memory schema；打包应用迁移后 persona 保留、memory rowid=1、`updatedAt=1783962569890`、`status=active`、`memoryType=other`、`pinned=0`、FTS hits=1，并由召回接口返回原正文；既有 Agent/MCP/媒体/任务路径全部通过 |
| `npm run media:smoke` | 图片/视频/Task 媒体托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；无 console error、无横向溢出，Memory 900x720 与 640x500 截图无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/memory-default-900x720-scale100.png`、`artifacts/ui-baseline/memory-min-640x500-scale100.png`。本批未修改 renderer、preload API、Memory IPC 契约、记忆业务字段含义、召回排序、保留策略、向量计算或界面样式。系统 Node 24 与仓库当前 Electron `better-sqlite3` 的 native ABI 不同，因此普通单测通过可注入构造器使用 Node 内置 SQLite 验证 schema 语义，不在 `npm test` 中执行昂贵 native 重建；Windows unpacked 打包和 IPC smoke 则使用生产 `better-sqlite3` 覆盖真实旧库迁移。尚未对极大旧库测量首次 FTS rebuild 时长，也未模拟迁移中途磁盘写满或损坏数据库；向量 worker、embedding 队列和混合召回仍留在 `MemoryService`，由下一批继续拆分。

## P2-1：大型模块拆分与领域边界（第三十四批）

- 验证日期：2026-07-14
- 拆分范围：Memory embeddings 配置/HTTP/归一化/LRU 与 vector worker 请求/超时/重启生命周期

| 检查 | 结果 |
| --- | --- |
| `npm test` | 59 个测试文件、268 个用例通过 |
| Memory Embedding 客户端测试 | 3 个用例通过：主/自定义配置与 endpoint、批内去重/LRU/鉴权/body、乱序 index、provider 错误和全零向量拒绝 |
| Memory Vector worker 客户端测试 | 4 个用例通过：懒启动/复用/并发 response id、worker error 后 pending 拒绝与重启、25ms 超时重建、close 与同步 `postMessage` 失败清理 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，主进程构建包含独立 `dist-electron/vectorSearchWorker.js`，`better-sqlite3` native 依赖重建与品牌元数据写入成功 |
| `npm run ipc:smoke` | 旧库迁移继续通过；新增真实向量路径 attempted=true、hits=1、两次查询均返回预置记忆、相同查询 embeddings API 仅请求 1 次、`memory-vector` secret 鉴权正确；既有 Agent/MCP/媒体/任务路径全部通过 |
| `npm run media:smoke` | 图片/视频/Task 媒体托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；无 console error、无横向溢出，Memory 900x720 截图无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/memory-default-900x720-scale100.png`。本批未修改 renderer、preload API、Memory IPC 契约、记忆 schema、向量模型设置含义、worker SQL/余弦评分、混合召回权重或界面样式。单元测试通过注入 fetch/worker 覆盖异常和生命周期，打包 smoke 则使用真实 Electron worker、生产 `better-sqlite3`、旧库 embedding BLOB 与加密自定义向量密钥证明端到端召回；重复查询只命中一次 API 直接验证共享 LRU 生效。尚未连接真实云端 embedding provider 测量限流、超时和超大批次，也未对十万级 embedding 扫描做耗时基线；索引维护候选、tag/KG 写入与混合召回编排仍留在 `MemoryService`，由下一批继续拆分。

## P2-1：大型模块拆分与领域边界（第三十五批）

- 验证日期：2026-07-14
- 拆分范围：Memory tag/embedding/KG pending 队列、Tag 候选选择、标签提取与事务持久化

| 检查 | 结果 |
| --- | --- |
| `npm test` | 61 个测试文件、274 个用例通过 |
| Memory 索引队列测试 | 3 个用例通过：rowid 去重/插入顺序/逐次 kick、tag/embedding/KG 隔离与 `enqueueAll`、无效 rowid/零 limit/关闭 kick |
| Memory Tag 索引测试 | 3 个用例通过：英文小写去重与中文 n-gram、pending 行事务重建/时间戳、禁用保留 pending、删除行过滤和唯一兜底批次 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker 和品牌元数据写入成功 |
| `npm run ipc:smoke` | 新增真实后台 Tag 维护：tag hits=2、目标记忆返回、SQLite 标签为 `camelcasemarker/ipc/maintenance/memory`、lowercaseOnly=true；旧库迁移、向量 worker/cache、Agent/MCP/媒体/任务路径全部通过 |
| `npm run media:smoke` | 图片/视频/Task 媒体托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；无 console error、无横向溢出，Memory 界面无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/memory-default-900x720-scale100.png`。本批未修改 renderer、preload API、Memory IPC 契约、数据库 schema、Tag 召回权重、向量/KG 设置或界面样式。Node SQLite 聚焦测试验证 pending 队列、候选排重和事务写入，打包 smoke 则通过真实应用 debounce 调度、生产 `better-sqlite3` 和 renderer 召回接口证明 Tag 索引确实落库并参与排序。现有英文混合大小写旧标签不会在本批主动全库清理，但相关记忆下次进入 pending 重建时会收敛为小写；Vector/KG 维护仍各自持有候选 SQL 和持久化流程，下一批继续抽离。

## P2-1：大型模块拆分与领域边界（第三十六批）

- 验证日期：2026-07-14
- 拆分范围：Memory Vector 后台索引的配置校验、候选选择、hash 判定与事务持久化

| 检查 | 结果 |
| --- | --- |
| `npm test` | 62 个测试文件、277 个用例通过 |
| Memory Vector 索引维护测试 | 3 个用例通过：禁用/缺模型/缺 API 时不消费 pending；pending/兜底排重、touch 与 embedding 落库；provider 失败无部分写入 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker 和品牌元数据写入成功 |
| `npm run ipc:smoke` | 真实后台 Vector 维护写入 model=`ipc-memory-vector-smoke`、dims=8、BLOB=32 bytes、content hash=40 字符；embeddings API 请求 1 次且鉴权正确；旧库迁移、Tag/向量召回、Agent/MCP/媒体/任务路径全部通过 |
| `npm run media:smoke` | 图片/视频/Task 媒体托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；无 console error、无横向或纵向溢出，Memory 100%/150%、Settings 与紧凑 Chat 截图无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/memory-default-900x720-scale100.png`、`artifacts/ui-baseline/memory-default-900x720-scale150.png`、`artifacts/ui-baseline/settings-default-860x680-scale100.png`、`artifacts/ui-baseline/chat-compact-420x560-scale100.png`。本批未修改 renderer、preload API、Memory IPC 契约、数据库 schema、向量设置字段含义、embedding HTTP 协议、混合召回权重或界面样式。聚焦测试验证配置失败不丢 pending、同批候选唯一、hash touch、精确 typed-array 字节范围和 provider 失败完整性；打包 smoke 通过真实后台 debounce、生产 `better-sqlite3` 和鉴权 embeddings API 证明索引确实异步落库。尚未连接真实云端 provider 测量限流/超时，也未对十万级待索引队列做吞吐基线；KG 抽取和图谱持久化仍留在 `MemoryService`，由下一批继续拆分。

## P2-1：大型模块拆分与领域边界（第三十七批）

- 验证日期：2026-07-14
- 拆分范围：Memory KG 候选/LLM 抽取/图谱事务持久化，以及英文实体 FTS 查询修复

| 检查 | 结果 |
| --- | --- |
| `npm test` | 64 个测试文件、284 个用例通过 |
| Memory KG 索引维护测试 | 4 个用例通过：配置失败保留 pending；pending/兜底排重、fresh hash 跳过与完整图谱落库；provider 逐行错误隔离；关系写入失败事务回滚 |
| Memory FTS 查询测试 | 3 个用例通过：英文单实体保持完整 token、多词 OR 与引号清理、中文无空格逐字扩展 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker 和品牌元数据写入成功 |
| `npm run ipc:smoke` | 真实后台 KG 维护写入 status=ok、40 字符 hash、Alice/Tea 两个实体和 `Alice likes Tea` 实体关系；目标抽取请求 1 次且鉴权/payload 正确；KG retrieval hits=1 并返回原记忆；旧库迁移、Tag/Vector、Agent/MCP/媒体/任务路径全部通过 |
| `npm run media:smoke` | 图片/视频/Task 媒体托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；无 console error、无横向或纵向溢出，Memory 100%/150% 与 Settings 截图无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/memory-default-900x720-scale100.png`、`artifacts/ui-baseline/memory-default-900x720-scale150.png`、`artifacts/ui-baseline/settings-default-860x680-scale100.png`。本批未修改 renderer、preload API、Memory IPC 契约、数据库 schema、KG 设置字段、抽取提示词、图谱表含义、混合召回权重或界面样式。Node SQLite 聚焦测试覆盖候选唯一性、JSON 兼容解析、实体/关系规范化、逐行 provider 错误和事务回滚；打包 smoke 则通过专用加密密钥、真实主进程调度、生产 `better-sqlite3`、FTS trigger 和 renderer 召回接口证明 KG 从抽取到召回闭环。端到端 smoke 发现并修复了英文无空格实体被逐字符拆分、导致 KG FTS 无法命中的旧问题。尚未连接真实云端 KG provider 验证供应商特有输出、限流和超时，也未做十万级实体/mention 的 FTS 与图谱召回基线；混合召回候选、评分排序和最终文本组装仍留在 `MemoryService`，由下一批继续拆分。

## P2-1：大型模块拆分与领域边界（第三十八批）

- 验证日期：2026-07-14
- 拆分范围：Memory 时间范围、FTS/LIKE/Tag/KG/Vector 混合召回、评分排序、文本预算与命中强化

| 检查 | 结果 |
| --- | --- |
| `npm test` | 65 个测试文件、290 个用例通过 |
| Memory 混合召回测试 | 6 个用例通过：persona 禁用/空查询人设、相对时间准确引用与命中强化、FTS+Tag+KG 候选合并、向量不足 fallback、向量故障降级、保留度衰减 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker 和品牌元数据写入成功 |
| `npm run ipc:smoke` | 旧库 FTS hits=1；向量 worker hits=1、重复查询 embeddings API requests=1；Tag hits=2；KG hits=1 且返回目标记忆；后台 Vector/KG 索引、Agent/MCP/媒体/任务与重启路径全部通过 |
| `npm run media:smoke` | 图片/视频/Task 媒体托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；无 console error、无横向或纵向溢出，Memory、Settings 与 Chat 截图无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/memory-default-900x720-scale100.png`、`artifacts/ui-baseline/memory-default-900x720-scale150.png`、`artifacts/ui-baseline/settings-default-860x680-scale100.png`。本批未修改 renderer、preload API、Memory IPC 契约、数据库 schema、召回设置字段、各层权重、排序公式、debug 字段、向量 worker 协议或界面样式。Node SQLite 聚焦测试直接覆盖 FTS、Tag、KG 表和强化 UPDATE，注入 embedding/vector 客户端覆盖按需调用与故障降级；打包 smoke 则复用生产 `better-sqlite3`、真实 worker、加密 embeddings/KG 密钥和 renderer IPC 证明旧库、四类候选与最终回执继续闭环。时间范围解析尚未在打包 smoke 中按系统时区逐项覆盖，真实十万级 FTS/Tag/KG/Vector 混合候选的延迟和 worker 扫描成本也未做基线；聊天/手工写入、向量去重、版本和冲突流程仍留在 `MemoryService`，由下一批继续拆分。

## P2-1：大型模块拆分与领域边界（第三十九批）

- 验证日期：2026-07-14
- 拆分范围：Memory 聊天/手工写入、embedding 即时水合、向量去重合并、记录读取与版本写入

| 检查 | 结果 |
| --- | --- |
| `npm test` | 66 个测试文件、296 个用例通过 |
| Memory 写入协调器测试 | 6 个用例通过：采集门禁/聊天 upsert、向量重复合并与重定向、手工重复刷新、键值替换/版本/索引、provider 故障降级、offset typed-array 精确 32 字节 BLOB |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker、品牌图标和版本元数据写入成功 |
| `npm run ipc:smoke` | 真实聊天持久化与重启、手工记忆 CRUD、versionCount=1、旧库 FTS、Tag/Vector/KG 后台索引与召回、Agent/MCP/媒体/任务路径全部通过 |
| `npm run media:smoke` | 图片/视频/Task 媒体托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；0 failure、0 console error、无横向或纵向溢出，Memory、Settings 与 Chat 截图无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/memory-default-900x720-scale100.png`、`artifacts/ui-baseline/memory-default-900x720-scale150.png`、`artifacts/ui-baseline/settings-default-860x680-scale100.png`、`artifacts/ui-baseline/chat-default-720x620-scale100.png`。本批未修改 renderer、preload API、Memory IPC 契约、SQLite schema、设置字段、去重阈值含义、索引队列语义或界面样式。Node SQLite 聚焦测试直接验证聊天与手工写入的数据库结果、版本行、软删除、队列和精确 BLOB；打包 smoke 使用生产 `better-sqlite3` 证明聊天摄取、手工写入、版本/索引/召回和重启路径继续闭环。尚未连接真实云端 embedding provider 验证语义相似度分布、限流与网络抖动，也未对 400 条候选扫描和高并发聊天写入建立性能基线；版本查询/回滚、冲突列表及 accept/merge/keepBoth 仍由 `MemoryService` 编排，下一批继续拆分并增加事务覆盖。

## P2-1：大型模块拆分与领域边界（第四十批）

- 验证日期：2026-07-14
- 拆分范围：Memory 普通编辑、版本查询/回滚、冲突列表与 ignore/accept/merge/keepBoth 事务处理

| 检查 | 结果 |
| --- | --- |
| `npm test` | 67 个测试文件、302 个用例通过 |
| Memory revision 协调器测试 | 6 个用例通过：非法/no-op/真实编辑、版本 limit/回滚审计、冲突过滤分页、ignore/accept/merge、keepBoth 边界、finalize 失败完整事务回滚 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker、品牌图标和版本元数据写入成功 |
| `npm run ipc:smoke` | 真实 Memory `update=true`、versionCount=1、CRUD、旧库 FTS、Tag/Vector/KG 后台索引与召回、聊天重启、Agent/MCP/媒体/任务路径全部通过 |
| `npm run media:smoke` | 图片/视频/Task 媒体托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；0 failure、0 console error、无横向或纵向溢出，Memory、Settings 与 Chat 截图无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/memory-default-900x720-scale100.png`、`artifacts/ui-baseline/memory-default-900x720-scale150.png`、`artifacts/ui-baseline/settings-default-860x680-scale100.png`、`artifacts/ui-baseline/chat-default-720x620-scale100.png`。本批未修改 renderer、preload API、Memory IPC 契约、SQLite schema、冲突字段含义、版本 reason/source 格式、索引队列种类或界面样式。Node SQLite 聚焦测试验证所有 revision 数据结果，并通过故意让 conflict finalize 失败证明正文更新、版本插入和冲突状态会一起回滚；打包 smoke 使用生产 `better-sqlite3` 验证真实更新与版本记录继续闭环。打包 smoke 尚未预置真实 `memory_conflict` 行逐项调用四种 IPC 动作，事务故障注入也只在 Node SQLite 适配器中执行；高并发冲突解决、重复处理同一 conflict 和极大版本历史查询仍需后续集成/性能回归。persona 管理、列表过滤、批量元数据、删除和保留度维护仍由 `MemoryService` 直接持有，下一批继续收口。

## P2-1：大型模块拆分与领域边界（第四十一批）

- 验证日期：2026-07-14
- 拆分范围：Memory persona CRUD、目录过滤/排序/批量管理/删除与保留度维护

| 检查 | 结果 |
| --- | --- |
| `npm test` | 70 个测试文件、314 个用例通过 |
| Memory Persona Store 测试 | 4 个用例通过：列表/布尔归一化、命名/默认名创建、部分更新与空名称保留、默认 persona 保护/自定义删除 |
| Memory Catalog 测试 | 5 个用例通过：组合过滤、置顶/状态排序与动态 retention、单条元数据边界、批量/过滤更新、非法 rowid 与显式/过滤删除 |
| Memory Retention 测试 | 3 个用例通过：弱旧记忆归档/置顶恢复/deleted 跳过、无变化跳过、批次中途失败完整回滚 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker、品牌图标和版本元数据写入成功 |
| `npm run ipc:smoke` | 真实 persona/Memory CRUD、`update=true`、metadata updated=1、versionCount=1、deleteMemory/deletePersona、旧库 FTS、Tag/Vector/KG 索引与召回及其余主流程全部通过 |
| `npm run media:smoke` | 图片/视频/Task 媒体托管、resourceId、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；0 failure、0 console error、无横向或纵向溢出，Memory、Settings 与 Chat 截图无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/memory-default-900x720-scale100.png`、`artifacts/ui-baseline/memory-default-900x720-scale150.png`、`artifacts/ui-baseline/settings-default-860x680-scale100.png`、`artifacts/ui-baseline/chat-default-720x620-scale100.png`。本批未修改 renderer、preload API、Memory IPC 契约、SQLite schema、过滤器字段含义、排序优先级、保留度公式或界面样式。Node SQLite 聚焦测试直接覆盖 persona、目录和 maintenance SQL，并通过非法 rowid 断言确认 rowid=1 不再被误更新/误删除；打包 smoke 使用生产 `better-sqlite3` 验证真实 persona 与 Memory 管理闭环。组合过滤仍使用现有 `%query%` LIKE 语义，未引入通配符转义或全文索引；极大目录的 COUNT+分页延迟、数千条批量元数据/删除以及长期 retention 批次吞吐尚未建立性能基线。`MemoryService` 已收口为数据库和领域对象生命周期/委托层，P2-1 后续转入 Orb 界面模块拆分。

## P2-1：大型模块拆分与领域边界（第四十二批）

- 验证日期：2026-07-14
- 拆分范围：Orb 共享消息文本工具、工具执行时长、图片/视频预览和附件源解析

| 检查 | 结果 |
| --- | --- |
| 聚焦测试 | `tests/chatMessages.test.ts` 与 `tests/orbMessageMedia.test.tsx` 共 7 个用例通过；覆盖工具边界逗号/冒号、小时/分钟/秒格式、resourceId API 参数、直接媒体源、失败降级和静态渲染 |
| `npm test` | 71 个测试文件、318 个用例通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker、品牌图标和版本元数据写入成功；renderer 主 chunk 约 1.41 MB，继续列入 P2-2 |
| `npm run ipc:smoke` | Orb preload 权限、ball/panel/ball 状态往返、overlay 设置/清理、真实附件 API、聊天/任务/Memory/Agent/MCP/TTS/ASR 与重启路径全部通过，所有窗口 runtimeErrors 为空 |
| `npm run media:smoke` | 图片 data URL、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 15 个场景通过；0 failure、0 console error、无横向或纵向溢出；人工检查 `orb-panel-560x720-scale100.png` 布局无回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

本批未修改 preload/API 契约、Orb 模式状态机、窗口尺寸、CSS class、会话持久化、任务结构或附件安全边界。共享文本函数由 Chat 与 Orb 共用，聚焦测试补齐中文逗号和冒号结束边界；媒体解析测试验证直接 URL 不触发 IPC、本地 path/resourceId 精确委托以及失败返回空源。组件把解析结果绑定到当前媒体 source key，依赖变化后的首帧不会复用旧源，并通过存活标记忽略过期 Promise；但当前 Node 测试环境未真实挂载 React DOM，因此 1 秒运行中计时刷新和连续快速切换多个本地媒体仍主要依赖实现审查与后续交互回归。Orb 主体仍有 2638 行，Ball/Bar/Panel、历史、图片查看器和消息操作将继续分批拆分；Chat/Orb 通用媒体 URL 缓存合并留到 P2-2。

## P2-1：大型模块拆分与领域边界（第四十三批）

- 验证日期：2026-07-14
- 拆分范围：Orb Ball 视图、不可达自绘菜单清理和 Ball UI baseline

| 检查 | 结果 |
| --- | --- |
| Orb Ball 视图测试 | 2 个用例通过：右侧 dock 静态 DOM/标题/图标、mouseup 屏幕坐标委托 |
| `npm test` | 72 个测试文件、320 个用例通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker、品牌图标和版本元数据写入成功；renderer 主 chunk 约 1.408 MB |
| `npm run ipc:smoke` | Orb ball/panel/ball 状态往返、overlay 设置/清理、`showOrbContextMenu` preload 权限及聊天/任务/Memory/Agent/MCP/TTS/ASR 与重启路径全部通过，所有窗口 runtimeErrors 为空 |
| `npm run media:smoke` | 图片 data URL、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 16 个场景通过；新增 `orb-ball-80x80-scale100`，0 failure、0 console error、无横向或纵向溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/orb-ball-80x80-scale100.png` 与 `artifacts/ui-baseline/orb-panel-560x720-scale100.png`。本批未修改 CSS、Orb 点击/拖拽阈值、dock side 判断、ball/bar/panel 状态迁移、主进程原生菜单实现或窗口尺寸；删除的两份自绘菜单 JSX 没有任何可达的状态写入，真实右键仍通过 `showOrbContextMenu` 闭环。服务端静态渲染测试验证 Ball DOM 和坐标适配，打包 IPC smoke 验证真实 Orb 状态往返，浏览器基线验证 80×80 小视口布局。当前自动化尚未模拟真实操作系统窗口上的长距离拖拽、多屏边界与不同 DPI 吸附位置；Bar 输入/附件、Panel 消息列表、历史 popover、图片查看器和消息菜单仍留在 `OrbApp`，下一批继续拆分。

## P2-1：大型模块拆分与领域边界（第四十四批）

- 验证日期：2026-07-14
- 拆分范围：Orb Bar 外壳、待发送附件、输入 DOM 事件与发送按钮

| 检查 | 结果 |
| --- | --- |
| Orb Bar 视图测试 | 3 个用例通过：附件前三项/`+N`/发送状态、历史锚点与 Enter/Escape、拖放媒体过滤与非法类型委托 |
| `npm test` | 73 个测试文件、323 个用例通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker、品牌图标和版本元数据写入成功；renderer 主 chunk 约 1.409 MB |
| `npm run ipc:smoke` | Orb ball/panel/ball 状态往返、真实聊天/附件/任务/Memory/Agent/MCP/TTS/ASR 与重启路径全部通过，所有窗口 runtimeErrors 为空 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 17 个场景通过；新增 `orb-bar-560x80-scale100`，Ball/Bar/Panel 均为 0 failure、0 console error、无横向或纵向溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/orb-bar-560x80-scale100.png` 与 `artifacts/ui-baseline/orb-panel-560x720-scale100.png`。本批未修改 Bar CSS、输入 placeholder、附件上限/存储结构、文件保存 API、发送取消条件、Enter/IME 门禁、Escape 收起、会话创建或历史 popover 时序。聚焦测试直接调用视图事件适配器验证锚点、键盘和拖放委托，媒体 smoke 继续验证生产附件保存与 URL 安全边界，独立 Bar 基线验证 560×80 窗口没有裁剪。当前自动化未在真实 Electron 输入框中注入操作系统剪贴板图片、拖拽超大视频或验证 IME 组合输入全过程；Panel 消息列表、工具卡、附件列表、历史 popover、图片查看器和消息操作仍留在 `OrbApp`，下一批继续拆分。

## P2-1：大型模块拆分与领域边界（第四十五批）

- 验证日期：2026-07-14
- 拆分范围：Orb Panel header、状态区、消息容器与行内编辑器

| 检查 | 结果 |
| --- | --- |
| Orb Panel 视图测试 | 3 个用例通过：标题/计数/空状态、用户 Markdown/助手内容/附件顺序、用户与助手编辑动作差异 |
| `npm test` | 74 个测试文件、326 个用例通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker、品牌图标和版本元数据写入成功；renderer 主 chunk 约 1.410 MB |
| `npm run ipc:smoke` | Orb ball/panel/ball 状态往返、真实聊天/任务/Memory/Agent/MCP/媒体/TTS/ASR 与重启路径全部通过，所有窗口 runtimeErrors 为空 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 17 个场景通过；Ball/Bar/Panel 均为 0 failure、0 console error、无横向或纵向溢出，Panel 截图无布局回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/orb-panel-560x720-scale100.png`。本批未修改 Panel CSS、会话标题/计数文案、用户/助手气泡 class、Markdown 规则、编辑 textarea 行数、保存/重发/取消语义、右键菜单动作或打开完整聊天后的 Bar 切换。服务端静态渲染测试覆盖消息与编辑状态，打包 IPC smoke 验证真实 Orb/Chat 状态往返，浏览器基线验证默认空会话 Panel。当前 UI baseline 尚未在 Orb Panel 中预置多条消息并实际触发行内编辑、右键菜单或工具卡展开；工具卡、附件列表、历史 popover、图片查看器和消息操作仍由 `OrbApp` 构造，下一批继续收口。

## P2-1：大型模块拆分与领域边界（第四十六批）

- 验证日期：2026-07-14
- 拆分范围：Orb 工具卡、助手消息 block、消息附件与内容归一化工具

| 检查 | 结果 |
| --- | --- |
| Orb 消息内容聚焦测试 | 5 个用例通过：结构化/legacy 附件及顺序、旧消息工具 block、Agent 外壳过滤、多 run 进度/失败状态、助手 block 与附件点击委托 |
| `npm test` | 75 个测试文件、331 个用例通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker、品牌图标和版本元数据写入成功；renderer 主 chunk 约 1.409 MB |
| `npm run ipc:smoke` | Orb ball/panel/ball 状态往返、真实聊天/任务/Memory/Agent/MCP/媒体/TTS/ASR 与重启路径全部通过，所有窗口 runtimeErrors 为空 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 18 个场景通过；新增 `orb-panel-content-560x720-scale100`，识别 2 条消息、1 张工具卡、2 个附件，0 failure、0 console error、无横向或纵向溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/orb-panel-content-560x720-scale100.png` 与 `artifacts/ui-baseline/orb-panel-560x720-scale100.png`。本批未修改 Orb Panel CSS、消息气泡 class、Markdown 规则、任务/消息持久化结构、附件 API、安全边界、工具运行状态文案或图片查看器缩放逻辑；缺失任务文案只补齐原本遗漏的右括号，多 run 顶层 key 只消除 React 列表告警。聚焦测试验证纯归一化和服务端静态渲染，打包 IPC smoke 验证真实 Orb preload 与任务/附件链路，浏览器基线验证有内容 Panel 的工具图片和消息图片均实际渲染。当前自动化尚未在真实 Electron Orb 中点击视频、跨多张工具图片导航、展开工具详情、触发行内编辑或右键消息菜单；历史 popover、图片查看器外壳和消息操作仍留在 `OrbApp`，下一批继续拆分。

## P2-1：大型模块拆分与领域边界（第四十七批）

- 验证日期：2026-07-14
- 拆分范围：Orb 图片查看器 UI、缩放/循环导航/键盘交互与 UI baseline 控制台门禁

| 检查 | 结果 |
| --- | --- |
| Orb 图片查看器测试 | 3 个用例通过：任意偏移循环索引、0.2 至 6 倍缩放边界、单图 DOM、多图选中项与前后导航 DOM |
| `npm test` | 76 个测试文件、334 个用例通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker、品牌图标和版本元数据写入成功；renderer 主 chunk 约 1.409 MB |
| `npm run ipc:smoke` | Orb ball/panel/ball 状态往返、真实聊天/任务/Memory/Agent/MCP/媒体/TTS/ASR 与重启路径全部通过，所有窗口 runtimeErrors 为空 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 19 个场景通过；新增 `orb-image-viewer-560x720-scale100`，D 键完成 `1/2 → 2/2`，滚轮缩放 `1 → 1.1`、1:1 重置和 Esc 关闭通过，0 failure、0 console error、无横向或纵向溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/orb-image-viewer-560x720-scale100-open.png`、`artifacts/ui-baseline/orb-image-viewer-560x720-scale100.png` 与 `artifacts/ui-baseline/orb-panel-content-560x720-scale100.png`。本批未修改查看器 CSS、标题/计数/提示文案、缩放倍率与上下界、循环导航语义、附件 URL API 或打开入口；只把已有状态和 JSX 迁移到独立组件，并移除会触发 passive-listener 错误的无必要 `preventDefault()`。聚焦测试验证纯索引/缩放函数和静态 DOM，浏览器基线使用两张真实 data URL 图片验证切换、缩放、重置、关闭及打开态布局，打包 IPC/媒体 smoke 继续验证生产附件解析与安全边界。当前自动化尚未在真实 Electron Orb 中验证鼠标连续快速滚轮、超高分辨率图片显存占用或查看器打开期间窗口状态切换；历史 popover 与消息菜单仍留在 `OrbApp`，下一批继续拆分。

## P2-1：大型模块拆分与领域边界（第四十八批）

- 验证日期：2026-07-14
- 拆分范围：Orb 消息右键菜单视图、角色动作差异与根容器边缘定位

| 检查 | 结果 |
| --- | --- |
| Orb 消息菜单测试 | 3 个用例通过：助手/用户动态高度钳制、NaN/Infinity 坐标兜底、固定几何 DOM、助手复制项和用户四动作委托 |
| `npm test` | 77 个测试文件、337 个用例通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker、品牌图标和版本元数据写入成功；renderer 主 chunk 约 1.410 MB |
| `npm run ipc:smoke` | Orb ball/panel/ball 状态往返、真实聊天/任务/Memory/Agent/MCP/媒体/TTS/ASR 与重启路径全部通过，所有窗口 runtimeErrors 为空 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 20 个场景通过；新增 `orb-message-menu-560x720-scale100`，助手菜单 5 项、边界 `362/514/550/712`、编辑初值、用户 4 项和点外关闭通过，0 failure、0 console error、无横向或纵向溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/orb-message-menu-560x720-scale100-assistant.png`、`artifacts/ui-baseline/orb-message-menu-560x720-scale100.png` 与 `artifacts/ui-baseline/orb-panel-content-560x720-scale100.png`。本批未修改菜单 CSS、宽度/行高/内边距/圆角、动作文案与顺序、复制实现、编辑/重发/删除业务、任务取消或消息持久化；只把菜单 DOM 和角色相关定位公式迁移到独立模块。聚焦测试验证纯定位边界与动作委托，浏览器基线使用原生 contextmenu 坐标验证右下角钳制、助手/用户菜单差异、编辑入口和点外关闭，打包 IPC smoke 继续验证真实 Orb/Chat 消息与任务链路。当前自动化未实际授权系统剪贴板验证“复制正文”内容，也未执行重发、删除此条和删除本轮的破坏性动作；历史 popover 仍留在 `OrbApp`，下一批继续拆分。

## P2-1：大型模块拆分与领域边界（第四十九批）

- 验证日期：2026-07-14
- 拆分范围：Orb 历史 popover 视图、定位与会话过滤/排序工具，以及选择/删除/查看全部交互基线

| 检查 | 结果 |
| --- | --- |
| Orb 历史 popover 测试 | 3 个用例通过：左右边缘/NaN 定位、persona 过滤/更新时间排序/8 项上限/默认值、列表/加载/空状态/三项动作委托与删除按钮可访问名称 |
| `npm test` | 78 个测试文件、340 个用例通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，`better-sqlite3` native 依赖重建、独立 vector worker、品牌图标和版本元数据写入成功；renderer 主 chunk 约 1.410 MB |
| `npm run ipc:smoke` | Orb ball/panel/ball 状态往返、真实聊天/任务/Memory/Agent/MCP/媒体/TTS/ASR、会话删除权限和重启路径全部通过，所有窗口 runtimeErrors 为空 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 21 个场景通过；新增 `orb-history-popover-560x720-scale100`，persona 过滤、更新时间顺序、空/4 消息计数、几何/箭头、选择、删除和查看全部通过，0 failure、0 console error、无横向或纵向溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/orb-history-popover-560x720-scale100-open.png` 与 `artifacts/ui-baseline/orb-history-popover-560x720-scale100.png`。本批未修改 popover CSS、宽度/圆角/行高/箭头样式、会话持久化契约、persona 归属、当前会话切换、删除后的模式迁移或打开完整聊天语义；只把视图和纯定位/列表映射迁移到独立模块，并为删除图标按钮补充可访问名称。聚焦测试覆盖纯函数、静态 DOM 与事件委托，浏览器基线验证其他 persona 干扰项被过滤、较早会话可选择和删除、删除后列表刷新、查看全部只触发一次。当前自动化未模拟删除 IPC 失败后的真实网络/主进程异常，也未验证超过 8 个会话时用户滚动或在真实 Electron 多屏/DPI 环境中的历史锚点；`OrbApp` 仍有 1938 行，下一批继续审计剩余状态与副作用边界。

## P2-2：前端加载与运行性能（第五十批）

- 验证日期：2026-07-14
- 优化范围：六类 renderer 窗口按路由加载、Pet/Pixi/Live2D 运行时隔离、共享设置订阅收窄和资源加载 UI 门禁

| 检查 | 结果 |
| --- | --- |
| Vite renderer bundle | 主 JS `1410.00 kB → 146.22 kB`，约下降 89.6%；主 CSS `87.49 kB → 41.90 kB`；生成 Chat 125.94 kB、Settings 126.23 kB、Memory 31.04 kB、Orb 49.77 kB、Pet/Pixi 710.28 kB、Markdown 160.49 kB 等按需 chunk |
| `npm test` | 78 个测试文件、340 个用例通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，动态 chunk、Live2D 公共运行时、`better-sqlite3` native 依赖、独立 vector worker、品牌图标和版本元数据全部写入成功 |
| `npm run ipc:smoke` | packaged `file://` 下 Pet 动态运行时与五类受检窗口 preload 正常；Pet/Chat/Settings/Memory/Orb runtimeErrors 全为空，聊天/任务/Memory/Agent/MCP/TTS/ASR、权限和重启路径全部通过 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 22 个场景通过；新增 `pet-shell-300x500-scale100` 并实际渲染默认 Live2D 模型，资源门禁确认主 chunk 为 146216 bytes、各路由只加载目标 chunk、非 Pet 路由不加载 Pet/Pixi 或两份 Live2D 运行时；0 failure、0 console error、无横向或纵向溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/pet-shell-300x500-scale100.png`，以及本轮重新生成的 Chat、Settings、Memory 与 Orb 默认尺寸截图。窗口 DOM、现有 CSS、preload/API 契约、路由 hash、Live2D 模型选择与 Pixi CSP 安装逻辑未改变；Pet 仍加载两套本地 Live2D 运行时，但只在 Pet 路由并行加载，随后才导入 Pet/Pixi chunk。资源基线直接读取浏览器 `performance` 条目，验证运行时实际请求而非只依赖构建文件名；打包 IPC smoke 进一步验证 `document.baseURI` 在 `app.asar/dist/index.html` 的 `file://` 路径下可正确定位 `dist/lib`。当前未建立精确的窗口首帧耗时统计，首次 Pet 打开仍需加载约 710 kB Pet/Pixi chunk 和约 336 kB Live2D 运行时；Settings 首包仍包含全部大页组件，下一批继续拆分。

## P2-2：前端加载与运行性能（第五十一批）

- 验证日期：2026-07-14
- 优化范围：Settings 11 个大页按当前视图加载，以及搜索/导航/确认交互的异步挂载资源门禁

| 检查 | 结果 |
| --- | --- |
| Settings renderer bundle | `SettingsWindow` 外壳 `126.23 kB → 15.29 kB`；默认 `Live2DTab` 3.77 kB；其余 Tab 独立为 1.23 至 24.23 kB，AI 24.23 kB、Persona 22.56 kB、Tools 19.30 kB 不再进入首屏 |
| `npm test` | 78 个测试文件、340 个用例通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，Settings 外壳和 11 个 Tab 动态 chunk、Live2D 运行时、native 依赖、vector worker 与品牌元数据全部写入成功 |
| `npm run ipc:smoke` | packaged Settings preload、直接导航与所有受检窗口运行正常；Pet/Chat/Settings/Memory/Orb runtimeErrors 全为空，聊天/任务/Memory/Agent/MCP/TTS/ASR、权限和重启路径全部通过 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 22 个场景通过；四个 Settings 首屏均只加载 `SettingsWindow + Live2DTab`，AI/Persona/Tools/WorldBook 未预载；默认交互场景随后按需出现 `AiTab`、`PersonaTab`、`WorldBookTab`，搜索、深层锚点、确认框和 AI 四视图通过；0 failure、0 console error、无横向或纵向溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/settings-default-860x680-scale100.png` 与 `artifacts/ui-baseline/settings-default-860x680-scale100-ai-generation.png`。本批未修改 Settings 导航分组、默认 Live2D 页、Tab props、搜索索引、锚点匹配、保存代理、确认语义、样式 class 或 preload/API 契约；局部 `Suspense` 只替换内容页，标题、侧栏、搜索框和保存状态保持常驻。浏览器基线在资源快照后继续执行直接 IPC 导航、endpoint 搜索与保存、Persona 文本向量深层搜索、WorldBook 删除确认和 AI 四视图切换，证明 lazy 挂载没有丢失锚点、状态或确认回调。当前 Suspense fallback 为空，极慢磁盘下首次切换到未加载 Tab 时内容区可能短暂留白；尚未采集每个 Tab 的首帧耗时。下一批继续隔离 Markdown/remark-gfm 共享 chunk。

## P2-2：前端加载与运行性能（第五十二批）

- 验证日期：2026-07-14
- 优化范围：Chat/Orb 消息 Markdown renderer 按首次消息渲染加载，以及空消息窗口与预置消息窗口的运行时资源门禁

| 检查 | 结果 |
| --- | --- |
| Markdown renderer bundle | 独立 `MarkdownMessage` chunk 160.55 kB，延迟入口 0.69 kB；renderer 主 chunk 146.26 kB、Chat 125.99 kB、Orb 49.78 kB；空 Chat/Orb 首屏不再加载 `react-markdown`/GFM |
| Markdown 聚焦测试 | 4 个测试文件、14 个用例通过；覆盖 GFM、任务列表、安全外链、`<think>` Markdown 与 Chat/Orb fallback 内容顺序 |
| `npm test` | 79 个测试文件、342 个用例通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，Markdown 动态 chunk、Chat/Orb 路由 chunk、Live2D 运行时、native 依赖、vector worker 与品牌元数据全部写入成功 |
| `npm run ipc:smoke` | packaged Pet/Chat/Settings/Memory/Orb preload 与运行正常，五类窗口 `runtimeErrors` 全为空；聊天/任务/Memory/Agent/MCP/TTS/ASR、权限、持久化与重启路径全部通过 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 22 个场景通过；只有 5 个预置消息场景加载 `MarkdownMessage-*`，空 Chat/Orb 场景均未加载；0 failure、0 console error、无横向或纵向溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-default-720x620-scale100.png` 与 `artifacts/ui-baseline/orb-panel-content-560x720-scale100.png`。本批未修改 Markdown 解析规则、链接安全属性、`<think>` 折叠语义、消息 block/附件顺序、Chat/Orb 持久化结构、preload/API 契约或工具卡行为；只把重量级解析器放到浏览器动态边界之后。加载期间会短暂显示原始 Markdown 标记，但文本、换行和长词折行保持可读，chunk 完成后替换为原 `MarkdownMessage` 输出。当前尚未采集低速磁盘或冷缓存环境下 fallback 的可见时长，也未对超长会话进行虚拟化；下一批继续评估长列表与隐藏窗口运行成本。

## P2-2：前端加载与运行性能（第五十三批）

- 验证日期：2026-07-14
- 优化范围：Memory Console 自动刷新与 Orb 运行工具时长在隐藏窗口中的轮询暂停和恢复同步

| 检查 | 结果 |
| --- | --- |
| 可见性 interval 聚焦测试 | 2 个测试文件、5 个用例通过；共享调度器覆盖可见计时、隐藏暂停、恢复立即刷新、初始隐藏、卸载清理，Orb 固定时长渲染无回归 |
| Renderer bundle | 共享 `useVisibleInterval` chunk 0.77 kB；Memory Console 30.94 kB、Orb 49.74 kB、renderer 主 chunk 146.30 kB |
| `npm test` | 80 个测试文件、344 个用例通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，可见性 hook、Memory/Orb 动态 chunk、native 依赖、vector worker 与品牌元数据全部写入成功 |
| `npm run ipc:smoke` | packaged Pet/Chat/Settings/Memory/Orb preload 与运行正常，五类窗口 `runtimeErrors` 全为空；聊天/任务/Memory/Agent/MCP/TTS/ASR、权限、持久化与重启路径全部通过 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 22 个场景通过；0 failure、0 console error、无横向或纵向溢出，既有路由与 Markdown 资源门禁继续通过 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/memory-default-900x720-scale100.png` 与 `artifacts/ui-baseline/orb-panel-content-560x720-scale100.png`。本批未修改自动刷新周期、Memory 查询参数与 loading 防重入、手动刷新、工具卡文案/状态/展开行为或完成时长计算；只改变周期任务在页面不可见时的生命周期。纯调度测试以可控时钟和可见性源证明隐藏期间没有 callback，恢复时立即调用并重新计时；浏览器和 packaged smoke 证明接入后没有渲染或运行错误。当前自动化尚未驱动真实 Windows 最小化/恢复并采集 IPC 调用计数，也未覆盖操作系统休眠后恢复的计时偏差；超长 Chat/Orb 会话列表仍未窗口化。

## P2-2：前端加载与运行性能（第五十四批）

- 验证日期：2026-07-14
- 优化范围：Chat/Orb 超长会话渐进式尾部窗口、旧消息加载滚动锚定与长历史 UI 门禁

| 检查 | 结果 |
| --- | --- |
| 消息窗口聚焦测试 | 3 个测试文件、11 个用例通过；覆盖最新 60 条、扩展到 120 条、短会话全量、Orb 加载委托与既有 Chat/Orb 消息渲染 |
| Renderer bundle | renderer 主 chunk 146.30 kB、Chat 126.44 kB、Orb 50.25 kB；共享渐进窗口逻辑进入 Chat/Orb 公共小 chunk |
| `npm test` | 81 个测试文件、348 个用例通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，Chat/Orb 渐进窗口、动态 chunk、native 依赖、vector worker 与品牌元数据全部写入成功 |
| `npm run ipc:smoke` | packaged Pet/Chat/Settings/Memory/Orb preload 与运行正常，五类窗口 `runtimeErrors` 全为空；聊天/任务/Memory/Agent/MCP/TTS/ASR、权限、持久化与重启路径全部通过 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 24 个场景通过；新增 Chat/Orb 各 180 条消息场景，初始 60 条、加载后 120 条、剩余计数 120→60，锚点偏移均为 0.625px；0 failure、0 console error、无横向或纵向溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查截图：`artifacts/ui-baseline/chat-long-history-720x620-scale100-window.png`、`artifacts/ui-baseline/chat-long-history-720x620-scale100-expanded.png`、`artifacts/ui-baseline/orb-long-history-560x720-scale100-window.png` 与 `artifacts/ui-baseline/orb-long-history-560x720-scale100-expanded.png`。本批未截断会话存储、AI 上下文或任务/附件数据，也未修改编辑、删除、重发、右键菜单和会话计数语义；只限制初始消息 DOM，并允许用户显式向前扩展。Chat 去掉平滑自动滚动后，消息更新仍立即定位到底部，但不再维持可能与用户滚动冲突的长动画。当前方案不是可变高度虚拟列表：用户反复点击后仍可把全部历史挂载到 DOM，超大单条 Markdown/媒体消息的自身解析成本也没有降低；尚未覆盖数千条消息、操作系统级滚轮连发或加载旧消息同时收到新流式 delta 的真实交互。

## P2-2：前端加载与运行性能（第五十五批）

- 验证日期：2026-07-14
- 优化范围：renderer 本地媒体 URL/data URL 共享缓存、并发去重、过期刷新与媒体源切换一致性

| 检查 | 结果 |
| --- | --- |
| 共享媒体缓存测试 | 4 个用例通过；覆盖并发 URL/data URL 去重、同步缓存读取、5 秒过期保护窗刷新、直接来源绕过 IPC、失败后重试 |
| 媒体组件聚焦回归 | Orb 媒体、Markdown、Chat 附件和工具卡既有 12 个用例通过；path/resourceId 委托、直接 URL、失败空源和安全外链无回归 |
| Renderer bundle | 主 chunk 146.30 kB；Chat 125.81 kB、Orb 49.63 kB、Markdown 160.34 kB，共享媒体/渐进窗口小 chunk 3.35 kB |
| `npm test` | 82 个测试文件、352 个用例通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过，共享媒体缓存、Chat/Orb/Markdown 动态 chunk、native 依赖、vector worker 与品牌元数据全部写入成功 |
| `npm run ipc:smoke` | packaged Pet/Chat/Settings/Memory/Orb preload 与运行正常，五类窗口 `runtimeErrors` 全为空；聊天/任务/Memory/Agent/MCP/TTS/ASR、权限、持久化与重启路径全部通过 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 24 个场景通过；既有媒体查看器、工具卡、Markdown 资源门禁和长历史窗口门禁继续通过；0 failure、0 console error、无横向或纵向溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

本批未修改主进程媒体注册表、token 签发、路径越界校验、伪造 source path 拒绝、Range 响应或删除语义；共享缓存位于每个 renderer 自身的 JS 上下文内，不跨 BrowserWindow 共享，也不会绕过首次 IPC 安全验证。URL 只在服务端过期时间距离当前超过 5 秒时缓存，失败与空结果不缓存；data URL 使用 60 秒短 TTL 和 32 项上限。当前尚未通过浏览器场景直接统计重复 IPC 次数，主要证据来自可控 API mock 的并发/过期测试与 packaged 媒体 smoke；若同一路径文件在 60 秒内被原地覆盖，已缓存 data URL 可能短暂显示旧内容。

## P2-2：前端加载与运行性能（第五十六批）

- 验证日期：2026-07-14
- 优化范围：五类 renderer 窗口启动/首帧耗时采集命令、重复采样统计与 P2-2 性能证据收口

| 检查 | 结果 |
| --- | --- |
| `npm run perf:startup` | 生产构建通过；Pet、Chat、Settings、Memory、Orb Panel 各 1 次预热、5 个全新 browser context 有效样本，0 console/page error、0 缺失样本 |
| 首帧定义 | 路由专属 ready selector 可见后的第二个 `requestAnimationFrame`；不会把空 `#root` 或 Orb Panel 前的初始外壳记为目标窗口首帧 |
| 首帧中位数/P95 | Pet 167.9/179.72ms；Chat 123.6/134.88ms；Settings 118.1/120.08ms；Memory 137.5/148.44ms；Orb Panel 118.5/130.24ms |
| 中位资源数/解码体积 | Pet 42/4712.39 KiB；Chat 13/386.94 KiB；Settings 6/206.72 KiB；Memory 7/236.74 KiB；Orb Panel 10/297.21 KiB |
| 连续复测稳定性 | 同一生产构建按最终 selector 方法连续五轮中位数最大跨度约 7.3% 至 16.5%；最终报告保存在 `artifacts/window-startup/report.json` |
| Renderer bundle | 主 chunk 146.30 kB；Chat 125.81 kB、Settings 15.29 kB、Memory 30.94 kB、Orb 49.63 kB、Pet/Pixi 710.32 kB、Markdown 160.34 kB |
| `npm test` | 82 个测试文件、352 个用例通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `npm run build:unpacked` | Windows unpacked 包通过，动态 chunk、Live2D 运行时、native 依赖、vector worker 与品牌元数据全部写入成功 |
| `npm run ipc:smoke` | packaged Pet/Chat/Settings/Memory/Orb preload 与运行正常，五类窗口 `runtimeErrors` 全为空；聊天/任务/Memory/Agent/MCP/TTS/ASR、权限、持久化与重启路径全部通过 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 原有 24 个场景全部通过；0 failure、0 console error、无横向或纵向溢出，资源门禁、Settings 懒加载、长历史与媒体交互无回归 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

`perf:startup` 复用现有 UI baseline mock 和 Playwright 浏览器路径，默认样本数为 5，可通过 `NDP_STARTUP_SAMPLES` 调整到 3 至 20；每个样本创建独立 browser context，降低 HTTP 缓存复用对路由 chunk 测量的干扰。报告同时记录 FP/FCP、DOMContentLoaded、load、资源数量、transferSize、decodedBodySize，以及每项中位数、P95、最小值和最大值。透明 Canvas/Pet 与部分 Orb 场景可能没有 Chromium `first-contentful-paint` 条目，因此路由专属 ready selector 首帧是主指标；这套浏览器基线衡量 renderer 生产资源的导航到目标界面时间，不包含 Electron 进程冷启动、BrowserWindow 原生创建、杀毒软件扫描、GPU 驱动初始化或真实 IPC/磁盘数据延迟。独立 context 也无法消除操作系统文件缓存和 CPU 调度差异，P95 对五样本中的单次尖峰尤其敏感；后续判断回归时应比较多轮中位趋势，再检查 P95 和原始样本。

## P2-3：无障碍与交互一致性（第五十七批）

- 验证日期：2026-07-14
- 优化范围：Chat 头像、Chat/Orb 图片与视频入口、工具图片和错误提示关闭按钮的原生控件语义与键盘路径

| 检查 | 结果 |
| --- | --- |
| 可点击元素审计 | Chat/Orb 本批目标目录中的操作型头像、图片和工具媒体已改为原生 `button`；仅剩图片查看器 backdrop/shell 的关闭与阻止冒泡 `div`，留给弹窗焦点批次 |
| Accessible name | 用户/助手头像、Chat 图片序号、Orb 消息图片、工具图片、视频打开和错误提示关闭均有明确名称 |
| 聚焦回归 | `chatMessageBody`、`chatMessageAttachments`、`orbMessageContent`、`orbMessageMedia` 共 15 个用例通过；验证 button 类型、名称、媒体委托和既有解析 |
| Renderer bundle | 主 chunk 146.30 kB；Chat 126.04 kB、Orb 49.83 kB；主 CSS 42.69 kB、Orb CSS 37.44 kB |
| `npm test` | 82 个测试文件、352 个用例通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npm run build:unpacked` | Windows unpacked 包通过，按钮语义、动态 chunk、native 依赖、vector worker 与品牌元数据全部写入成功 |
| `npm run ipc:smoke` | packaged Pet/Chat/Settings/Memory/Orb preload 与运行正常，五类窗口 `runtimeErrors` 全为空；权限、持久化、聊天/任务/Memory/Agent/MCP/TTS/ASR 和重启路径全部通过 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 24 个场景通过；Chat 图片按钮和 Orb 工具图片按钮均通过焦点 + Enter 打开查看器，Orb 下一张按钮通过 Enter 切换到 2/2；0 failure、0 console error、无横向或纵向溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查 `artifacts/ui-baseline/chat-image-viewer-720x620-scale100.png`、`artifacts/ui-baseline/orb-image-viewer-560x720-scale100.png` 与 `artifacts/ui-baseline/orb-image-viewer-560x720-scale100-open.png`，按钮 reset 未引入默认边框、额外 padding 或卡片尺寸变化。Chat 图片仍保留图片本体和“查看”文字按钮两条入口；Orb 视频 controls 不再与整卡点击竞争，用户可通过底部文件名按钮打开独立媒体。当前尚未实现图片查看器/确认对话框的初始焦点、focus trap、关闭后焦点恢复或 backdrop dialog 语义；Orb 查看器从新图片按钮打开后，全局 A/D 快捷键在焦点仍留于弹窗外时不稳定，本批 UI 门禁改为聚焦查看器原生“下一张”按钮并按 Enter，下一批随焦点管理统一解决。

## P2-3：无障碍与交互一致性（第五十八批）

- 验证日期：2026-07-14
- 优化范围：Chat/Settings 确认框与 Chat/Orb 图片查看器的初始焦点、Tab 循环、Esc 关闭、关闭后焦点恢复和 dialog 语义

| 检查 | 结果 |
| --- | --- |
| 共享焦点管理 | 新增 `useDialogFocus`；打开时记录触发控件并在下一帧聚焦指定按钮，Tab/Shift+Tab 在可见可用控件首尾循环，Esc 调用最新关闭回调，卸载后以 microtask 恢复焦点；StrictMode cleanup 不会把焦点错误拉回仍挂载的弹窗外 |
| 接入范围 | Chat 清空确认框初始聚焦“清空对话”并显式返回“更多”；Settings 通用确认框初始聚焦确认动作并返回原触发按钮；Chat/Orb 图片查看器初始聚焦“关闭”，关闭后返回对应图片附件按钮 |
| Dialog 语义 | Chat/Orb 图片查看器 shell 增加 `role="dialog"`、`aria-modal="true"`、标题关联和可编程聚焦；缩小、放大、上一张、下一张按钮补齐 accessible name |
| 聚焦测试 | `dialogFocus`、`imageViewer`、`orbImageViewer` 共 3 个测试文件、6 个用例通过；覆盖焦点边界计算、dialog 语义和查看器按钮名称 |
| Renderer bundle | 共享 `useDialogFocus` chunk 1.39 kB；主 chunk 146.34 kB、Chat 126.42 kB、Settings 15.25 kB、Orb 50.17 kB |
| `npm test` | 83 个测试文件、353 个用例通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过，0 warning |
| `node --check scripts/verify-ipc-security.mjs` | 通过 |
| `node --check scripts/fixtures/ipc-smoke-mcp-server.mjs` | 通过 |
| `node --check scripts/capture-ui-baseline.mjs` | 通过 |
| `npm run build:unpacked` | Windows unpacked 包通过，共享焦点 hook、动态 chunk、native 依赖、vector worker 与品牌元数据全部写入成功 |
| `npm run ipc:smoke` | packaged Pet/Chat/Settings/Memory/Orb preload 与运行正常，五类窗口 `runtimeErrors` 全为空；权限、持久化、聊天/任务/Memory/Agent/MCP/TTS/ASR 和重启路径全部通过 |
| `npm run media:smoke` | 图片 data URL、选择文件复制、图片/视频/Task resourceId URL、Range 206、越界/伪造路径拒绝和删除后 404 通过 |
| `npm run ui:baseline` | 24 个场景通过；四类目标界面均验证初始焦点、正反向 Tab 循环、Esc 关闭与焦点恢复，Orb 在弹窗内直接按 D 完成 `1/2 → 2/2`；0 failure、0 console error、无横向或纵向溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查 `artifacts/ui-baseline/chat-compact-420x560-scale100-clear-confirm.png`、`artifacts/ui-baseline/settings-default-860x680-scale100-confirm.png`、`artifacts/ui-baseline/chat-image-viewer-720x620-scale100-open.png` 与 `artifacts/ui-baseline/orb-image-viewer-560x720-scale100-open.png`，焦点轮廓位于预期危险动作或关闭/重置工具上，弹窗尺寸、遮罩、按钮排列和图片舞台没有新增错位。UI 报告中 Settings、Chat 图片和 Orb 图片的 `initialFocus`、`forwardWrap`、`backwardWrap`、`returnFocus` 全为 `true`；Chat 清空确认框同样通过运行时断言。当前实现按应用现有弹窗层级处理单一 modal，尚未建立嵌套弹窗栈，也未对背景区域统一设置 `inert`；共享 selector 覆盖现有 button/link/form/tabindex 控件，但未扩展到 `contenteditable` 等当前未使用类型。下一批继续补 Settings/Chat tabs 的 tablist/tab/tabpanel 语义和 `prefers-reduced-motion`。

## P2-3：无障碍与交互一致性（第五十九批）

- 验证日期：2026-07-14
- 优化范围：Settings 角色/记忆与工具中心子标签语义、键盘导航和系统减少动效支持

| 检查 | 结果 |
| --- | --- |
| 标签页语义 | 六个角色/记忆子页与两个工具中心子页增加命名 `tablist`、`tab`、`tabpanel`、`aria-selected`、`aria-controls`、`aria-labelledby` 和 roving `tabIndex` |
| 键盘行为 | Left/Right 循环切换，Home/End 定位首尾；选中态、焦点和当前 panel 标题关联同步更新 |
| Reduced motion | `prefers-reduced-motion: reduce` 下全局动画与过渡缩短为 `0.01ms`、重复次数降为 1、平滑滚动关闭；业务状态机和最终布局不变 |
| 聚焦测试 | `settingsTabs` 与 `settingsNavigation` 共 2 个文件、12 个用例通过；覆盖循环计算、Home/End、两组静态 ARIA 契约和既有搜索导航 |
| Renderer bundle | `settingsTabs` 共享 chunk 0.14 kB；主 chunk 146.34 kB、Settings 15.28 kB、Persona 22.76 kB、Tools 19.81 kB、主 CSS 42.89 kB |
| `npm test` | 84 个测试文件、356 个用例通过 |
| `npx tsc --noEmit` / `npm run lint` | 通过，0 warning |
| 三项脚本语法检查 | 通过 |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` / `npm run media:smoke` | 通过，五类窗口 runtimeErrors 为空，安全、持久化、媒体 Range 与拒绝路径无回归 |
| `npm run ui:baseline` | 25 个场景通过；新增 reduced-motion Settings 场景，computed animation/transition 均不超过 1ms且迭代次数为 1；两组标签页方向键/Home/End、焦点和选中态全部通过，0 failure、0 console error、无溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查 `artifacts/ui-baseline/settings-default-860x680-scale100.png` 与 `artifacts/ui-baseline/settings-reduced-motion-860x680-scale100.png`，标签按钮尺寸、换行、内容区宽度和 reduced-motion 最终画面无视觉回归。Chat 主窗口本轮审计未发现真正的 tab widget，因此没有为普通按钮或会话列表误加 tab 角色。当前 reduced-motion 采用应用级统一媒体查询，能覆盖 App、SpeechBubble 与 Orb 已加载样式；Live2D 模型自身的内部物理和眨眼由模型运行时控制，尚未跟随系统设置暂停。下一批继续统一 toast、错误提示和保存状态的 live-region 播报。

## P2-3：无障碍与交互一致性（第六十批）

- 验证日期：2026-07-14
- 优化范围：Settings 保存反馈、Chat/Orb/Memory 错误与 Orb 加载状态的 live-region 优先级和原子播报

| 检查 | 结果 |
| --- | --- |
| 共享语义 | 新增 `getLiveRegionProps`，普通异步更新统一为 atomic `status/polite`，需要立即处理的错误统一为 atomic `alert/assertive` |
| 接入范围 | Settings 保存中/已保存保持 polite，保存失败动态升级 assertive；Chat 顶部错误条、Orb Panel 错误、Memory Console API/运行错误使用 assertive；Orb Panel 与历史弹层加载使用 polite |
| 防重复 | Chat/Orb 消息正文中的 `[错误]` 不接 live-region，避免与独立错误条重复朗读；空状态也不作为动态通知 |
| 聚焦测试 | `liveRegion`、`orbPanelView`、`orbHistoryPopover` 共 3 个文件、10 个用例通过 |
| Renderer bundle | `liveRegion` 共享 chunk 0.16 kB；主 chunk 146.38 kB、Chat 126.49 kB、Settings 15.34 kB、Memory 31.02 kB、Orb 50.27 kB |
| `npm test` | 85 个测试文件、359 个用例通过 |
| TypeScript / lint / 三项脚本检查 | 全部通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过 |
| `npm run ipc:smoke` / `npm run media:smoke` | 通过，五类窗口 runtimeErrors 为空，安全、持久化与本地媒体路径无回归 |
| `npm run ui:baseline` | 25 个场景通过；Settings 保存状态实测为 `status/polite/atomic`，Chat 错误条实测为 `alert/assertive/atomic`；0 failure、0 console error、无溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

本批只增加辅助技术语义，没有改变错误文案、视觉样式、自动消失时间、关闭按钮、保存并发序列或业务异常处理。静态测试覆盖 Orb 加载和错误两种优先级，浏览器基线覆盖真实 Chat 错误出现后的 alert 属性以及 Settings 保存中到已保存后的 status 属性。当前尚未统一 Memory Console 局部“已保存/保存失败”短提示和 Semantic Group 编辑器状态，也没有加入全局可视 toast 容器；下一批继续审计这两类局部反馈和表单错误关联。

## P2-3：无障碍与交互一致性（第六十一批）

- 验证日期：2026-07-14
- 优化范围：Memory Console 记忆选择键盘入口、编辑器名称、保存/回滚提示关联和版本加载错误播报

| 检查 | 结果 |
| --- | --- |
| 操作入口 | 移除包含 checkbox 的整张记忆卡点击行为，增加原生“查看并编辑”按钮；活动记录通过 `aria-pressed` 暴露，避免在模拟 button 内嵌交互控件 |
| 编辑器关联 | textarea 增加“记忆内容”名称；保存/回滚提示使用固定 id，并通过 `aria-describedby` 与编辑器关联；失败期间 `aria-invalid=true` |
| 状态优先级 | 保存/回滚成功为 atomic `status/polite`，失败为 atomic `alert/assertive`；版本历史加载与错误分别使用 polite 与 assertive |
| `npm test` | 85 个测试文件、359 个用例通过 |
| TypeScript / lint / 三项脚本检查 | 全部通过，0 warning |
| `npm run build:unpacked` | Windows unpacked 包通过；Memory Console chunk 31.36 kB |
| `npm run ipc:smoke` / `npm run media:smoke` | 通过，五类窗口 runtimeErrors 为空，数据、权限和媒体路径无回归 |
| `npm run ui:baseline` | 25 个场景通过；默认 Memory 场景以焦点 + Enter 打开编辑器，保存调用 1 次，活动按钮、描述关联、invalid 状态和成功 live-region 全部符合预期；0 failure、0 console error、无溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查 `artifacts/ui-baseline/memory-default-900x720-scale100.png`，新增按钮位于原元数据行内，未改变卡片宽度、checkbox 操作或详情区布局。自动化报告中的 `updateCount=1`、`triggerPressed=true`、`describedBy=ndp-memory-edit-notice`、`invalid=false`，成功提示为 `status/polite/atomic`。审计同时确认 `src/components/SemanticGroupPanel.tsx` 当前没有入口引用，且引用的类型和 preload API 已不存在；它不是正在运行的产品界面，因此本批没有对其做表面修补，后续应单独决定删除遗留文件还是按现有 Memory 架构重建功能。

## P2-3：无障碍与交互一致性（第六十二批）

- 验证日期：2026-07-14
- 优化范围：工具中心 MCP JSON 导入的输入名称、错误关联、无效状态、错误播报和重新编辑清理

| 检查 | 结果 |
| --- | --- |
| 输入错误关联 | MCP JSON textarea 增加“MCP JSON 配置” accessible name；失败时 `aria-invalid=true`，并通过 `aria-describedby=ndp-mcp-import-error` 关联错误 |
| 状态播报 | 导入错误为 atomic `alert/assertive`，错误文案以“导入失败”开头；继续编辑后旧错误节点、描述关联和 invalid 状态立即清除 |
| 解析边界 | 新增独立 `mcpImport.ts`，支持 `{mcpServers:{...}}`、`{servers:[...]}` 和直接数组；单元测试覆盖对象、数组和空集合拒绝 |
| `npm test` | 85 个测试文件、360 个用例通过 |
| `npx tsc --noEmit` / `npm run lint` | 通过，0 warning |
| 三项脚本语法检查 | 通过 |
| `npm run build:unpacked` | Windows unpacked 包通过；Tools chunk 19.97 kB，动态 chunk、native 依赖、vector worker 与品牌元数据写入成功 |
| `npm run ipc:smoke` / `npm run media:smoke` | 通过，五类窗口 `runtimeErrors` 为空，权限、持久化、MCP、媒体 Range 与拒绝路径无回归 |
| `npm run ui:baseline` | 25 个场景通过；默认 Settings 场景实际输入坏 JSON、触发覆盖导入并验证错误与编辑清理，0 failure、0 console error、无溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查 `artifacts/ui-baseline/settings-default-860x680-scale100-mcp-import-error.png`，错误文本位于导入框和操作按钮之间，未改变工具中心宽度、按钮排列或 MCP Server 列表布局。UI 报告中的 `invalid=true`、`describedBy=ndp-mcp-import-error`、`role=alert`、`live=assertive`、`atomic=true`、`clearedOnEdit=true`，该场景无 failure 或 console error。本批只处理用户可直接修正的 MCP JSON 校验错误；AI 模型列表、ASR 麦克风和 TTS 资源扫描属于异步资源错误，尚未与对应输入控件建立统一关联，留待下一批继续审计。

## P2-3：无障碍与交互一致性（第六十三批）

- 验证日期：2026-07-14
- 优化范围：ASR 麦克风枚举与 TTS 本地资源扫描错误的控件关联、加载/无效状态和错误播报

| 检查 | 结果 |
| --- | --- |
| ASR 控件关系 | “选择麦克风” label 与下拉框通过 id 关联；枚举期间暴露 `aria-busy`，错误同时描述下拉框和刷新按钮 |
| TTS 控件关系 | 安装目录 label 与输入框通过 id 关联；扫描失败时目录输入 `aria-invalid=true`，目录及 GPT/SoVITS/参考音频控件共享错误描述 |
| 状态播报 | ASR 与 TTS 错误均为 atomic `alert/assertive`；修改 TTS 安装目录后旧错误、描述关联和 invalid 状态立即清除 |
| 聚焦测试 | `settingsTabs` 共 6 个用例通过，新增 ASR/TTS label 与初始状态静态契约 |
| `npm test` | 85 个测试文件、362 个用例通过 |
| `npx tsc --noEmit` / `npm run lint` | 通过，0 warning |
| 三项脚本语法检查 | 通过 |
| `npm run build:unpacked` | Windows unpacked 包通过；ASR chunk 7.30 kB、TTS chunk 7.02 kB |
| `npm run ipc:smoke` / `npm run media:smoke` | 通过，五类窗口 `runtimeErrors` 为空，权限、持久化、语音、媒体 Range 与拒绝路径无回归 |
| `npm run ui:baseline` | 25 个场景通过；默认 Settings 场景模拟麦克风权限拒绝和 TTS 扫描失败，0 failure、0 console error、无溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查 `artifacts/ui-baseline/settings-default-860x680-scale100-asr-device-error.png` 与 `artifacts/ui-baseline/settings-default-860x680-scale100-tts-scan-error.png`，ASR 错误位于设备帮助文本下方，TTS 错误位于资源配置末尾，均未挤压控件宽度或造成文字重叠。UI 报告中 ASR 的 select/button `describedBy` 均为 `ndp-asr-mic-error`、busy 最终为 false；TTS 的 `invalid=true`、目录与模型描述关联均为 `ndp-tts-options-error`、`clearedOnEdit=true`；两类错误均为 `alert/assertive/atomic`。AI 模型列表错误同时可能来自凭据、Base URL、配置档和模型服务，本批没有把它粗略绑定到模型名称字段，下一批单独设计联合错误反馈。

## P2-3：无障碍与交互一致性（第六十四批）

- 验证日期：2026-07-14
- 优化范围：AI 主模型与上下文压缩模型列表的联合配置错误关联、加载状态、错误播报和编辑清理

| 检查 | 结果 |
| --- | --- |
| 主模型错误 | API Key、Base URL、模型名称和拉取按钮共享 `ndp-ai-model-list-error` 描述；按钮暴露 busy，错误为 `alert/assertive/atomic` |
| 压缩模型错误 | API 来源、配置档、模型覆盖值和拉取按钮共享 `ndp-ai-compression-model-list-error` 描述；按钮暴露 busy，错误为 `alert/assertive/atomic` |
| 联合错误语义 | 两类错误均不设置字段 `aria-invalid`，避免把 Key/Base URL/配置档/服务端的联合失败错误归因给单一输入 |
| 编辑恢复 | 修改主 Base URL、模型、Key 或压缩来源/配置/模型后清除对应旧错误；原保存和重新拉取流程不变 |
| 聚焦测试 | `settingsTabs` 共 7 个用例通过，新增 AI label/id、控件命名、初始 busy 和无 invalid 静态契约 |
| `npm test` | 85 个测试文件、363 个用例通过 |
| `npx tsc --noEmit` / `npm run lint` | 通过，0 warning |
| 三项脚本语法检查 | 通过 |
| `npm run build:unpacked` | Windows unpacked 包通过；AI chunk 24.88 kB、Secret input chunk 0.88 kB |
| `npm run ipc:smoke` / `npm run media:smoke` | 通过，五类窗口 `runtimeErrors` 为空，凭据脱敏、权限、持久化与媒体路径无回归 |
| `npm run ui:baseline` | 25 个场景通过；默认 Settings 场景模拟主模型和压缩模型列表失败并验证编辑恢复，0 failure、0 console error、无溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查 `artifacts/ui-baseline/settings-default-860x680-scale100-ai-model-list-error.png` 与 `artifacts/ui-baseline/settings-default-860x680-scale100-ai-compression-model-error.png`，错误分别位于主模型拉取按钮下方和高级压缩模型区内，未改变输入宽度、按钮排列或高级区布局。UI 报告中主错误的 Key/Base URL/model/button 描述关联均为 `ndp-ai-model-list-error`，压缩错误的 source/model/button 关联均为 `ndp-ai-compression-model-list-error`；两类 busy 最终为 false、`clearedOnEdit=true`、live-region 为 `alert/assertive/atomic`。配置档选择控件仅在实际选择“使用已保存 API 配置”时出现，代码已接入同一描述关联，当前基线使用默认主 API 来源覆盖其余联合路径。

## P2-3：无障碍与交互一致性（第六十五批）

- 验证日期：2026-07-14
- 优化范围：Settings 密钥保存/清除失败的字段级错误、重复播报抑制和编辑恢复

| 检查 | 结果 |
| --- | --- |
| 字段错误 | `SecretSettingInput` 失败时输入框 `aria-invalid=true`，通过 target 稳定 id 关联错误；清除按钮同步关联 |
| 状态播报 | 字段错误为 atomic `alert/assertive`；`setSecret` 失败不再同时触发顶部全局 alert，保存状态回到 idle |
| 编辑恢复 | 用户继续输入后局部错误、描述关联和 invalid 状态立即清除；失焦仍按原逻辑重新保存 |
| 诊断日志 | 已处理的密钥失败保留 `console.warn`，不再作为未处理 runtime error 进入 UI 门禁 |
| `npm test` | 85 个测试文件、363 个用例通过 |
| `npx tsc --noEmit` / `npm run lint` | 通过，0 warning |
| 三项脚本语法检查 | 通过 |
| `npm run build:unpacked` | Windows unpacked 包通过；Secret input chunk 1.27 kB、Settings chunk 15.46 kB、主 CSS 42.93 kB |
| `npm run ipc:smoke` / `npm run media:smoke` | 通过，五类窗口 `runtimeErrors` 为空，密钥脱敏、权限、持久化与媒体路径无回归 |
| `npm run ui:baseline` | 25 个场景通过；默认 Settings 场景真实触发 API Key 失焦保存失败并验证恢复，0 failure、0 console error、无溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查 `artifacts/ui-baseline/settings-default-860x680-scale100-secret-save-error.png`，错误紧邻 API Key 输入和帮助文本，红色提示没有改变输入/清除按钮宽度或后续 Base URL 布局。UI 报告中的 `invalid=true`、`describedBy=ndp-secret-ai-main-error`、`role=alert`、`live=assertive`、`atomic=true`、`globalSaveState=idle`、`clearedOnEdit=true`。基线随后切换页面重挂组件再执行 AI 模型错误场景，避免未失焦草稿造成测试状态串扰；所有场景仍保持无 console error。

## P2-3：无障碍与交互一致性（第六十六批）

- 验证日期：2026-07-14
- 优化范围：语音合成与语音识别设置中 12 个可见表单控件的程序化名称

| 检查 | 结果 |
| --- | --- |
| ASR 控件命名 | WebSocket 地址、采集方式、热词替换规则和语气词列表通过 `label/htmlFor` 与稳定 id 关联 |
| TTS 控件命名 | GPT 模型、SoVITS 模型、语速、参考音频、参考音频文本和播放文本通过 `label/htmlFor` 关联；分句停顿滑块与数值框分别命名，避免同名歧义 |
| 聚焦测试 | `settingsTabs` 共 7 个用例通过，覆盖新增 label/id 和双控件 `aria-label` 静态契约 |
| `npm test` | 85 个测试文件、363 个用例通过 |
| `npx tsc --noEmit` / `npm run lint` | 通过，0 warning |
| 三项脚本语法检查 | 通过 |
| `npm run build:unpacked` | Windows unpacked 包通过；TTS chunk 7.39 kB、ASR chunk 7.52 kB |
| `npm run ipc:smoke` / `npm run media:smoke` | 通过，五类窗口 `runtimeErrors` 为空，权限、持久化、语音代理与本地媒体路径无回归 |
| `npm run ui:baseline` | 25 个场景通过；真实无障碍树按 role + name 定位 ASR 4 项、TTS 8 项，0 failure、0 console error、无溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查 `artifacts/ui-baseline/settings-default-860x680-scale100-asr-device-error.png` 与 `artifacts/ui-baseline/settings-default-860x680-scale100-tts-scan-error.png`，新增关联不改变控件尺寸、表单排列或错误提示位置。UI 报告中的 `settingsVoiceControlNames={asr:4,tts:8}`，并继续保留上一批资源错误的描述关联、invalid 状态和编辑恢复门禁。本轮真实 DOM 审计最初发现 86 个缺少程序化名称的可见控件，本批收口其中 12 个；其余 74 个仍需按页面分批处理，动态子标签和条件控件还必须展开后复审。

## P2-3：无障碍与交互一致性（第六十七批）

- 验证日期：2026-07-14
- 优化范围：Live2D、气泡与任务面板设置中 9 个可见表单控件的程序化名称

| 检查 | 结果 |
| --- | --- |
| Live2D 控件命名 | 模型选择、模型大小和模型透明度通过 `label/htmlFor` 与稳定 id 关联 |
| 气泡控件命名 | 水平位置、垂直位置、自动隐藏延迟和点击台词通过 `label/htmlFor` 与稳定 id 关联 |
| 任务面板控件命名 | 水平位置和垂直位置通过 `label/htmlFor` 与稳定 id 关联 |
| 聚焦测试 | `settingsTabs` 共 10 个用例通过，新增三个页面的 label/id 静态契约 |
| `npm test` | 85 个测试文件、366 个用例通过 |
| `npx tsc --noEmit` / `npm run lint` | 通过，0 warning |
| 三项脚本语法检查 | 通过 |
| `npm run build:unpacked` | Windows unpacked 包通过；Live2D 3.92 kB、Bubble 5.39 kB、Task Panel 1.36 kB |
| `npm run ipc:smoke` / `npm run media:smoke` | 通过，五类窗口 `runtimeErrors` 为空，窗口、设置持久化与本地媒体路径无回归 |
| `npm run ui:baseline` | 25 个场景通过；真实无障碍树按 role + name 定位 Live2D 3 项、气泡 4 项、任务面板 2 项，0 failure、0 console error、无溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查 `artifacts/ui-baseline/settings-default-860x680-scale100-live2d-controls.png`、`settings-default-860x680-scale100-bubble-controls.png` 与 `settings-default-860x680-scale100-task-panel-controls.png`，新增标签关联未改变选择框、滑块、样式按钮网格或帮助文本布局。UI 报告中的计数分别为 Live2D 3、气泡 4、任务面板 2，并继续验证上一批语音控件 4/8 项。本轮收口 9 个缺名控件，默认视图剩余 65 个；下一批进入 API 连接、模型与生成、视觉和 Agent，仍需区分默认可见与条件展开控件。

## P2-3：无障碍与交互一致性（第六十八批）

- 验证日期：2026-07-14
- 优化范围：API 连接、模型与生成、视觉和 Agent 设置中 19 个默认或互斥可见控件的程序化名称

| 检查 | 结果 |
| --- | --- |
| API 连接 | 已保存配置、接口格式通过 `label/htmlFor` 关联；配置名称输入使用“新配置名称”独立名称，避免误归到配置下拉框 |
| 模型与生成 | 思考提供商、三种互斥提供商的思考强度、温度、最大回复长度和最大上下文长度均有稳定名称 |
| 视觉 | 视觉路由、主模型视觉能力、外挂配置、外挂模型覆盖和单次图片上限通过 `label/htmlFor` 关联 |
| Agent | 工具执行模式、最大回合数、托管 Skill 目录和系统提示词通过 `label/htmlFor` 关联 |
| 聚焦测试 | `settingsTabs` 共 10 个用例通过，覆盖 AI 四页静态 label/id 契约 |
| `npm test` | 85 个测试文件、366 个用例通过 |
| `npx tsc --noEmit` / `npm run lint` | 通过，0 warning |
| 三项脚本语法检查 | 通过 |
| `npm run build:unpacked` | Windows unpacked 包通过；AI chunk 25.89 kB |
| `npm run ipc:smoke` / `npm run media:smoke` | 通过，五类窗口 `runtimeErrors` 为空，AI 代理、设置持久化、权限与媒体路径无回归 |
| `npm run ui:baseline` | 25 个场景通过；真实无障碍树定位 API 连接 3、当前模型与生成 5、视觉 5、Agent 4 项，0 failure、0 console error、无溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查 `artifacts/ui-baseline/settings-default-860x680-scale100-ai-connection-controls.png`、`settings-default-860x680-scale100-ai-generation-controls.png`、`settings-default-860x680-scale100-ai-vision-controls.png` 与 `settings-default-860x680-scale100-ai-agent-controls.png`，新增关联未改变输入宽度、滑块、禁用态或页面滚动布局。源码共处理 19 个控件；默认运行态只会渲染 OpenAI/Claude/Gemini 三种思考强度中的一个，因此 UI 报告实际定位 17 个当前可见控件，另外两条互斥分支由相同稳定 id 的静态契约覆盖。默认视图剩余 46 个缺名控件；高级上下文压缩和自定义工具 API 等条件区域仍保留到动态状态专项审计。

## P2-3：无障碍与交互一致性（第六十九批）

- 验证日期：2026-07-14
- 优化范围：NovelAI 默认视图中 18 个提示词与生成参数控件的程序化名称

| 检查 | 结果 |
| --- | --- |
| 单控件关联 | Endpoint、三类提示词、占用上限、模型、采样器、噪点表、三类生成滑块和输出目录通过稳定 id 与 `label/htmlFor` 关联 |
| 成对控件命名 | 预设下拉框关联“提示词预设”，名称输入独立为“预设名称”；尺寸分别为“图片宽度/高度”，张数与种子分别为“生成张数/随机种子” |
| 聚焦测试 | `settingsTabs` 共 11 个用例通过，新增 NovelAI 18 项静态契约 |
| `npm test` | 85 个测试文件、367 个用例通过 |
| `npx tsc --noEmit` / `npm run lint` | 通过，0 warning |
| 三项脚本语法检查 | 通过 |
| `npm run build:unpacked` | Windows unpacked 包通过；NovelAI chunk 12.13 kB |
| `npm run ipc:smoke` / `npm run media:smoke` | 通过，五类窗口 `runtimeErrors` 为空，生图设置持久化、密钥隔离、权限与媒体路径无回归 |
| `npm run ui:baseline` | 25 个场景通过；真实无障碍树按 role + name 定位 18 项，0 failure、0 console error、无溢出 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 转换提示 |

人工检查 `artifacts/ui-baseline/settings-default-860x680-scale100-novelai-prompt-controls.png` 与 `settings-default-860x680-scale100-novelai-generation-controls.png`，预设行、提示词输入、尺寸、滑块、张数/种子和输出目录没有出现标签重叠或宽度变化。默认视图最初 86 个缺名控件已累计收口 58 个，剩余 28 个分布在聊天界面 26 项和工具中心 2 项；云端队列启用后的 5 个条件控件仍留到动态状态专项审计。

## P2-3：无障碍与交互一致性（第七十批）

- 验证日期：2026-07-14
- 优化范围：聊天界面默认视图中 26 个颜色与外观控件的程序化名称

| 检查 | 结果 |
| --- | --- |
| RGBA 控件命名 | 聊天背景、用户气泡、助手气泡各包含红/绿/蓝/透明度四个通道，每个通道的 range 与 number 分别命名为“滑块”和“数值”，共 24 项 |
| 其余控件关联 | 背景图片透明度 range 使用独立名称；气泡圆角通过稳定 id 与 `label/htmlFor` 关联 |
| 聚焦测试 | `settingsTabs` 共 12 个用例通过，新增聊天界面 26 项静态契约 |
| `npm test` | 85 个测试文件、368 个用例通过 |
| `npx tsc --noEmit` / `npm run lint` | 通过，0 warning |
| 三项脚本语法检查 | 通过 |
| `npm run build:unpacked` | Windows unpacked 包通过；Chat UI chunk 6.18 kB |
| `npm run ipc:smoke` / `npm run media:smoke` | 通过，五类窗口 `runtimeErrors` 为空，设置持久化、密钥隔离、权限与媒体路径无回归 |
| `npm run ui:baseline` | 25 个场景通过；真实无障碍树按 role + name 定位 26 项，0 failure、0 console error、无溢出 |

人工检查 `artifacts/ui-baseline/settings-default-860x680-scale100-chat-ui-background-controls.png` 与 `settings-default-860x680-scale100-chat-ui-bubble-controls.png`，三组 RGBA 行、成对滑块/数字输入、背景透明度与气泡圆角没有出现标签重叠、宽度变化或滚动异常。默认视图最初 86 个缺名控件已累计收口 84 个，仅剩工具中心 2 项；Persona 子标签、Tools/MCP 动态编辑内容、NovelAI 云端队列、AI 高级上下文压缩和 Agent 自定义工具 API 等条件区域仍留到动态状态专项审计。

## P2-3：无障碍与交互一致性（第七十一批）

- 验证日期：2026-07-14
- 优化范围：AI 高级压缩与独立 Agent API、NovelAI 云端队列、Tools/MCP 动态配置的程序化名称

| 检查 | 结果 |
| --- | --- |
| AI 条件控件 | 压缩模型列表、触发阈值、目标占比，以及工具 Base URL、模型、温度、最大输出和超时共 8 类新增关联；浏览器连同既有开关、配置和密钥输入实际定位 7+7 项 |
| NovelAI 队列 | 服务地址、用户 ID、个性语通过稳定 id 关联；轮询间隔和最长等待时间分别命名，浏览器连同队列开关定位 6 项 |
| Tools 默认与动态内容 | 工具总开关、搜索、内置分组/工具、MCP 总开关、Server 开关、Server ID/显示名称/command/args/cwd/env、Server 分组和 MCP 工具均有可区分名称 |
| 聚焦测试 | `settingsTabs` 共 12 个用例通过，扩展 Tools 默认控件、NovelAI 队列、AI 高级压缩和独立 Agent API 静态契约 |
| `npm test` | 85 个测试文件、368 个用例通过 |
| `npx tsc --noEmit` / `npm run lint` | 通过，0 warning |
| 三项脚本语法检查 | 通过 |
| `npm run build:unpacked` | Windows unpacked 包通过；AI、Tools、NovelAI chunk 分别为 26.34、20.34、12.40 kB |
| `npm run ipc:smoke` / `npm run media:smoke` | 通过，五类窗口 `runtimeErrors` 为空，MCP/Agent/设置持久化、密钥隔离、权限与媒体路径无回归 |
| `npm run ui:baseline` | 25 个场景通过；高级压缩 7、独立 Agent API 7、NovelAI 队列 6、内置工具 4、MCP 10 项按 role + name 定位，0 failure、0 console error、无溢出 |

人工检查 `artifacts/ui-baseline/settings-default-860x680-scale100-ai-compression-controls.png`、`settings-default-860x680-scale100-ai-custom-agent-controls.png`、`settings-default-860x680-scale100-novelai-queue-controls.png` 与 `settings-default-860x680-scale100-tools-conditional-controls.png`，展开后的选择框、长文本输入、成对数值输入、滑块和 MCP Server 编辑器没有出现重叠、宽度变化或异常横向滚动。默认视图最初 86 个缺名控件已全部收口；Persona 六个子标签及其嵌套条件状态仍需下一批逐页展开，之后再用全 Settings 自动门禁证明没有遗漏。
