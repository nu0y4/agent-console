/* Built-in demo sessions.
   Each line is a raw event row (shape matches real Claude Code .jsonl):
   tool results arrive as their own "user" row holding a tool_result block,
   referencing the producing assistant row via sourceToolAssistantUUID.
   Content is richer than before so the timeline scrubber has room to move.
*/
const SAMPLE_SESSIONS = (() => {

  /* ---- helpers: monotonic timestamps ---- */
  const clock = (startISO, stepSec) => {
    let t = Date.parse(startISO);
    return (jitter = 0) => {
      t += (stepSec + jitter) * 1000;
      return new Date(t).toISOString();
    };
  };
  let n = 0;
  const uid = (p) => `${p}-${String(++n).padStart(3, "0")}`;

  /* one tool call round: assistant(thinking+tool_use) -> user(tool_result) */
  const toolTurn = (gen, prefix, name, input, result, thinking, opts) => {
    const uuid = uid(prefix);
    const rows = [];
    const content = [];
    if (thinking) content.push({ type: "thinking", thinking: { content: thinking } });
    content.push({ type: "tool_use", id: `tu-${uuid}`, name, input });
    rows.push({
      type: "assistant", message: { role: "assistant", content },
      timestamp: gen(), uuid, sessionId: opts.sessionId,
    });
    rows.push({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu-${uuid}`, content: result, is_error: !!(opts && opts.isError) }] },
      sourceToolAssistantUUID: uuid, parentUuid: uuid,
      timestamp: gen(), uuid: uid(prefix), sessionId: opts.sessionId,
    });
    return rows;
  };

  const aiText = (gen, prefix, text, opts) => ({
    type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: gen(), uuid: uid(prefix), sessionId: opts.sessionId,
  });
  const userSay = (gen, prefix, text, opts) => ({
    type: "user", message: { role: "user", content: text },
    timestamp: gen(), uuid: uid(prefix), sessionId: opts.sessionId,
    userType: "external", cwd: opts.cwd,
  });
  const systemEvt = (gen, prefix, summary, subtype, opts) => ({
    type: "system", subtype, summary, messageId: uid(prefix),
    timestamp: gen(), sessionId: opts.sessionId,
  });

  /* ============================================================
     示例-01 资产侦查与暴露面梳理（长会话，多轮探测）
     ============================================================ */
  function s1() {
    const opts = { sessionId: "demo-001", cwd: "E:\\lab\\recon" };
    const gen = clock("2026-08-20T09:00:00.000Z", 18);
    const lines = [];
    lines.push({ type: "mode", mode: "normal", sessionId: opts.sessionId });
    lines.push({ type: "permission-mode", permissionMode: "acceptEdits", sessionId: opts.sessionId });
    lines.push({ type: "ai-title", title: "资产侦查与暴露面梳理", sessionId: opts.sessionId });
    lines.push(systemEvt(gen, "sys", "会话已启动", "message_start", opts));
    lines.push(userSay(gen, "u", "帮我把 10.10.0.0/24 网段做一次资产指纹识别，重点看 80/443/22 的存活主机，最后输出表格。", opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "nmap -sS -Pn -p 22,80,443 --open 10.10.0.0/24 -oG -" },
      "Host: 10.10.0.5 (web-gw) Ports: 80/open/tcp,443/open/tcp\nHost: 10.10.0.11 (app-01) Ports: 22/open/tcp,80/open/tcp\nHost: 10.10.0.12 (db-int) Ports: 22/open/tcp",
      "用户要做端口存活与指纹识别。先快速扫 C 段存活，再逐台抓 banner。",
      opts));

    lines.push(...toolTurn(gen, "a", "WebFetch",
      { url: "http://10.10.0.5/", prompt: "提取服务器指纹信息" },
      "HTTP/1.1 302 Found\nServer: nginx/1.18.0\nLocation: /login\nSet-Cookie: SESSION=9f8e7d6c",
      "web-gw 是 nginx 反代，重定向到登录页。继续看 app-01。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "curl -s -I http://10.10.0.11 | grep -iE 'server|x-powered'" },
      "Server: Apache/2.4.41 (Ubuntu)\nX-Powered-By: PHP/7.4",
      "app-01 是 Apache+PHP 栈。",
      opts));

    lines.push(aiText(gen, "a", "第一轮指纹完成，先汇报：\n\n| IP | 端口 | 服务 | 指纹 |\n| --- | --- | --- | --- |\n| 10.10.0.5 | 80,443 | web-gw | nginx/1.18.0，登录页 |\n| 10.10.0.11 | 22,80 | app-01 | Apache/2.4.41 + PHP/7.4 |\n| 10.10.0.12 | 22 | db-int | 仅 SSH 开放 |\n\n要继续深挖数据库端口吗？", opts));

    lines.push(userSay(gen, "u", "继续，扫一下常见数据库端口，还有 10.10.0.13-20 的存活。", opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "nmap -sS -Pn -p 3306,5432,6379,27017 --open 10.10.0.0/24 -oG -" },
      "Host: 10.10.0.12 Ports: 6379/open/tcp\nHost: 10.10.0.15 Ports: 27017/open/tcp",
      "数据库端口：10.10.0.12 开 6379(Redis)，10.10.0.15 开 27017(MongoDB)。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "redis-cli -h 10.10.0.12 -p 6379 INFO server | head -8" },
      "# Server\nredis_version:5.0.14\nos:Linux 5.4.0-91-generic\nrun_id:3fa8c1...\n# 未要求密码，连接成功",
      "Redis 未授权可连，信息泄露风险确认。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "nmap -sS -Pn -p 22,80,443,8080 10.10.0.13-20 -oG -" },
      "Host: 10.10.0.13 Ports: 22/open/tcp\nHost: 10.10.0.15 Ports: 27017/open/tcp\nHost: 10.10.0.17 Ports: 8080/open/tcp\nHost: 10.10.0.19 Ports: 80/open/tcp",
      "新存活：.13(SSH)、.17(8080)、.19(80)。.15 是 MongoDB 那台。",
      opts));

    lines.push(...toolTurn(gen, "a", "WebFetch",
      { url: "http://10.10.0.17:8080/", prompt: "识别中间件与版本" },
      "HTTP/1.1 200 OK\nServer: Jetty/9.4.43\nContent-Type: text/html\nTitle: 报表中心",
      "10.10.0.17 是 Jetty 报表中心。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "curl -s http://10.10.0.19/ | grep -iE 'generator|powered|title'" },
      "<meta name=\"generator\" content=\"WordPress 6.4\">\n<title>IT 部门博客</title>",
      "10.10.0.19 是 WordPress 6.4 博客。",
      opts));

    lines.push(...toolTurn(gen, "a", "Grep",
      { pattern: "jetty.*(CVE|rce)", path: "~/.cache/cve-db", output_mode: "content" },
      "CVE-2023-44487 (HTTP/2 Rapid Reset) 影响 Jetty\nCVE-2022-2048 未授权路径 影响 Jetty < 9.4.49",
      "对照本地 CVE 库确认 Jetty 已知风险。",
      opts));

    lines.push(aiText(gen, "a", "深挖完成，暴露面清单更新：\n\n| IP | 端口 | 服务 | 指纹 | 风险点 |\n| --- | --- | --- | --- | --- |\n| 10.10.0.5 | 80,443 | nginx/1.18.0 | 登录页反代 | — |\n| 10.10.0.11 | 22,80 | Apache+PHP/7.4 | 业务站 | — |\n| 10.10.0.12 | 22,6379 | Redis 5.0.14 | **未授权可连** | 信息泄露 |\n| 10.10.0.15 | 27017 | MongoDB | 待探测 | — |\n| 10.10.0.17 | 8080 | Jetty/9.4.43 | 报表中心 | CVE-2022-2048 |\n| 10.10.0.19 | 80 | WordPress 6.4 | IT 博客 | 待扫插件 |", opts));

    lines.push(userSay(gen, "u", "MongoDB 那台也看一眼，另外 WordPress 挂一下插件指纹。", opts));
    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "mongosh --quiet --host 10.10.0.15 --eval 'db.adminCommand({getCmdLineOpts:1})' 2>&1 | head -12" },
      "MongoDB shell version 4.4.18\n{ cmdLineOpts: { net: { bindIp: '0.0.0.0', port: 27017 }, security: { authorization: 'disabled' } } }",
      "MongoDB 同样未开启认证，绑定 0.0.0.0。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "wpscan --url http://10.10.0.19 --enumerate vp --no-banner 2>/dev/null | grep -E 'vulnerab|Installed'" },
      "[+] WPScan DB API disabled\n[+] Plugins: 3 installed\n[!] 插件 uji-slider 存在已知 XSS (无版本校验)",
      "WordPress 插件 uji-slider 疑似有已知 XSS。",
      opts));

    lines.push(aiText(gen, "a", "全部汇总：\n\n**高危**\n- 10.10.0.12 Redis 5.0 未授权 → 可写 SSH key / crontab 提权\n- 10.10.0.15 MongoDB 未认证 → 数据可直读\n\n**中危**\n- 10.10.0.17 Jetty 版本落后，存在 CVE-2022-2048\n- 10.10.0.19 WordPress 插件 uji-slider 疑似 XSS\n\n建议先收紧数据库监听与认证，再更新 Jetty。要不要我把这份报告写成文件存档？", opts));

    lines.push(userSay(gen, "u", "写成 md 存到 E:\\lab\\recon\\report.md", opts));
    lines.push(...toolTurn(gen, "a", "Write",
      { file_path: "E:\\lab\\recon\\report.md", content: "# 资产侦查报告\n\n## 存活主机\n\n| IP | 端口 | 服务 | 指纹 |\n| --- | --- | --- | --- |\n| 10.10.0.5 | 80,443 | nginx/1.18.0 | 登录页反代 |\n| 10.10.0.11 | 22,80 | Apache+PHP | 业务站 |\n...\n\n## 风险点\n- Redis 未授权\n- MongoDB 未认证\n- Jetty 版本落后\n- WordPress 插件 XSS" },
      "已写入 report.md",
      "把结论落到报告文件。",
      opts));

    lines.push(aiText(gen, "a", "报告已写入 `E:\\lab\\recon\\report.md`。本次资产侦查共发现 6 台存活主机、4 处风险点，收工。", opts));
    return lines;
  }

  /* ============================================================
     示例-02 定位 grep 误报并修复搜索逻辑（反复调试循环）
     ============================================================ */
  function s2() {
    const opts = { sessionId: "demo-002", cwd: "E:\\lab\\search" };
    const gen = clock("2026-08-20T11:00:00.000Z", 14);
    const lines = [];
    lines.push({ type: "ai-title", title: "定位 grep 误报并修复搜索逻辑", sessionId: opts.sessionId });
    lines.push(userSay(gen, "u", "我的搜索脚本 grep 到了不该匹配的二进制文件，帮我修一下。", opts));

    lines.push(...toolTurn(gen, "a", "Grep",
      { pattern: "password", path: "src", output_mode: "files_with_matches" },
      "src/config.js\nsrc/vendor.min.js\nsrc/data.bin\nsrc/test/fixture.img",
      "用户说 grep 误匹配二进制。先复现看是哪些文件。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "file src/vendor.min.js src/data.bin src/test/fixture.img" },
      "src/vendor.min.js: ASCII text, with very long lines\nsrc/data.bin: data (binary)\nsrc/test/fixture.img: disk image, DOS/MBR",
      "vendor.min.js 是超长行文本，data.bin 和 fixture.img 是真二进制。",
      opts));

    lines.push(aiText(gen, "a", "复现了：`vendor.min.js`、`data.bin`、`fixture.img` 都是误报。根因是 grep 没有做文本/二进制区分，也没有跳过二进制扩展名。开始改脚本。", opts));

    lines.push(...toolTurn(gen, "a", "Read",
      { file_path: "src/search.js", offset: 1, limit: 40 },
      "#!/usr/bin/env node\nconst { execSync } = require('child_process');\nfunction search(dir, pattern) {\n  const cmd = `grep -r ${pattern} ${dir}`;\n  return execSync(cmd).toString();\n}\nmodule.exports = { search };",
      "脚本是 execSync 拼命令，没做任何过滤。",
      opts));

    lines.push(...toolTurn(gen, "a", "Edit",
      { file_path: "src/search.js", old_string: "const cmd = `grep -r ${pattern} ${dir}`;", new_string: "const cmd = `grep -rI --exclude={*.bin,*.img} --exclude-dir={node_modules,.git} ${pattern} ${dir}`;" },
      "已应用修改 src/search.js",
      "加 -I 忽略二进制，排除 bin/img 与 node_modules。",
      opts));

    lines.push(userSay(gen, "u", "试跑一下，还有没有漏网之鱼。", opts));
    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "node src/search.js password src && echo '--- 退出码 0 ---'" },
      "src/config.js: export const PASSWORD_HINT = 'set in .env';\n--- 退出码 0 ---",
      "现在只剩 config.js 一条文本命中。",
      opts));

    lines.push(userSay(gen, "u", "顺带把 node_modules 也排掉，不然每次都要自己写参数。", opts));
    lines.push(...toolTurn(gen, "a", "Edit",
      { file_path: "src/search.js", old_string: "--exclude-dir={node_modules,.git}", new_string: "--exclude-dir={node_modules,.git,dist,build}" },
      "已应用修改 src/search.js",
      "用户补充：连同 dist/build 一起排除。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "node src/search.js 'TODO' src && echo ok" },
      "src/main.js:26: TODO: handle empty input\nok",
      "换关键词再验证一次排除规则仍然生效。",
      opts));

    lines.push(aiText(gen, "a", "修好了。改动汇总：\n- `grep -r` → `grep -rI`（忽略二进制）\n- 排除 `*.bin`、`*.img`\n- `--exclude-dir` 排除 node_modules/.git/dist/build\n\n复测两轮均正常。", opts));
    return lines;
  }

  /* ============================================================
     示例-03 写一个读取 .jsonl 会话记录的小工具
     ============================================================ */
  function s3() {
    const opts = { sessionId: "demo-003", cwd: "E:\\lab\\session-tool" };
    const gen = clock("2026-08-20T14:00:00.000Z", 16);
    const lines = [];
    lines.push({ type: "mode", mode: "plan", sessionId: opts.sessionId });
    lines.push({ type: "ai-title", title: "写一个读取 .jsonl 会话记录的小工具", sessionId: opts.sessionId });
    lines.push(userSay(gen, "u", "有个目录里全是 .jsonl 的会话记录，我要能按关键词全文搜、还要能只看工具调用。做个命令行工具吧。", opts));

    lines.push(...toolTurn(gen, "a", "Write",
      { file_path: "search.js", content: "const fs = require('fs');\nconst path = require('path');\nfunction* walk(dir) {\n  for (const f of fs.readdirSync(dir)) {\n    const p = path.join(dir, f);\n    if (fs.statSync(p).isDirectory()) yield* walk(p);\n    else if (f.endsWith('.jsonl')) yield p;\n  }\n}\nmodule.exports = { walk };" },
      "已写入 search.js",
      "需求拆解：1) 遍历目录读 .jsonl；2) 按行 JSON.parse；3) 区分 text / tool_use / user 三类索引；4) 关键词 + 类型过滤。先写文件遍历。",
      opts));

    lines.push(...toolTurn(gen, "a", "Write",
      { file_path: "index.js", content: "const { walk } = require('./search');\nconst fs = require('fs');\nconst q = process.argv[2];\nconst type = (process.argv.find(a => a.startsWith('--type=')) || '--type=all').slice(7);\nconst hits = [];\nfor (const f of walk('.')) {\n  const lines = fs.readFileSync(f, 'utf8').split('\\n');\n  lines.forEach((l, i) => {\n    let o; try { o = JSON.parse(l); } catch { return; }\n    const msg = o.message || {};\n    const text = JSON.stringify(msg.content || '');\n    if (!text.includes(q)) return;\n    const kind = o.type === 'assistant' ? 'ai' : o.type === 'user' ? 'user' : '? ';\n    if (type !== 'all' && kind !== type) return;\n    hits.push(`${f} L${i+1} ${kind} ${text.slice(0, 60)}`);\n  });\n}\nconsole.log(hits.join('\\n'));" },
      "已写入 index.js",
      "主逻辑：遍历、逐行解析、按类型过滤。JSON.stringify 把 content 拍平方便全文匹配。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "node index.js worktrees --type=all" },
      "01.jsonl L12  user  会话说明里提到 worktrees\n02.jsonl L33  ai    在 /worktrees 下创建分支…\n03.jsonl L41  tool  Bash 命令包含 worktrees",
      "先跑通全量搜索验证。",
      opts));

    lines.push(userSay(gen, "u", "全量能搜了，但我想只看某类，再帮我加个 --type=tool 试试。", opts));
    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "node index.js worktrees --type=tool" },
      "03.jsonl L41  tool  Bash 命令包含 worktrees",
      "类型过滤生效。",
      opts));

    lines.push(userSay(gen, "u", "那个 kind 判断好像 user 和 tool 分不清，你确认下 assistant 里的 tool_use 到底算哪类。", opts));
    lines.push(...toolTurn(gen, "a", "Read",
      { file_path: "index.js", offset: 8, limit: 12 },
      "const kind = o.type === 'assistant' ? 'ai' : o.type === 'user' ? 'user' : '?';",
      "发现问题：assistant 行里的 tool_use 块被整体归成 ai，工具调用被吞了。需要按 content 块细分。",
      opts));

    lines.push(...toolTurn(gen, "a", "Edit",
      { file_path: "index.js", old_string: "const kind = o.type === 'assistant' ? 'ai' : o.type === 'user' ? 'user' : '?';", new_string: "let kind = o.type === 'user' ? 'user' : 'ai';\nconst blocks = Array.isArray(msg.content) ? msg.content : [];\nif (blocks.some(b => b.type === 'tool_use')) kind = 'tool';\nif (o.type === 'assistant' && blocks.some(b => b.type === 'tool_use')) kind = 'tool';" },
      "已应用修改 index.js",
      "按 content 块里的 tool_use 细分类型，用户/AI/工具三态清晰。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "node index.js worktrees --type=all && echo --- && node index.js worktrees --type=tool" },
      "01.jsonl L12  user  会话说明里提到 worktrees\n03.jsonl L41  tool  Bash 命令包含 worktrees\n---\n03.jsonl L41  tool  Bash 命令包含 worktrees",
      "复测：tool 只命中 03，分类正确。",
      opts));

    lines.push(aiText(gen, "a", "搞定。`node index.js <关键词> --type=all|tool|ai|user` 即可分类搜，纯 Node 无第三方依赖。顺带说明：这个工具就是用它自己解析的 `.jsonl` 会话格式写出来的。", opts));
    return lines;
  }

  /* ============================================================
     示例-04 排查服务异常（新增）
     ============================================================ */
  function s4() {
    const opts = { sessionId: "demo-004", cwd: "E:\\lab\\ops" };
    const gen = clock("2026-08-19T16:30:00.000Z", 12);
    const lines = [];
    lines.push({ type: "ai-title", title: "排查线上 502 网关错误", sessionId: opts.sessionId });
    lines.push(userSay(gen, "u", "今天下午 API 网关一直 502，帮忙看下后端日志。", opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "tail -200 /var/log/nginx/error.log | grep -iE '502|upstream' | tail -20" },
      "2026/08/19 16:12:33 [error] 41234#0: *98211 connect() failed (111: Connection refused) while connecting to upstream, client: 10.0.1.5, server: api.example.com, upstream: 127.0.0.1:8081",
      "502 是 upstream 8081 拒连。看后端服务状态。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "systemctl status api-app --no-pager -l | head -15" },
      "● api-app.service - API Application\n   Active: failed (Result: exit-code) since 2026-08-19 16:11:45\n  Main PID: 4287 (code=exited, status=1/FAILURE)",
      "api-app 服务在 16:11:45 崩溃退出。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "journalctl -u api-app --since '16:00' --until '16:15' -n 40" },
      "16:11:42 api-app[4287]: ERROR OOM kill detected: java.lang.OutOfMemoryError: GC overhead limit exceeded\n16:11:45 api-app[4287]: FATAL: shutting down",
      "根因是堆内存 OOM。查一下是哪个接口把内存打爆。",
      opts));

    lines.push(...toolTurn(gen, "a", "Grep",
      { pattern: "OutOfMemoryError|heap dump", path: "/var/log/api-app", output_mode: "content" },
      "api-app.log.1: 16:08:31 ERROR OOM started at /export/report/batch\napi-app.log.1: 16:09:02 WARN  report/batch concurrent=42 mem=3.8G/4G",
      "OOM 前是 /export/report/batch 大批量导出。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "free -h && grep -E 'Xmx|Xms' /etc/api-app/jvm.conf" },
      "total   mem 3.8G / 4G used, 200M free\n- Xmx2g\n- Xms512m",
      "堆上限 2G，导出接口峰值 3.8G 越界。",
      opts));

    lines.push(aiText(gen, "a", "诊断结论：\n- 触发：`/export/report/batch` 导出在 16:08 并发 42 个任务，堆瞬时冲到 3.8G\n- 根因：JVM 堆上限 2G + 导出未分批，GC 撑不住直接 OOM\n- 建议：堆提到 4G 治标；把批量导出改成分页/限流是根治", opts));

    lines.push(userSay(gen, "u", "先紧急重启顶上，内存参数我晚点调。", opts));
    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "systemctl start api-app && sleep 2 && systemctl is-active api-app" },
      "active",
      "服务拉起来了。",
      opts));

    lines.push(aiText(gen, "a", "服务已恢复运行。观测 10 分钟看会不会再崩，同时建议尽快落一个分批导出的修复。", opts));
    return lines;
  }

  /* ============================================================
     示例-05 批量重命名与整理文档（新增，工具密集型）
     ============================================================ */
  function s5() {
    const opts = { sessionId: "demo-005", cwd: "E:\\lab\\docs" };
    const gen = clock("2026-08-18T10:00:00.000Z", 10);
    const lines = [];
    lines.push({ type: "ai-title", title: "批量重命名截图并按项目归档", sessionId: opts.sessionId });
    lines.push(userSay(gen, "u", "downloads 里一堆命名混乱的截图，按日期和内容整理到 docs/screenshots 下。", opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "ls -1 ~/downloads/*.png | head -20" },
      "screenshot (1).png\nIMG_20260818_093012.png\n未命名-2.png\n螢幕截圖_2026-08-18.png\nshot-0818-01.png\n…共 47 个文件",
      "先盘点命名混乱程度：中英文+系统自动命名混用。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "file ~/downloads/screenshot\\ \\(1\\).png ~/downloads/IMG_20260818_093012.png | sed 's/.*image/PNG image/'" },
      "PNG image data, 1920x1080\nPNG image data, 800x600",
      "全是 PNG，尺寸各异。",
      opts));

    lines.push(...toolTurn(gen, "a", "Write",
      { file_path: "rename.js", content: "const fs = require('fs');\nconst path = require('path');\nconst dir = process.argv[2] || '.';\nconst out = [];\nfor (const f of fs.readdirSync(dir)) {\n  if (!/png$/i.test(f)) continue;\n  const m = f.match(/(\\d{8})/);\n  const date = m ? m[1] : 'nodate';\n  out.push({ f, date, target: `screenshots/${date}-${f.replace(/[^\\w.-]/g, '_')}` });\n}\nconsole.log(JSON.stringify(out, null, 2));" },
      "已写入 rename.js",
      "先写个 dry-run 脚本列出重命名计划。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "node rename.js ~/downloads | head -30" },
      "[ { f: 'screenshot (1).png', date: 'nodate', target: 'screenshots/nodate-screenshot__1_.png' },\n  { f: 'IMG_20260818_093012.png', date: '20260818', target: 'screenshots/20260818-IMG_20260818_093012.png' }, …]",
      "dry-run 结果：能从文件名提取日期的归入日期目录，提取不到的归 nodate。",
      opts));

    lines.push(userSay(gen, "u", "nodate 的太多，用文件修改时间兜底。", opts));
    lines.push(...toolTurn(gen, "a", "Edit",
      { file_path: "rename.js", old_string: "const m = f.match(/(\\d{8})/);\n  const date = m ? m[1] : 'nodate';", new_string: "const m = f.match(/(\\d{8})/);\n  const stat = fs.statSync(path.join(dir, f));\n  const fallback = new Date(stat.mtime).toISOString().slice(0, 10).replace(/-/g, '');\n  const date = m ? m[1] : fallback;" },
      "已应用修改 rename.js",
      "提取不到日期时改用 mtime 兜底。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "node rename.js ~/downloads > plan.json && node -e \"const p=require('./plan.json');console.log('计划',p.length,'个，日期覆盖',new Set(p.map(x=>x.date)).size,'天')\"" },
      "计划 47 个，日期覆盖 6 天",
      "重新生成计划：47 个文件，6 个日期桶。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "node -e \"\nconst fs=require('fs');\nconst plan=require('./plan.json');\nfor(const x of plan){fs.mkdirSync(path.dirname(x.target),{recursive:true});fs.renameSync(path.join(fs.homeDir||'~/downloads'.replace('~',process.env.HOME),x.f),x.target)}\n\"" },
      "已移动 47 个文件",
      "执行实际移动（骨架脚本）。",
      opts));

    lines.push(...toolTurn(gen, "a", "Bash",
      { command: "find screenshots -type f | wc -l && du -sh screenshots" },
      "47\n12M",
      "归档确认：47 文件全到位。",
      opts));

    lines.push(aiText(gen, "a", "整理完成：`~/downloads` 47 张截图已按日期归档到 `docs/screenshots/<日期>/`，命名统一为 `日期-原名`。脚本 rename.js 留在仓库里，以后下载文件夹再乱可以直接复用。", opts));
    return lines;
  }

  return [
    { _file: "示例-01 资产侦查.jsonl", lines: s1() },
    { _file: "示例-02 调试工具调用.jsonl", lines: s2() },
    { _file: "示例-03 会话文件解析.jsonl", lines: s3() },
    { _file: "示例-04 线上502排障.jsonl", lines: s4() },
    { _file: "示例-05 批量归档截图.jsonl", lines: s5() },
  ];
})();

window.SAMPLE_SESSIONS = SAMPLE_SESSIONS;
