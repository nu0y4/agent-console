# Agent Console

AI Agent 会话管理器 — 浏览 Claude Code 的 `.jsonl` 会话记录，支持四维搜索、时间轴定位、文件夹自动扫描。

## 功能

- **会话历史列表** — 自动扫描 Claude 会话文件夹，列出全部会话（标题、时间、消息统计），可增删切换
- **对话区域** — 时间线渲染：用户 / AI / 思考块 / 工具调用卡片（输入 JSON + 关联结果），system 事件胶囊显示
- **四维搜索** — 全文 + 工具调用 / AI 对话 / 用户对话 / 思考 过滤，命中高亮，Enter 直达定位
- **底部时间轴** — 灰色细线 + 时间节点圆点，拖拽定位聊天进度，松手磁吸到最近节点，中间标签实时显示当前时间
- **会话身份** — chat 头部显示会话文件名与 `claude --resume <sessionId>` 命令，可选中复制
- **配置弹窗** — 设置 Claude 会话文件夹（默认 `C:\Users\sorye\.claude\projects`），保存后自动重扫
- **拖拽导入** — 把 `.jsonl` 拖进页面即加载，等同"导入会话"

## 运行

```bash
npm start        # 或 node server.js
```

打开 http://127.0.0.1:8123

- 首次启动自动扫描默认文件夹，加载全部会话（实时统计）
- 后端不可达时回退为内置示例数据，可手动导入/拖拽

## 架构

```
index.html          前端入口
css/styles.css      design tokens + 组件样式
js/parser.js        Claude Code JSONL 解析器（tool_result 关联、thinking 兼容）
js/highlighter.js   DOM-safe 高亮与片段提取
js/sample-data.js   内置示例会话（生成器构造）
js/app.js           应用逻辑（列表/渲染/搜索/时间轴/配置）
server.js           Node 零依赖后端：静态服务 + 配置持久化 + 会话扫描
config.json         运行时生成：{ sessionDir, sessionId }
package.json        npm start 启动
```

### 后端 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 读取配置 |
| POST | `/api/config` | 保存配置 `{ sessionDir, sessionId }` |
| GET | `/api/sessions` | 递归扫描目录，返回会话列表（按 mtime 倒序） |
| GET | `/api/sessions/raw?file=` | 读取单个会话文件内容（限制在配置目录内） |

### 解析格式

兼容 Claude Code 与 Agent SDK 的 JSONL：
- 每行一个 JSON 事件，`type` 为 `user` / `assistant` / `system` / `ai-title` 等
- `assistant.message.content` 为块数组：`thinking` / `text` / `tool_use`
- `tool_result` 作为独立 `user` 行，通过 `sourceToolAssistantUUID` 回关联工具调用
- `ai-title` 提供会话标题，无标题时取首个用户消息
