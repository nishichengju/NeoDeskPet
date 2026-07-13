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
