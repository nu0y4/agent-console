---
name: agent-console
description: "Agent Console 会话管理器的 REST API 操作。当用户要查询/搜索/导出/删除 Claude Code 或 zcode 会话、统计会话数据、或通过 API 与本地会话数据库交互时使用。触发词：查询会话、搜索会话内容、导出会话、统计会话、删除会话、查看 API、curl 调用会话接口、zcode 会话。即使没有显式说 'API'，只要涉及操作 agent-console 的会话数据就用本 skill。"
---

# Agent Console API 操作

Agent Console 是一个本地 AI 会话管理器（`I:\lab\Agentseesion`），把 Claude Code 的 `.jsonl` 会话与 zcode 的 SQLite 会话统一暴露为 REST API。本 skill 教你用这些 API 查询、搜索、导出、删除会话。

## 前置

- 服务运行在 `http://127.0.0.1:8123`（端口可用 `PORT` 环境变量覆盖）
- 后端在 `I:\lab\Agentseesion\server.js`，启动：`node server.js`
- **无鉴权**，本地工具，直接 curl 调用
- **三个来源**，用 `source` 参数选择，如 `claude` / `zcode` / `dsh` / `claude,zcode,dsh`：
  - `claude`（默认）：`file` 必须是配置目录内的 `.jsonl` 绝对路径（默认 `C:\Users\sorye\.claude\projects`），跨目录返回 403
  - `zcode`：`file` 是令牌 `zcode::<sessionId>`，数据来自 `<zcodeDir>/db/db.sqlite`（默认 `C:\Users\sorye\.zcode\cli`）。**只读**
  - `dsh`：`file` 是令牌 `dsh::<sessionId>`，数据来自 `<dshDir>/sessions/**/session[.vN].jsonl.zstd`（默认 `C:\Users\sorye\.dsh`）。**只读**
  - **不带 `source` 参数的 `/api/sessions` 仍只返回 claude**（向后兼容）；要与旧行为一致就别传
- zcode 来源需 Node ≥ 22.5（`node:sqlite`）；低版本下 `zcodeAvailable:false`，zcode 请求会失败
- dsh 来源需要 Node 的 zstd 支持（`zlib.zstdDecompressSync`）。注意它的 `.jsonl.zstd` 是**追加式多帧拼接**，
  一次读取会把帧逐帧解压并缓存成 sidecar，所以**同一个 dsh 会话第一次读会慢**（最大的约 3 s），之后走缓存很快。
  全文搜索只覆盖已经建过 sidecar 的 dsh 会话

## 测试状态

以下每个 API 均已实测通过（10/10）。返回码与响应结构以实际为准。

---

## API 总览

| # | 方法 | 路径 | 功能 |
|---|------|------|------|
| 1 | GET | `/api` | API 文档 |
| 2 | GET | `/api/config` | 读取配置 |
| 3 | POST | `/api/config` | 保存配置 |
| 4 | GET | `/api/sessions[?source=]` | 会话列表 |
| 5 | GET | `/api/sessions/raw?file=` | 会话原文 |
| 6 | GET | `/api/sessions/parse?file=` | 结构化解析 |
| 7 | GET | `/api/sessions/export?file=` | 导出 txt |
| 8 | DELETE | `/api/sessions?file=` | 删除会话（**仅 claude**） |
| 9 | GET | `/api/search?q=[&source=]` | 全文搜索 |
| 10 | GET | `/api/stats[?source=]` | 全局统计 |

5~9 号端点都接受 `source` 参数来区分来源；`file` 为 `zcode::<id>` 或 `dsh::<id>` 时 source 可省略（服务端按令牌自动判定）。

---

## 1. GET /api — API 文档

服务自描述，返回全部端点列表。

**curl：**
```bash
curl http://127.0.0.1:8123/api
```

**响应示例：**
```json
{
  "name": "agent-console API",
  "base": "http://127.0.0.1:8123",
  "endpoints": [ { "method": "GET", "path": "/api/config", "desc": "读取配置" }, ... ]
}
```

**用途：** 服务端升级后先调这个拿最新端点，避免用过期的路径。

---

## 2. GET /api/config — 读取配置

返回当前会话文件夹配置。

**curl：**
```bash
curl http://127.0.0.1:8123/api/config
```

**响应示例：**
```json
{ "sessionDir": "C:\\Users\\sorye\\.claude\\projects", "sessionId": "" }
```

---

## 3. POST /api/config — 保存配置

修改扫描的会话文件夹。**改完会重扫目录**，新文件夹下的会话立即生效。

**curl：**
```bash
curl -X POST http://127.0.0.1:8123/api/config \
  -H "Content-Type: application/json" \
  -d '{"sessionDir":"D:\\会话备份","sessionId":""}'
```

**响应示例：**
```json
{ "sessionDir": "D:\\会话备份", "sessionId": "" }
```

---

## 4. GET /api/sessions — 会话列表

返回会话的元数据，**按结束时间（lastTs）倒序**。每个条目含 title（标题）、lastTs（最后消息时间）、mtime（文件修改时间）、size（文件字节数）、folder（所属子文件夹）、sessionId、source、deletable、stats。

**`stats` 与 `statsPending`（claude 来源）：** claude 会话的 stats 由服务端后台统计并落盘缓存
（`session-index.json`）。缓存算好之前该条目的 `stats` 为 `null`，响应顶层的 `statsPending`
给出还剩几个未算完 —— 轮询几次就会补齐。zcode 的 stats 始终由 SQL 聚合即时给出。
所以**不要假设 claude 条目的 stats 一定非空**，需要精确值时读 `statsPending` 或改用 `/parse`。

**curl：**
```bash
curl http://127.0.0.1:8123/api/sessions                  # 只有 claude
curl "http://127.0.0.1:8123/api/sessions?source=zcode"   # 只有 zcode
curl "http://127.0.0.1:8123/api/sessions?source=claude,zcode"   # 合并且按时间交错
```

**zcode 条目示例：**
```json
{ "sessionId": "sess_ab45c84f-d125-456b-ba36-a10b3819f7f9",
  "file": "zcode::sess_ab45c84f-d125-456b-ba36-a10b3819f7f9",
  "title": "用户质问上线问题", "folder": "I:/实验室",
  "lastTs": "2026-10-07T15:35:58.590Z", "mtime": 1791387358590,
  "source": "zcode", "deletable": false,
  "stats": { "user": 38, "ai": 545, "tool": 538, "thinking": 350, "total": 583 } }
```

**提示：** zcode 的 `stats` 由 SQL 聚合得出，和 `parse` 的统计一致，可直接用于列表展示，不必先 parse。

**响应示例（截取）：**
```json
{
  "count": 156,
  "sessions": [
    { "sessionId": "61b50004...", "file": "C:\\...\\61b50004....jsonl",
      "name": "61b50004....jsonl", "mtime": 1787903960000,
      "folder": "I--lab-Agentseesion", "title": "写一个项目...",
      "lastTs": "2026-08-28T08:11:37.000Z" }
  ]
}
```

**提示：** 拿 `file` 值作为后续 raw/parse/export/delete 的 `file` 参数。先列表→定位→再操作，是标准流程。

---

## 5. GET /api/sessions/raw — 会话原文

返回 `.jsonl` 原始文本，每行一个 JSON 事件。

**curl：**
```bash
curl "http://127.0.0.1:8123/api/sessions/raw?file=C:%5CUsers%5Csorye%5C.claude%5Cprojects%5CI--lab-Agentseesion%5C61b50004-ad5c-4682-a3b5-f4b576af02a7.jsonl"

# zcode：合成出来的 JSONL（冒号编码成 %3A）
curl "http://127.0.0.1:8123/api/sessions/raw?file=zcode%3A%3Asess_ab45c84f-d125-456b-ba36-a10b3819f7f9"
```

**注意：** Windows 路径反斜杠在 URL 里要编码成 `%5C`。跨配置目录返回 403。

**zcode 的 raw 是合成产物**，不是磁盘上的文件：服务端读 SQLite 后拼成 Claude Code 同构的 JSONL。
格式与真实 claude 会话一致，可直接喂给 `parser.js`；`tool_result` 紧跟对应的 `tool_use` 在同一 content 数组内。

---

## 6. GET /api/sessions/parse — 结构化解析

返回会话的完整结构化内容：`messages`（数组，每条的 blocks/kind/text/tool_use 等）、`stats`（user/ai/tool/thinking 计数）、`title`、`firstTs`/`lastTs`。

**curl：**
```bash
curl "http://127.0.0.1:8123/api/sessions/parse?file=<编码后的路径>"
```

**响应示例（截取）：**
```json
{
  "title": "写一个项目...",
  "stats": { "user": 127, "ai": 2839, "tool": 989, "thinking": 1046, "total": 3057 },
  "messages": [
    { "kind": "user", "role": "user", "text": "帮我把网段做指纹识别", "timestamp": "..." },
    { "kind": "assistant", "blocks": [
        { "kind": "thinking", "text": "..." },
        { "kind": "tool_use", "id": "...", "name": "Bash", "input": { "command": "nmap ..." }, "result": { "content": "..." } },
        { "kind": "text", "text": "指纹完成" }
    ]}
  ]
}
```

**用途：** 脚本分析会话时优先用这个，不用自己解析 jsonl。message 的 `kind` 有 `user`/`assistant`/`system`；assistant 的 blocks 含 `thinking`/`text`/`tool_use`。

---

## 7. GET /api/sessions/export — 导出 txt

把会话导出为纯文本（含 thinking 标签和 tool 命令），响应带 `Content-Disposition` 附件头，可直接落盘。

**curl：**
```bash
curl -o session.txt "http://127.0.0.1:8123/api/sessions/export?file=<编码后的路径>"
```

**输出格式：**
```
===== 会话：标题 =====
sessionId: xxx
文件：xxx

[23:32:48]用户：说的话
[23:32:51]AI：<thinking>思考</thinking>
文本
<tool>Bash
{"command":"nmap ..."}
</tool>
```

---

## 8. DELETE /api/sessions — 删除会话

**破坏性操作，不可恢复。** 删除磁盘上的会话文件。确认后再调。

**curl：**
```bash
curl -X DELETE "http://127.0.0.1:8123/api/sessions?file=<编码后的路径>"
```

**响应：**
```json
{ "ok": true, "file": "..." }
```

**安全：** 只允许删配置目录内的 `.jsonl`，否则 403；文件不存在 404。

**zcode / dsh 不可删。** 传 `zcode::<id>` 会返回 **400**（不是 403）；dsh 的列表条目 `deletable:false`：
```json
{ "error": "zcode 会话为只读，请在 zcode 应用中删除" }
```
原因：zcode 的数据在它自己的 SQLite 库里，且 zcode 进程正持有该库；这个服务无鉴权，
写一个第三方正在使用的状态库不划算。要删就在 zcode 应用里删。

---

## 9. GET /api/search — 全文搜索

用 ripgrep 扫 claude 会话文件、用 SQLite `LIKE` 扫 zcode 库，返回**会话级**命中（不定位到具体行）。大小写不敏感。

**curl：**
```bash
curl "http://127.0.0.1:8123/api/search?q=redis"                    # 只有 claude
curl "http://127.0.0.1:8123/api/search?q=redis&source=claude,zcode" # 两源合并
```

**响应示例：**
```json
{ "q": "redis", "count": 97, "sessions": [ { "file": "...", "title": "...", "mtime": 1787..., "source": "claude" } ] }
```

**提示：** 结果按 mtime 排序，每条带 `source`。命中的是会话，要定位具体消息用 `parse` 再搜。

---

## 10. GET /api/stats — 全局统计

聚合全部会话的统计：总数、消息数、用户/AI消息、工具调用、思考块、按日期分布。

zcode 部分走 SQL 聚合，不逐会话解析。claude 部分读的是会话统计缓存，**不是**每次实时重解析
（那要读 500 MB+ 的转录）。冷启动或文件刚改动时，个别会话可能还没算完，此时总数偏小，
响应里的 `pendingStats` 会告诉你有几个没算进去 —— 想等全量精确值就先轮询到 `pendingStats: 0`。

**curl：**
```bash
curl http://127.0.0.1:8123/api/stats                            # 只有 claude
curl "http://127.0.0.1:8123/api/stats?source=claude,zcode"
```

**响应示例：**
```json
{
  "sessionCount": 156,
  "messageCount": 141420,
  "aiMessages": 138659,
  "userMessages": 2761,
  "toolCalls": 49946,
  "thinkingBlocks": 0,
  "sessionsByDay": { "2026-08-28": 8, "2026-08-27": 1 },
  "pendingStats": 0
}
```

`pendingStats` 为 0 表示统计缓存已覆盖全部会话，上面的数字是精确值。

---

## 实战流程示例

**0. 跨两个来源搜一个词：**
```bash
curl -s "http://127.0.0.1:8123/api/search?q=面包狗&source=claude,zcode" \
  | jq -r '.sessions[] | "\(.source)\t\(.title)\t\(.file)"'
# 想读某条 zcode 命中，直接拿它的 file 令牌
curl -s "http://127.0.0.1:8123/api/sessions/parse?file=zcode%3A%3Asess_ab45c84f-d125-456b-ba36-a10b3819f7f9" \
  | jq '.stats,.title'
```

**1. 找最近会话并看结构：**
```bash
# 先列会话拿 file
curl -s http://127.0.0.1:8123/api/sessions | jq -r '.sessions[0].file'
# 再结构化解析
curl -s "http://127.0.0.1:8123/api/sessions/parse?file=<file>" | jq '.stats'
```

**2. 搜索含"redis"的会话并导出：**
```bash
curl -s "http://127.0.0.1:8123/api/search?q=redis" | jq -r '.sessions[].file' | \
  while read f; do
    enc=$(python -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$f")
    curl -o "$(basename $f .jsonl).txt" "http://127.0.0.1:8123/api/sessions/export?file=$enc"
  done
```

**3. 统计今天的工具调用量：**
```bash
curl -s http://127.0.0.1:8123/api/stats | jq '.toolCalls'
```

## 注意

- URL 中 `?`、`&`、`\` 等字符必须编码；Windows 路径的 `\` → `%5C`
- `parse`/`export` 对大会话（几 MB）有解析耗时，耐心等响应
- 会话文件可能被 Claude Code 实时写入，mtime 会变；重连查询以最新列表为准
