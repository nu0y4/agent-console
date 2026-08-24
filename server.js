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
        });
      }
    }
  };
  walk(dir, 0);
  out.sort((a, b) => b.mtime - a.mtime);
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
    if (p === "/api/sessions") {
      const cfg = readConfig();
      const sessions = scanSessions(cfg.sessionDir);
      return sendJson(res, 200, { sessionDir: cfg.sessionDir, count: sessions.length, sessions });
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
