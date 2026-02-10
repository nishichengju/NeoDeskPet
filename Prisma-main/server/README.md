# 🔮 DeepThink API Server

基于 Prisma 项目的多智能体深度推理 API 服务，提供 OpenAI 兼容接口。

## ✨ 特性

- **OpenAI 兼容 API** - 可直接替换 OpenAI 端点使用
- **多智能体推理** - Manager → Experts → Synthesis 工作流
- **流式输出 (SSE)** - 实时返回推理结果
- **可配置思考深度** - 分别控制规划/执行/综合阶段的思考强度
- **多 Provider 支持** - Google、OpenAI、DeepSeek、Anthropic、xAI、Mistral 等
- **运行时配置更新** - 无需重启即可调整参数

---

## 🚀 快速开始

### 1. 安装依赖

```bash
cd server
npm install
```

### 2. 配置 API Key

**方式一：环境变量**
```bash
cp .env.example .env
# 编辑 .env 文件，填入你的 API Key
```

**方式二：配置文件**
编辑 `config.yaml`：
```yaml
deepThink:
  apiKey: "your_api_key_here"
```

### 3. 启动服务

```bash
# 开发模式（热重载）
npm run dev

# 生产模式
npm run build
npm start
```

服务将在 `http://localhost:3000` 启动。

---

## 📖 API 使用指南

### 1. OpenAI 兼容接口

#### 非流式请求

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepthink",
    "messages": [
      {"role": "user", "content": "解释量子计算的基本原理"}
    ]
  }'
```

#### 流式请求

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepthink",
    "stream": true,
    "messages": [
      {"role": "user", "content": "分析人工智能对教育的影响"}
    ]
  }'
```

#### 自定义思考深度

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepthink",
    "messages": [
      {"role": "user", "content": "你的问题"}
    ],
    "deepthink_options": {
      "planning_level": "high",
      "expert_level": "medium",
      "synthesis_level": "high",
      "enable_recursive_loop": true
    }
  }'
```

### 2. 扩展接口（获取完整推理过程）

```bash
curl -X POST http://localhost:3000/v1/deepthink \
  -H "Content-Type: application/json" \
  -d '{
    "query": "分析区块链技术的优缺点",
    "options": {
      "planning_level": "high",
      "expert_level": "high",
      "synthesis_level": "high"
    }
  }'
```

返回包含所有专家的详细输出：
```json
{
  "success": true,
  "content": "最终综合回答...",
  "experts": [
    {
      "role": "Primary Responder",
      "round": 1,
      "content": "专家1的分析..."
    },
    {
      "role": "Technical Analyst",
      "round": 1,
      "content": "专家2的分析..."
    }
  ]
}
```

### 3. 配置管理

#### 查看当前配置

```bash
curl http://localhost:3000/v1/config
```

#### 运行时更新配置

```bash
curl -X POST http://localhost:3000/v1/config \
  -H "Content-Type: application/json" \
  -d '{
    "planningLevel": "medium",
    "expertLevel": "low",
    "enableRecursiveLoop": true
  }'
```

---

## ⚙️ 配置说明

### 思考深度级别

| 级别 | Token 预算 | 适用场景 |
|------|-----------|----------|
| `minimal` | 0 | 简单问题，快速响应 |
| `low` | 2048 | 一般问题 |
| `medium` | 8192 | 复杂问题 |
| `high` | 16384+ | 深度推理，复杂分析 |

### 支持的 Provider

| Provider | 模型前缀 | 说明 |
|----------|---------|------|
| `google` | `gemini-*` | Google Gemini 系列 |
| `openai` | `gpt-*`, `o1-*` | OpenAI 模型 |
| `deepseek` | `deepseek-*` | DeepSeek 模型 |
| `anthropic` | `claude-*` | Claude 系列 |
| `xai` | `grok-*` | xAI Grok |
| `mistral` | `mistral-*`, `mixtral-*` | Mistral 模型 |
| `custom` | 任意 | 自定义 OpenAI 兼容 API |

### 使用自定义/反代 API

```yaml
# config.yaml
deepThink:
  model: "gpt-4"
  provider: "custom"
  apiKey: "your_key"
  baseUrl: "https://your-proxy.com/v1"
```

---

## 🔗 在其他应用中使用

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="not-needed"  # 服务端已配置
)

response = client.chat.completions.create(
    model="deepthink",
    messages=[
        {"role": "user", "content": "解释相对论"}
    ],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### JavaScript/TypeScript

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'not-needed'
});

const stream = await client.chat.completions.create({
  model: 'deepthink',
  messages: [{ role: 'user', content: '分析气候变化' }],
  stream: true
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

### cURL 流式读取

```bash
curl -N -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepthink","stream":true,"messages":[{"role":"user","content":"你好"}]}'
```

---

## 📁 项目结构

```
server/
├── src/
│   ├── index.ts              # HTTP Server 入口
│   ├── api.ts                # AI Provider 初始化
│   ├── config.ts             # 配置加载
│   ├── types.ts              # 类型定义
│   ├── utils.ts              # 工具函数
│   └── services/
│       ├── logger.ts         # 日志服务
│       ├── orchestrator.ts   # 核心编排逻辑
│       ├── deepThink/
│       │   ├── manager.ts    # Manager 分析/审查
│       │   ├── expert.ts     # Expert 执行
│       │   ├── synthesis.ts  # 综合输出
│       │   ├── prompts.ts    # Prompt 模板
│       │   └── openaiClient.ts
│       └── utils/
│           └── retry.ts      # 重试逻辑
├── config.yaml               # 配置文件
├── .env.example              # 环境变量示例
├── package.json
└── tsconfig.json
```

---

## 🔧 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | 3000 |
| `HOST` | 监听地址 | 0.0.0.0 |
| `API_KEY` | API 密钥 | - |
| `MODEL` | 默认模型 | gemini-3-flash-preview |
| `PROVIDER` | API Provider | google |
| `BASE_URL` | 自定义 API 地址 | - |
| `PLANNING_LEVEL` | 规划阶段思考深度 | high |
| `EXPERT_LEVEL` | 专家阶段思考深度 | high |
| `SYNTHESIS_LEVEL` | 综合阶段思考深度 | high |
| `ENABLE_RECURSIVE_LOOP` | 启用迭代审查 | false |

---

## 📄 License

MIT
