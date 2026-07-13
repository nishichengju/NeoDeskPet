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

本批未修改 renderer、preload API、IPC 权限矩阵或媒体路径策略。P2-1 后续继续拆分 Task、Memory、TTS 和 Window IPC。
