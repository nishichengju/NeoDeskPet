# NeoDeskPet 发布体积报告

- 生成时间：2026-07-13T02:42:18.764Z
- 版本：0.21.0
- 构建策略：精简版
- 基线：旧 unpacked 目录约 870.91 MiB，旧 app.asar 343.88 MiB，随包浏览器 273.07 MiB。
- 当前 unpacked：300.75 MiB
- 当前 app.asar：22.97 MiB
- 当前 app.asar.unpacked：23.71 MiB
- 当前安装器：95.31 MiB
- 精简安装器相对旧基线缩小：64%
- app.asar 相对旧基线缩小：93%

- 完整版 unpacked：573.82 MiB
- 完整版 app.asar：22.97 MiB
- 完整版内置浏览器：273.07 MiB
- 完整版安装器：176.98 MiB

精简版不内置浏览器；首次使用无头浏览器工具时下载到用户数据目录。

## 打包策略

1. 默认精简包只包含生产依赖、七个仓库内示例 Live2D 模型和运行时代码。
2. 本地被忽略的第三方模型不会进入正式包，避免把开发机器私有资源带入发布产物。
3. Playwright Core 保留在应用中；精简包首次使用时自动安装匹配的 Chromium Headless Shell 到用户数据目录。
4. 设置 `NDP_BUNDLE_BROWSER=1`（`npm run build:full`）可生成离线完整版。
5. `better-sqlite3` 与 `playwright-core` 显式放入 `app.asar.unpacked`，保证 native addon、驱动和安装 CLI 可直接访问。

## 最大生产依赖

| 依赖 | 体积 |
| --- | ---: |
| `playwright-core` | 12.11 MiB |
| `better-sqlite3` | 11.58 MiB |
| `bindings` | 0.01 MiB |
| `file-uri-to-path` | 0.01 MiB |

## 随包 Live2D 示例

| 模型 | 体积 |
| --- | ---: |
| Hiyori | 4.71 MiB |
| Mao | 4.15 MiB |
| Haru | 3.5 MiB |
| Natori | 3.34 MiB |
| Rice | 3.02 MiB |
| Wanko | 0.74 MiB |
| Mark | 0.67 MiB |
