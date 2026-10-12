# Agent Console

AI Agent 会话管理器 — 浏览 Claude Code 的 `.jsonl` 与 zcode 的 SQLite 会话记录，支持多来源合并、四维搜索、时间轴定位、文件夹自动扫描。

## 功能

- **来源多选** — 顶栏可勾选 Claude Code / zcode / dsh，默认都选中，三源按时间交错成一条列表；选择持久化到 localStorage
- **会话历史列表** — 自动扫描 Claude 会话文件夹，列出全部会话（标题、时间、消息统计），可增删切换
- **对话区域** — 时间线渲染：用户 / AI / 思考块 / 工具调用卡片（输入 JSON + 关联结果），system 事件胶囊显示
- **四维搜索** — 全文 + 工具调用 / AI 对话 / 用户对话 / 思考 过滤，命中高亮，Enter 直达定位
- **右侧轮次刻度栏** — 一根刻度 = 一条用户消息（"人说话"的节点）。定距 10px 一行、刻度条统一 20×2 靠 `scaleX` 伸缩（见下）；点刻度跳到那一轮、滚轮滚轨道、悬停出预览卡（该轮提问 1 行 + AI 回复 3 行），当前轮自动居中
- **会话身份** — chat 头部显示会话文件名与 `claude --resume <sessionId>` 命令，可选中复制
- **配置弹窗** — 设置 Claude 会话文件夹（默认 `C:\Users\sorye\.claude\projects`）与 zcode 数据目录（默认 `C:\Users\sorye\.zcode\cli`），保存后自动重扫
- **拖拽导入** — 把 `.jsonl` 拖进页面即加载，等同"导入会话"

## 运行

```bash
npm start        # 或 node server.js
```

打开 http://127.0.0.1:8123

- 首次启动扫描默认文件夹，**列表只取元数据**：标题、时间、消息条数由服务端统计缓存直接给出，
  不下载任何会话正文（本机目录 500 MB+，最大的单个会话 116 MB）
- 会话正文在**点开时**才加载，并在后台预热统计（`js/stats-worker.js`，独立线程，不阻塞服务）
- 后端不可达时回退为内置示例数据，可手动导入/拖拽

## 架构

```
index.html          前端入口
css/styles.css      design tokens + 组件样式
js/parser.js        Claude Code JSONL 解析器（tool_result 关联、thinking 兼容）
js/highlighter.js   DOM-safe 高亮与片段提取
js/zcode.js         zcode SQLite 适配器 + JSONL 桥（服务端专用，只读）
js/dsh.js           dsh 多帧 zstd 解压 + JSONL 桥 + sidecar 缓存（服务端专用，只读）
js/stats-worker.js  会话统计后台线程（worker_threads，复用 parser.js）
js/app.js           应用逻辑（列表/渲染/搜索/轮次刻度栏/配置）
server.js           Node 零依赖后端：静态服务 + 配置持久化 + 会话扫描
config.json         运行时生成：{ sessionDir, sessionId, zcodeDir }
session-index.json  运行时生成：会话统计缓存（file → mtime/size/stats），不入库
package.json        npm start 启动
```

### 性能

会话目录里单个 `.jsonl` 可以到 116 MB（1.8 万条消息）。任何"把全部会话读一遍"的做法在这个
量级上都是不可接受的，所以：

- **列表不含正文**。消息条数来自服务端持久化的统计缓存 `session-index.json`；缓存未命中时，
  条目 `stats` 为 `null`、响应带 `statsPending`，由后台线程补齐，前端轮询自然刷新。
- **统计在 worker 线程里算**，复用 `js/parser.js` 本体，因此数字与前端解析结果永远一致；
  线程与主线程隔离，实测冷启动解析 548 MB 期间 `/api/sessions` 稳定在 50–70 ms 无抖动。
- **折叠的正文延迟渲染**。工具调用/思考块的正文默认 `max-height: 0` 不可见，改为展开时才
  `JSON.stringify` + 转义填入 —— 1.8 万条的会话里这一项省掉了约 3/4 的渲染耗时。
- **轮次刻度栏只画用户轮次**，定距 10px 一行、刻度条统一 20×2 靠 `scaleX` 伸缩（模型照搬
  dsh 的 TurnNavigator，源码见 `@deepseek-ai/dsh-client-ui-chat`）。早先按真实像素偏移等比
  排、每根各画各的宽度，密处叠成一坨、疏处空一大截，看着参差 —— 定距等高 + 同基准缩放才整齐。
  1.8 万条消息的会话这里只有 200 多根刻度，不再有上万个事件点 DOM；超出 420px 封顶后
  在轨道内滚动（滚轮），当前轮自动滚到居中。
- **`/api/search` 用异步 `spawn`**（原为 `spawnSync`，会把整个事件循环连同其他请求一起冻住）。
- 看护中的大会话（>8 MB）不按 8 秒轮询重取全文，降到约 1 分钟一次。

### 后端 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 读取配置（附 `zcodeAvailable`） |
| POST | `/api/config` | 保存配置 `{ sessionDir, sessionId, zcodeDir }` |
| GET | `/api/sessions[?source=claude,zcode,dsh]` | 扫描目录，返回会话列表（按 lastTs 倒序）。**无 `source` 参数时默认只有 claude**，保持旧契约。新增 `size` 字段与顶层 `statsPending`；条目带 `stats`（缓存未就绪时为 `null`） |
| GET | `/api/sessions/raw?file=` | 读取单个会话内容（限制在配置目录内；`zcode::<id>` / `dsh::<id>` 走桥合成）。三者都流式返回，带 `Content-Length` |

`file` 参数有两种形态：Claude 是配置目录内的 `.jsonl` 绝对路径；zcode 是 `zcode::<sessionId>` 令牌。
`/parse`、`/export`、`/search`、`/stats` 均接受 `source`。

### zcode 来源（合成 JSONL 桥）

zcode 把会话存在 SQLite 里（`<zcodeDir>/db/db.sqlite` 的 `session`/`message`/`part` 三表），没有磁盘文件。
`js/zcode.js` 读库后**合成 Claude Code 同构的 JSONL 文本**返回，因此前端的解析器、缓存、渲染、
时间轴、导出全部零改动复用。

- 行序按 `message.sequence` → `part.sequence`（`parser.js` 的 `firstTs`/`lastTs` 取首尾行）
- `tool` part 拆成 `tool_use` + 紧跟其后的 `tool_result`，**必须在同一个 content 数组里**
  （`parser.js` 的 `pendingMap` 声明在 assistant 分支内部，跨数组就绑定不上）
- `step-start` / `step-finish` / `file` 跳过；`semantics.uiVisibility='hidden'` 视为 `isMeta`
- **只读**：优先 `readOnly:true` 打开，失败降级为读写 + `PRAGMA query_only=1`；
  绝不写入（读写打开后 close 会 checkpoint WAL，等于替 zcode 写一遍库）
- zcode 会话 `deletable:false`，`DELETE` 返回 400 而非 403（403 会误导成权限问题）
- 需要 Node ≥ 22.5（`node:sqlite`）；老版本上 `zcode.js` 静默降级，claude 来源照常工作

### dsh 来源（多帧 zstd 桥 + sidecar 缓存）

dsh（DeepSeek Harness）把会话存在 `<dshDir>/sessions/<编码后的 cwd>/<session-id>/session[.vN].jsonl.zstd`。
这个格式有两个坑，都是对着真实数据验证过的：

- **它不是单个 zstd 流，而是追加式多帧拼接**——每次写入追加一个独立帧。那个 20 MB 的会话里有
  **33726 个帧**。Node 的 `zlib.zstdDecompressSync` **不会跨帧**，它只解第一帧就静默返回、把其余全丢掉
  （用合成双帧文件验证过）。所以 `js/dsh.js` 自己按帧魔数（`28 B5 2F FD`）切分逐帧解压。
  4 字节魔数在压缩数据里误撞的概率约 `长度/2^32`，20 MB 文件期望不到 0.01 次，所以按魔数切分是可靠的。
- **一次会话产出约 5.4 万行，其中约 4.2 万行是流式增量**（`assistant/chunk`、`reasoning-chunks`、
  `text-chunks`、`tool-call-chunks`）。这些是冗余的——`assistant/message` 已经是拼装好的完整消息。
  桥只保留拼装行。

**sidecar 缓存**：首次访问某个会话时，把它的帧解压并转换成 Claude Code 同构 JSONL，写进 `.dsh-cache/`
（约几百 MB，已 gitignore，随时可删、会按需重建）。之后搜索走 ripgrep 扫普通文件、parse/导出
复用现成解析器——和 claude 完全一样的通路。因为帧是追加式的，会话变长**只需解新帧追加到 sidecar**，
不重建（`srcOffset` 记在 `session-index.json` 里）。

- 多代文件（`session.jsonl.zstd` / `.v3.` / `.v4.`）**取版本号最高的那个**
- 列表只做**有界头尾读**（各 128 KB）拿标题/时间，并按 size+mtime 记忆化，207 个会话冷 0.4 s / 热 35 ms
- **只读**：dsh 会话 `deletable:false`
- 全文搜索只能覆盖**已经建过 sidecar** 的会话（为一次查询解 320 MB 压缩数据不现实）；其余会话首次打开后才会命中

### 解析格式

兼容 Claude Code 与 Agent SDK 的 JSONL：
- 每行一个 JSON 事件，`type` 为 `user` / `assistant` / `system` / `ai-title` 等
- `assistant.message.content` 为块数组：`thinking` / `text` / `tool_use`
- `tool_result` 作为独立 `user` 行，通过 `sourceToolAssistantUUID` 回关联工具调用
- `ai-title` 提供会话标题，无标题时取首个用户消息
