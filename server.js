/* ============================================================
   Agent Console — local backend (zero-dependency Node server)

   Provides:
     GET  /                     → static frontend (index.html, js/, css/)
     GET  /api/config           → { sessionDir, sessionId }
     POST /api/config           → body { sessionDir, sessionId }, persisted
     GET  /api/sessions         → recursive scan of sessionDir for *.jsonl
                                  { sessionId, file, mtime }
     GET  /api/sessions/raw?file=<abs path>  → raw file text (optional)
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { parse: parseSession } = require("./js/parser.js");

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, "config.json");
const DEFAULT_SESSION_DIR = "C:\\Users\\sorye\\.claude\\projects";
const PORT = process.env.PORT || 8123;
const HOST = "127.0.0.1";

/* ---------- config ---------- */
function readConfig() {
  const def = { sessionDir: DEFAULT_SESSION_DIR, sessionId: "" };
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      sessionDir: typeof parsed.sessionDir === "string" && parsed.sessionDir ? parsed.sessionDir : def.sessionDir,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
    };
  } catch (e) {
    return def;
  }
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

/* ---------- MIME ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/* ---------- helpers ---------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/* validate a session file path: inside configured dir, .jsonl, exists.
   Returns { ok, file?, error? } */
function resolveSessionFile(raw) {
  if (!raw) return { ok: false, error: "missing file" };
  const cfg = readConfig();
  const dir = path.normalize(cfg.sessionDir);
  const target = path.normalize(raw);
  if (target !== dir && !target.startsWith(dir + path.sep)) return { ok: false, error: "outside dir" };
  if (!/\.(jsonl|ndjson)$/i.test(target)) return { ok: false, error: "not a session file" };
  if (!fs.existsSync(target)) return { ok: false, error: "not found" };
  return { ok: true, file: target };
}

/* format a parsed session as plain text (mirrors the frontend export) */
function formatSessionTxt(parsed, name) {
  const fmtT = (t) => {
    const d = new Date(t);
    if (isNaN(d)) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const lines = [];
  lines.push(`===== 会话：${parsed.title} =====`);
  if (parsed.sessionId) lines.push(`sessionId: ${parsed.sessionId}`);
  lines.push(`文件：${(name || "").replace(/\.jsonl$/i, "")}`);
  lines.push("");
  for (const m of parsed.messages) {
    if (m.kind === "user") {
      lines.push(`[${fmtT(m.timestamp)}]用户：${m.text}`);
    } else if (m.kind === "assistant") {
      const parts = [];
      for (const b of (m.blocks || [])) {
        if (b.kind === "thinking" && b.text) parts.push(`<thinking>${b.text}</thinking>`);
        else if (b.kind === "text" && b.text) parts.push(b.text);
        else if (b.kind === "tool_use") {
          let input = "";
          try { input = JSON.stringify(b.input, null, 2); } catch (e) { input = String(b.input); }
          parts.push(`<tool>${b.name}${input ? "\n" + input : ""}</tool>`);
        }
      }
      if (parts.length) lines.push(`[${fmtT(m.timestamp)}]AI：${parts.join("\n")}`);
    }
  }
  return lines.join("\n");
}

/* read the head of a session file to extract a title (ai-title row, or the
   first user message). Cheap: only reads the first 64 KB. */
function sessionTitle(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.toString("utf8", 0, bytes);
    for (const line of head.split("\n")) {
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      if (o && o.type === "ai-title" && o.title) return o.title;
      if (o && o.type === "user" && o.message && typeof o.message.content === "string"
          && o.message.content.trim() && !o.isMeta) {
        return o.message.content.trim().slice(0, 60);
      }
    }
  } catch (e) {}
  return "";
}

/* read the tail of a session file to extract the LAST message timestamp —
   the session's true end time. Cheap: only reads the last 64 KB. */
function sessionLastTs(file) {
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const tail = buf.toString("utf8", 0, len);
    let last = null;
    for (const line of tail.split("\n")) {
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      if (o && typeof o.timestamp === "string" && o.timestamp) last = o.timestamp;
    }
    return last || "";
  } catch (e) {}
  return "";
}

/* recursively collect .jsonl files under a dir, newest first */
function scanSessions(dir) {
  const out = [];
  const walk = (d, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        // skip subagent transcripts; they belong to a parent session
        if (ent.name === "subagents") continue;
        if (depth < 6) walk(p, depth + 1); // bounded recursion
      } else if (ent.isFile() && /\.(jsonl|ndjson)$/i.test(ent.name)) {
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch (e) {}
        // Claude Code names the file by session UUID (dir name may be a prefix folder)
        const sessionId = ent.name.replace(/\.(jsonl|ndjson)$/i, "");
        const rel = path.relative(dir, d);
        // group by the top-level folder under the config dir
        let folder = "";
        if (rel && rel !== ".") {
          folder = rel.split(path.sep)[0];
        }
        out.push({
          sessionId, file: p, name: ent.name, mtime, folder,
          title: sessionTitle(p),
          lastTs: sessionLastTs(p),
        });
      }
    }
  };
  walk(dir, 0);
  // sort by session end time (lastTs) — mtime is only a fallback
  out.sort((a, b) => {
    const at = a.lastTs ? new Date(a.lastTs).getTime() : a.mtime;
    const bt = b.lastTs ? new Date(b.lastTs).getTime() : b.mtime;
    return bt - at;
  });
  return out;
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const p = url.pathname;

  try {
    /* --- config --- */
    if (p === "/api/config") {
      if (req.method === "GET") return sendJson(res, 200, readConfig());
      if (req.method === "POST") {
        const body = await readBody(req);
        let next = {};
        try { next = JSON.parse(body); } catch (e) { return sendJson(res, 400, { error: "bad json" }); }
        const cfg = readConfig();
        if (typeof next.sessionDir === "string") cfg.sessionDir = next.sessionDir.trim() || DEFAULT_SESSION_DIR;
        if (typeof next.sessionId === "string") cfg.sessionId = next.sessionId.trim();
        writeConfig(cfg);
        return sendJson(res, 200, cfg);
      }
      return sendJson(res, 405, { error: "method" });
    }

    /* --- sessions list --- */
    if (p === "/api/sessions" && req.method === "GET") {
      const cfg = readConfig();
      const sessions = scanSessions(cfg.sessionDir);
      return sendJson(res, 200, { sessionDir: cfg.sessionDir, count: sessions.length, sessions });
    }

    /* --- delete a session file --- */
    if (p === "/api/sessions" && req.method === "DELETE") {
      const file = url.searchParams.get("file");
      if (!file) return sendJson(res, 400, { error: "missing file" });
      const cfg = readConfig();
      const dir = path.normalize(cfg.sessionDir);
      const target = path.normalize(file);
      if (target !== dir && !target.startsWith(dir + path.sep)) return sendJson(res, 403, { error: "outside dir" });
      if (!/\.(jsonl|ndjson)$/i.test(target)) return sendJson(res, 403, { error: "not a session file" });
      try {
        fs.unlinkSync(target);
        return sendJson(res, 200, { ok: true, file });
      } catch (e) {
        return sendJson(res, 404, { error: "not found" });
      }
    }

    /* --- raw file --- */
    if (p === "/api/sessions/raw") {
      const file = url.searchParams.get("file");
      if (!file) return sendJson(res, 400, { error: "missing file" });
      const cfg = readConfig();
      const dir = path.normalize(cfg.sessionDir);
      const target = path.normalize(file);
      // stay inside the configured directory
      if (target !== dir && !target.startsWith(dir + path.sep)) return sendJson(res, 403, { error: "outside dir" });
      if (!/\.(jsonl|ndjson)$/i.test(target)) return sendJson(res, 403, { error: "not a session file" });
      try {
        const text = fs.readFileSync(target, "utf8");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(text);
      } catch (e) {
        return sendJson(res, 404, { error: "not found" });
      }
    }

    /* --- search via ripgrep (fast, handles all files at once) --- */
    if (p === "/api/search") {
      const q = url.searchParams.get("q");
      if (!q) return sendJson(res, 400, { error: "missing q" });
      const cfg = readConfig();
      const dir = cfg.sessionDir;
      const { spawnSync } = require("child_process");
      // -l list files, -i case-insensitive, -S smart case, -a treat all as text
      const rg = spawnSync("rg", ["-l", "-i", "-a", "--no-messages", q, dir], {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      const out = (rg.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
      // map back to scan entries so the frontend has titles/folders
      const entries = scanSessions(dir);
      const byFile = new Map(entries.map((e) => [e.file, e]));
      const hits = out
        .map((file) => {
          const e = byFile.get(file);
          return e || { file, name: path.basename(file), sessionId: path.basename(file).replace(/\.jsonl$/i, ""), folder: "", title: path.basename(file), mtime: 0 };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return sendJson(res, 200, { q, count: hits.length, sessions: hits });
    }

    /* --- parse: structured session content (messages/blocks/stats) --- */
    if (p === "/api/sessions/parse") {
      const r = resolveSessionFile(url.searchParams.get("file"));
      if (!r.ok) return sendJson(res, 400, { error: r.error });
      try {
        const raw = fs.readFileSync(r.file, "utf8");
        const parsed = parseSession(raw, path.basename(r.file));
        return sendJson(res, 200, parsed);
      } catch (e) {
        return sendJson(res, 500, { error: String(e && e.message || e) });
      }
    }

    /* --- export: session as plain text (same format as frontend export) --- */
    if (p === "/api/sessions/export") {
      const r = resolveSessionFile(url.searchParams.get("file"));
      if (!r.ok) return sendJson(res, 400, { error: r.error });
      try {
        const raw = fs.readFileSync(r.file, "utf8");
        const parsed = parseSession(raw, path.basename(r.file));
        const text = formatSessionTxt(parsed, path.basename(r.file));
        const fname = path.basename(r.file).replace(/\.(jsonl|ndjson)$/i, "") + ".txt";
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fname}"`,
        });
        return res.end(text);
      } catch (e) {
        return sendJson(res, 500, { error: String(e && e.message || e) });
      }
    }

    /* --- stats: global aggregates across all sessions --- */
    if (p === "/api/stats") {
      const cfg = readConfig();
      const sessions = scanSessions(cfg.sessionDir);
      let toolCalls = 0, aiMsgs = 0, userMsgs = 0, thinkingBlocks = 0;
      const byDay = {};
      for (const s of sessions) {
        if (!s.lastTs) continue;
        const day = String(s.lastTs).slice(0, 10);
        byDay[day] = (byDay[day] || 0) + 1;
        try {
          const raw = fs.readFileSync(s.file, "utf8");
          const parsed = parseSession(raw, s.name);
          toolCalls += parsed.stats.tool;
          aiMsgs += parsed.stats.ai;
          userMsgs += parsed.stats.user;
          thinkingBlocks += parsed.stats.thinking;
        } catch (e) {}
      }
      return sendJson(res, 200, {
        sessionCount: sessions.length,
        messageCount: aiMsgs + userMsgs,
        aiMessages: aiMsgs,
        userMessages: userMsgs,
        toolCalls,
        thinkingBlocks,
        sessionsByDay: byDay,
      });
    }

    /* --- API documentation --- */
    if (p === "/api") {
      return sendJson(res, 200, {
        name: "agent-console API",
        version: "1.0",
        base: `http://${HOST}:${PORT}`,
        endpoints: [
          { method: "GET", path: "/api/config", desc: "读取配置（会话文件夹）" },
          { method: "POST", path: "/api/config", desc: "保存配置", body: "{ sessionDir, sessionId }" },
          { method: "GET", path: "/api/sessions", desc: "会话列表（按结束时间倒序）", params: "" },
          { method: "GET", path: "/api/sessions/raw?file=", desc: "会话原文 jsonl" },
          { method: "GET", path: "/api/sessions/parse?file=", desc: "结构化解析结果（messages/blocks/stats）" },
          { method: "GET", path: "/api/sessions/export?file=", desc: "导出会话为纯文本 txt" },
          { method: "DELETE", path: "/api/sessions?file=", desc: "删除会话文件" },
          { method: "GET", path: "/api/search?q=", desc: "全文搜索（ripgrep）" },
          { method: "GET", path: "/api/stats", desc: "全局统计（消息/工具/按日分布）" },
          { method: "GET", path: "/api", desc: "本 API 文档" },
        ],
      });
    }

    /* --- static --- */
    let file = p === "/" ? "/index.html" : p;
    // prevent path traversal
    const abs = path.normalize(path.join(ROOT, file));
    if (!abs.startsWith(ROOT)) return sendJson(res, 403, { error: "forbidden" });
    fs.readFile(abs, (err, data) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      const ext = path.extname(abs).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
  } catch (err) {
    sendJson(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  const cfg = readConfig();
  console.log(`[agent-console] serving http://${HOST}:${PORT}`);
  console.log(`[agent-console] session dir: ${cfg.sessionDir}`);
});
