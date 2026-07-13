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
