# Live2D 参数调试小 DEMO（独立）

日期：2026-01-16  
作者：Codex

这是一个**独立**的 Live2D 参数调试小 DEMO，用来：
- 列出模型的全部参数（Id/名称/分组、min/max/默认值/当前值）
- 用滑条实时修改参数（并可“锁定覆盖”，每帧持续写入）
- 粘贴 JSON 脚本批量设置参数（方便后续让 LLM 直接输出参数 patch）

> 说明：该 DEMO 与主程序不接通，不会读取/写入主程序的设置与数据。

## 1) 准备模型文件

把你的 Live2D 模型目录放到这个 DEMO 的静态目录下：

`NeoDeskPet-electron/demo/live2d-param-demo/public/live2d/<你的模型目录>/`

并确保该目录中存在 `*.model3.json`（Cubism 3+），例如：

`public/live2d/艾玛/艾玛.model3.json`

通常 `model3.json` 里会引用 `DisplayInfo`（例如 `*.cdi3.json`），用于显示参数名称/分组；如果没有 `DisplayInfo`，DEMO 仍可运行，但只能手动输入参数 ID 列表。

## 2) 运行

```powershell
cd NeoDeskPet-electron/demo/live2d-param-demo
npm install
npm run dev
```

打开浏览器地址栏里显示的本地 URL。

> 如果你遇到 `Could not find Cubism 2 runtime`：请确认 `public/lib/live2d.min.js` 与 `public/lib/live2dcubismcore.min.js` 存在，并且 `index.html` 已加载它们。

## 3) Script（给 LLM 用的输入格式）

支持以下两种格式：

### 3.1 直接对象（推荐）

```json
{
  "ParamAngleX": 10,
  "ParamAngleY": -5,
  "ParamBodyAngleZ": 6
}
```

### 3.2 数组

```json
[
  { "id": "ParamAngleX", "value": 10 },
  { "id": "ParamAngleY", "value": -5 }
]
```

