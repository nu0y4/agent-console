/* ============================================================
   Agent Console — local backend (zero-dependency Node server)

   Provides:
     GET  /                     → static frontend (index.html, js/, css/)
     GET  /api/config           → { sessionDir, sessionId, zcodeDir, dshDir, …Available }
     POST /api/config           → body { sessionDir, sessionId, zcodeDir, dshDir }
     GET  /api/sessions?source= → session list; source is a CSV of
                                  "claude"   files under sessionDir
                                  "zcode"    rows in the zcode SQLite DB
                                  "dsh"      DeepSeek Harness zstd sessions
                                  No source param → claude only (legacy default).
     GET  /api/sessions/raw?file=<path|zcode::<id>|dsh::<id>>  → source text
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Worker } = require("worker_threads");
const { parse: parseSession } = require("./js/parser.js");

// zcode lives in SQLite and needs Node >= 22.5; on older runtimes the module
// still loads and simply reports "unavailable" instead of taking the server down
let zcode = null;
try { zcode = require("./js/zcode.js"); } catch (e) { zcode = null; }

// dsh stores append-only multi-frame zstd. This module decompresses each session
// once into a plain Claude-shaped .jsonl sidecar (see the header of js/dsh.js for
// why the sidecar exists and why we can't just use zlib's one-shot API).
let dsh = null;
try { dsh = require("./js/dsh.js"); } catch (e) { dsh = null; }

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, "config.json");
const DEFAULT_SESSION_DIR = "C:\\Users\\sorye\\.claude\\projects";
const DEFAULT_ZCODE_DIR = "C:\\Users\\sorye\\.zcode\\cli";
const DEFAULT_DSH_DIR = "C:\\Users\\sorye\\.dsh";
// Sidecars land outside the repo's data (they run to hundreds of MB) but inside
// the project so they're easy to find and delete. Gitignored.
const DSH_CACHE_DIR = path.join(ROOT, ".dsh-cache");
const PORT = process.env.PORT || 8123;
const HOST = "127.0.0.1";

/* ---------- config ---------- */
const DEFAULT_CONFIG = {
  sessionDir: DEFAULT_SESSION_DIR, sessionId: "",
  zcodeDir: DEFAULT_ZCODE_DIR, dshDir: DEFAULT_DSH_DIR,
};
// Every request used to re-read and re-parse this file; it only ever changes
// when this server writes it, so keep it in memory and invalidate on write.
let configCache = null;

function readConfig() {
  if (configCache) return configCache;
  let cfg = DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    cfg = {
      sessionDir: typeof parsed.sessionDir === "string" && parsed.sessionDir ? parsed.sessionDir : DEFAULT_SESSION_DIR,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
      zcodeDir: typeof parsed.zcodeDir === "string" && parsed.zcodeDir ? parsed.zcodeDir : DEFAULT_ZCODE_DIR,
      dshDir: typeof parsed.dshDir === "string" && parsed.dshDir ? parsed.dshDir : DEFAULT_DSH_DIR,
    };
  } catch (e) {
    // no config yet, or unreadable — fall back to the defaults
  }
  configCache = cfg;
  return cfg;
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
  configCache = cfg;
}

/* ---------- session stats index ----------
   A session's message counts can only be had by parsing the whole file, and the
   largest transcript here is 116 MB — ~480 ms of CPU per file, 548 MB of files
   in total. So the counts are computed once, off-thread (js/stats-worker.js),
   and persisted beside the config: the *next* start shows every count instantly
   instead of re-parsing the lot. Without this the sidebar's "N 条" column would
   only ever fill in as you clicked each session.

   An entry is only trusted while the file's mtime+size still match, so an edited
   session is recounted automatically. */
const INDEX_FILE = path.join(ROOT, "session-index.json");
const WORKER_FILE = path.join(ROOT, "js", "stats-worker.js");
const statsIndex = new Map();   // absolute file path -> { mtime, size, stats }
const queuedFiles = new Set();  // paths handed to the worker, so one file is never enqueued twice
let statsWorker = null;         // non-null while a warm-up pass is running
let indexDirty = false;
let saveTimer = null;

// A session Claude Code is writing right now bumps its mtime every few seconds.
// Counting it would re-parse a possibly-116 MB file on every poll and never
// settle — so leave live files alone until they stop changing. They show "· …"
// in the sidebar until then, which is honest.
const LIVE_FILE_GRACE_MS = 30000;

function loadIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    for (const [file, entry] of Object.entries(parsed || {})) {
      if (entry && typeof entry === "object") statsIndex.set(file, entry);
    }
  } catch (e) {
    // no cache yet (first run) or unreadable — a miss just means we recount
  }
}

// The worker reports a batch every few files, so writing the index on each one
// would rewrite the whole file dozens of times per pass.
function saveIndexSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!indexDirty) return;
    indexDirty = false;
    try {
      // Write-then-rename so a crash mid-write can't leave a truncated index
      // behind — a corrupt file would silently reset every count on next start.
      const tmp = INDEX_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(statsIndex)), "utf8");
      fs.renameSync(tmp, INDEX_FILE);
    } catch (e) {}
  }, 500);
}

/* Cached stats for a scan record, or null when it still needs counting.
   An entry whose stats are null means "we tried and the file was unreadable" —
   it still counts as settled, so a bad file can't spin the worker forever. */
function indexedStats(rec) {
  const e = statsIndex.get(rec.file);
  if (e && e.mtime === rec.mtime && e.size === rec.size) return e;
  return null;
}

/* Queue every uncounted file for the background pass. Smallest first, so the
   sidebar fills in fast and the handful of 100 MB+ transcripts are counted last
   — by which point the user is already reading something. */
function warmStats(records) {
  const now = Date.now();
  const need = [];
  for (const r of records) {
    if (indexedStats(r)) continue;               // already counted
    if (queuedFiles.has(r.file)) continue;       // already in flight
    if (now - r.mtime < LIVE_FILE_GRACE_MS) continue;  // still being written
    need.push({ file: r.file, mtime: r.mtime, size: r.size });
  }
  if (!need.length) return;
  if (statsWorker) return;   // one pass at a time; the next scan re-checks
  need.sort((a, b) => a.size - b.size);   // smallest first: sidebar fills fast
  spawnWorker(need, []);
}

/* dsh needs a different job: its stats can't be read off the source file, the
   sidecar has to be built (frame-by-frame zstd walk) first. We tell the worker
   how many source bytes it already consumed so a session that merely grew only
   pays for the new frames. */
function warmDshStats(cfg, records) {
  if (statsWorker || !dsh || !records.length) return;
  const now = Date.now();
  const jobs = [];
  for (const r of records) {
    if (indexedStats(r)) continue;
    if (queuedFiles.has(r.file)) continue;
    if (now - r.mtime < LIVE_FILE_GRACE_MS) continue;
    const src = dsh.srcOf(cfg.dshDir, r.name);
    if (!src) continue;
    const prev = statsIndex.get(r.file);
    const sameSrc = prev && prev.src === src;
    jobs.push({
      kind: "dsh",
      id: r.name,
      src,
      sidecar: dsh.cachePathFor(DSH_CACHE_DIR, r.name),
      fromOffset: sameSrc ? (prev.srcOffset || 0) : 0,
      mtime: r.mtime,
      size: r.size,
      key: r.file,
    });
  }
  if (!jobs.length) return;
  jobs.sort((a, b) => a.size - b.size);
  spawnWorker([], jobs);
}

function spawnWorker(fileJobs, dshJobs) {
  if (!fileJobs.length && !dshJobs.length) return;
  try {
    statsWorker = new Worker(WORKER_FILE, { workerData: { files: fileJobs, dshJobs } });
  } catch (e) {
    statsWorker = null;   // worker_threads unavailable — counts stay blank
    return;
  }
  for (const n of fileJobs) queuedFiles.add(n.file);
  for (const j of dshJobs) queuedFiles.add(j.key);
  statsWorker.unref();    // never hold the process open on its own
  statsWorker.on("message", (msg) => {
    if (!msg) return;
    if (msg.batch) {
      for (const it of msg.batch) {
        statsIndex.set(it.file, { mtime: it.mtime, size: it.size, stats: it.stats });
        queuedFiles.delete(it.file);
      }
      indexDirty = true;
      saveIndexSoon();
    }
    if (msg.dshBatch) {
      for (const it of msg.dshBatch) {
        // keep srcOffset/outLength so the next pass appends instead of rebuilding
        statsIndex.set(it.key, {
          mtime: it.mtime, size: it.size, stats: it.stats,
          src: (dshJobs.find((j) => j.key === it.key) || {}).src,
          srcOffset: it.srcOffset, outLength: it.outLength,
        });
        queuedFiles.delete(it.key);
      }
      indexDirty = true;
      saveIndexSoon();
    }
  });
  statsWorker.on("exit", () => {
    statsWorker = null;
    // Anything the worker never reported (it died early) goes back in the queue
    // on the next scan; anything it did report is already in statsIndex.
    queuedFiles.clear();
    saveIndexSoon();
  });
  statsWorker.on("error", () => {
    try { if (statsWorker) statsWorker.terminate(); } catch (e) {}
    statsWorker = null;
    queuedFiles.clear();
  });
}

/* Drop entries for claude files that no longer exist. Scoped to the claude dir
   on purpose: this index is shared by all three backends, and pruning "anything
   not in this scan" would wipe every dsh:: and zcode:: entry on each request
   (which is exactly what an unscoped version did). */
function pruneIndex(records, dir) {
  if (!statsIndex.size || !records.length || !dir) return;
  const prefix = path.normalize(dir) + path.sep;
  const live = new Set(records.map((r) => r.file));
  let removed = false;
  for (const file of Array.from(statsIndex.keys())) {
    if (!file.startsWith(prefix)) continue;   // another backend's row — leave it
    if (!live.has(file)) { statsIndex.delete(file); removed = true; }
  }
  if (removed) { indexDirty = true; saveIndexSoon(); }
}

/* ripgrep over the session folder, async.
   This used to be spawnSync, which froze the entire server — every other
   request, and any stats warm-up — for as long as the scan took (up to the
   15 s timeout) across 548 MB of transcripts. */
function runRipgrep(query, dir) {
  return new Promise((resolve) => {
    let rg;
    try {
      // -l list files, -i case-insensitive, -a treat all as text
      rg = spawn("rg", ["-l", "-i", "-a", "--no-messages", query, dir], { windowsHide: true });
    } catch (e) {
      return resolve([]);
    }
    let out = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(out.split("\n").map((s) => s.trim()).filter(Boolean));
    };
    const timer = setTimeout(() => { try { rg.kill(); } catch (e) {} finish(); }, 15000);
    rg.stdout.on("data", (c) => { if (out.length < 8 * 1024 * 1024) out += c; });
    // rg missing from PATH surfaces here, not as a throw
    rg.on("error", () => { clearTimeout(timer); finish(); });
    rg.on("close", () => { clearTimeout(timer); finish(); });
  });
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
function formatSessionTxt(parsed, name, source) {
  const fmtT = (t) => {
    const d = new Date(t);
    if (isNaN(d)) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const lines = [];
  lines.push(`===== 会话：${parsed.title} =====`);
  if (parsed.sessionId) lines.push(`sessionId: ${parsed.sessionId}`);
  lines.push(`来源：${source === "zcode" ? "zcode" : source === "dsh" ? "dsh" : "Claude Code"}`);
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
        let mtime = 0, size = 0;
        // size is free here (same stat) and it's what the stats index keys on,
        // alongside mtime, to decide whether a cached count is still valid
        try { const st = fs.statSync(p); mtime = st.mtimeMs; size = st.size; } catch (e) {}
        // Claude Code names the file by session UUID (dir name may be a prefix folder)
        const sessionId = ent.name.replace(/\.(jsonl|ndjson)$/i, "");
        const rel = path.relative(dir, d);
        // group by the top-level folder under the config dir
        let folder = "";
        if (rel && rel !== ".") {
          folder = rel.split(path.sep)[0];
        }
        out.push({
          sessionId, file: p, name: ent.name, mtime, size, folder,
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
  return out.map((s) => ({ ...s, source: "claude", deletable: true }));
}

/* ---------- multi-source session list ---------- */
const ALL_SOURCES = ["claude", "zcode", "dsh"];

/* Parse ?source=claude,zcode,dsh. Absent/empty → claude only, so the bare
   endpoint keeps the contract it had before zcode existed (skill doc, scripts). */
function parseSourcesParam(url) {
  const raw = url.searchParams.get("source");
  if (raw == null || raw.trim() === "") return new Set(["claude"]);
  const want = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const set = new Set(want.filter((s) => ALL_SOURCES.includes(s)));
  return set.size ? set : new Set(["claude"]);
}

/* Merge the three backends and order them as one timeline, so a recent zcode or
   dsh session doesn't sink below every claude one.  Tie-break on mtime then file
   keeps the order stable across the 8s poll, which matters because the
   frontend diffs this list. */
function listSessions(cfg, sources) {
  let claude = [];
  if (sources.has("claude")) {
    try { claude = scanSessions(cfg.sessionDir); } catch (e) { claude = []; }
    pruneIndex(claude, cfg.sessionDir);
  }

  // Counts come from the persisted index; anything missing is queued for the
  // worker and reported as `statsPending` so the frontend can show progress
  // instead of silently displaying nothing.
  warmStats(claude);
  let statsPending = 0;
  for (const s of claude) {
    const e = indexedStats(s);
    s.stats = e ? e.stats : null;
    if (!e) statsPending++;
  }

  // zcode is a live third-party DB — a lock or a bad path must never take the
  // claude list down with it.
  // Availability is probed even when zcode was NOT requested: the frontend uses
  // it to grey out the switch, so reporting "unavailable" merely because the
  // caller filtered the source out would strand the user with a switch that can
  // never be turned back on. Probing is a cached handle + `SELECT 1`.
  let zc = [];
  let zcodeAvailable = false;
  let zcodeError = "";
  if (zcode) {
    try {
      zcodeAvailable = !!zcode.zcodeAvailable(cfg.zcodeDir);
      if (!zcodeAvailable) zcodeError = "zcode 数据库不可用：" + cfg.zcodeDir;
      else if (sources.has("zcode")) zc = zcode.listZcodeSessions(cfg.zcodeDir);
    } catch (e) {
      zcodeAvailable = false;
      zcodeError = String((e && e.message) || e);
    }
  }

  // dsh: listing is cheap (bounded head/tail reads, memoised on size+mtime).
  // Counts come from the same persisted index as claude, keyed on the sidecar —
  // see the dsh branch of warmStats().
  let dc = [];
  let dshAvailable = false;
  let dshError = "";
  if (dsh) {
    try {
      dshAvailable = !!dsh.dshAvailable(cfg.dshDir);
      if (!dshAvailable) dshError = "dsh 会话目录不可用：" + cfg.dshDir;
      else if (sources.has("dsh")) dc = dsh.listDshSessions(cfg.dshDir);
    } catch (e) {
      dshAvailable = false;
      dshError = String((e && e.message) || e);
    }
  }
  warmDshStats(cfg, dc);
  for (const s of dc) {
    const e = indexedStats(s);
    s.stats = e ? e.stats : null;
    if (!e) statsPending++;
  }

  const out = claude.concat(zc, dc);
  const key = (s) => (s.lastTs ? Date.parse(s.lastTs) : s.mtime) || 0;
  out.sort((a, b) => (key(b) - key(a)) || ((b.mtime || 0) - (a.mtime || 0)) ||
    String(a.file).localeCompare(String(b.file)));
  return { sessions: out, zcodeAvailable, zcodeError, dshAvailable, dshError, statsPending };
}

/* Route a `file` token to its backend.  The token branches MUST come first:
   resolveSessionFile() would reject them as "outside dir" / "not a session file"
   before any backend logic could run. */
function resolveSource(raw) {
  if (!raw) return { ok: false, error: "missing file" };
  if (zcode && zcode.isZcodeToken(raw)) {
    const id = zcode.zcodeIdFromToken(raw);
    if (!id) return { ok: false, error: "bad zcode id" };
    return { ok: true, kind: "zcode", id, source: "zcode" };
  }
  if (dsh && dsh.isDshToken(raw)) {
    const id = dsh.dshIdFromToken(raw);
    if (!id) return { ok: false, error: "bad dsh id" };
    return { ok: true, kind: "dsh", id, source: "dsh" };
  }
  const r = resolveSessionFile(raw);
  return r.ok ? { ok: true, kind: "file", path: r.file, source: "claude" } : r;
}

/* Read any backend as text. Both bridges hand back Claude Code–shaped JSONL, so
   downstream parsing/export is identical across all three sources. */
function readSourceText(cfg, src) {
  if (src.kind === "zcode") {
    if (!zcode) throw new Error("zcode support unavailable (Node >= 22.5 required)");
    const text = zcode.readZcodeRaw(cfg.zcodeDir, src.id);
    if (text == null) throw new Error("zcode session not found");
    return text;
  }
  if (src.kind === "dsh") {
    if (!dsh) throw new Error("dsh support unavailable");
    const text = dsh.readDshRaw(cfg.dshDir, DSH_CACHE_DIR, src.id, statsIndex);
    if (text == null) throw new Error("dsh session not found");
    return text;
  }
  return fs.readFileSync(src.path, "utf8");
}

/* The sidecar for a dsh session, built if necessary — a real file, so the raw
   endpoint can stream it exactly like a claude .jsonl. */
function dshSidecarPath(cfg, id) {
  if (!dsh) return null;
  const rec = (dsh.scanDsh(cfg.dshDir) || []).find((r) => r.id === id);
  if (!rec) return null;
  return dsh.ensureSidecar(rec, DSH_CACHE_DIR, statsIndex);
}

function sourceDisplayName(cfg, src) {
  if (src.kind === "zcode") return src.id;
  if (src.kind === "dsh") return src.id;
  return path.basename(src.path);
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const p = url.pathname;

  try {
    /* --- config --- */
    if (p === "/api/config") {
      if (req.method === "GET") {
        const cfg = readConfig();
        let available = false, dshOk = false;
        try { available = !!(zcode && zcode.zcodeAvailable(cfg.zcodeDir)); } catch (e) {}
        try { dshOk = !!(dsh && dsh.dshAvailable(cfg.dshDir)); } catch (e) {}
        return sendJson(res, 200, { ...cfg, zcodeAvailable: available, dshAvailable: dshOk });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        let next = {};
        try { next = JSON.parse(body); } catch (e) { return sendJson(res, 400, { error: "bad json" }); }
        const cfg = readConfig();
        if (typeof next.sessionDir === "string") cfg.sessionDir = next.sessionDir.trim() || DEFAULT_SESSION_DIR;
        if (typeof next.sessionId === "string") cfg.sessionId = next.sessionId.trim();
        if (typeof next.zcodeDir === "string") cfg.zcodeDir = next.zcodeDir.trim() || DEFAULT_ZCODE_DIR;
        if (typeof next.dshDir === "string") cfg.dshDir = next.dshDir.trim() || DEFAULT_DSH_DIR;
        writeConfig(cfg);
        let available = false, dshOk = false;
        try { available = !!(zcode && zcode.zcodeAvailable(cfg.zcodeDir)); } catch (e) {}
        try { dshOk = !!(dsh && dsh.dshAvailable(cfg.dshDir)); } catch (e) {}
        return sendJson(res, 200, { ...cfg, zcodeAvailable: available, dshAvailable: dshOk });
      }
      return sendJson(res, 405, { error: "method" });
    }

    /* --- sessions list --- */
    if (p === "/api/sessions" && req.method === "GET") {
      const cfg = readConfig();
      const sources = parseSourcesParam(url);
      const { sessions, zcodeAvailable, zcodeError, dshAvailable, dshError, statsPending } = listSessions(cfg, sources);
      return sendJson(res, 200, {
        sessionDir: cfg.sessionDir,
        zcodeDir: cfg.zcodeDir,
        dshDir: cfg.dshDir,
        sources: Array.from(sources),
        zcodeAvailable,
        zcodeError,
        dshAvailable,
        dshError,
        count: sessions.length,
        statsPending,
        sessions,
      });
    }

    /* --- delete a session file --- */
    if (p === "/api/sessions" && req.method === "DELETE") {
      const file = url.searchParams.get("file");
      if (!file) return sendJson(res, 400, { error: "missing file" });
      // zcode sessions belong to the zcode app's own database — this server is
      // a read-only observer of it, so refuse rather than write into a live
      // third-party DB
      if (zcode && zcode.isZcodeToken(file)) {
        return sendJson(res, 400, { error: "zcode 会话为只读，请在 zcode 应用中删除" });
      }
      const cfg = readConfig();
      const dir = path.normalize(cfg.sessionDir);
      const target = path.normalize(file);
      if (target !== dir && !target.startsWith(dir + path.sep)) return sendJson(res, 403, { error: "outside dir" });
      if (!/\.(jsonl|ndjson)$/i.test(target)) return sendJson(res, 403, { error: "not a session file" });
      try {
        fs.unlinkSync(target);
        // drop its cached counts too, or a later scan would prune it anyway
        if (statsIndex.delete(target)) { indexDirty = true; saveIndexSoon(); }
        return sendJson(res, 200, { ok: true, file });
      } catch (e) {
        return sendJson(res, 404, { error: "not found" });
      }
    }

    /* --- raw file --- */
    if (p === "/api/sessions/raw") {
      const file = url.searchParams.get("file");
      if (!file) return sendJson(res, 400, { error: "missing file" });
      const r = resolveSource(file);
      if (!r.ok) return sendJson(res, 403, { error: r.error });
      const cfg = readConfig();
      // zcode is synthesized in memory, so it has no file to stream
      if (r.kind === "zcode") {
        try {
          const text = readSourceText(cfg, r);
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          return res.end(text);
        } catch (e) {
          return sendJson(res, 404, { error: String(e && e.message || e) });
        }
      }
      // dsh resolves to its sidecar — a real .jsonl on disk, so it streams below
      // like any claude session (building it here first if this is a first read)
      let srcPath = r.path;
      if (r.kind === "dsh") {
        try {
          srcPath = dshSidecarPath(cfg, r.id);
        } catch (e) {
          return sendJson(res, 500, { error: String(e && e.message || e) });
        }
        if (!srcPath) return sendJson(res, 404, { error: "dsh session not found" });
      }
      // Stream it: these files run to 116 MB, and readFileSync buffered the whole
      // thing as a string before res.end buffered it again. Content-Length also
      // lets the browser show progress rather than appear to hang.
      let size = 0;
      try { size = fs.statSync(srcPath).size; } catch (e) {}
      const headers = { "Content-Type": "text/plain; charset=utf-8" };
      if (size) headers["Content-Length"] = String(size);
      res.writeHead(200, headers);
      const stream = fs.createReadStream(srcPath);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return;
    }

    /* --- search via ripgrep (claude) + SQLite LIKE (zcode) --- */
    if (p === "/api/search") {
      const q = url.searchParams.get("q");
      if (!q) return sendJson(res, 400, { error: "missing q" });
      const cfg = readConfig();
      const sources = parseSourcesParam(url);
      let hits = [];

      if (sources.has("claude")) {
        const dir = cfg.sessionDir;
        const out = await runRipgrep(q, dir);
        // map back to scan entries so the frontend has titles/folders
        const entries = scanSessions(dir);
        const byFile = new Map(entries.map((e) => [e.file, e]));
        hits = hits.concat(out.map((file) => byFile.get(file) || {
          file, name: path.basename(file),
          sessionId: path.basename(file).replace(/\.jsonl$/i, ""),
          folder: "", title: path.basename(file), mtime: 0,
          source: "claude", deletable: true,
        }));
      }

      if (sources.has("zcode") && zcode) {
        try { hits = hits.concat(zcode.zcodeSearch(cfg.zcodeDir, q, 200)); } catch (e) {}
      }

      // dsh searches its sidecars rather than the .zstd sources — decompressing
      // ~320 MB of frames to answer one query is not viable. So this covers the
      // sessions that have already been opened (or counted) at least once;
      // anything else starts matching after its first read.
      if (sources.has("dsh") && dsh) {
        try { hits = hits.concat(dsh.dshSearch(DSH_CACHE_DIR, q, 200)); } catch (e) {}
      }

      hits.sort((a, b) => ((b.mtime || 0) - (a.mtime || 0)) ||
        String(a.file).localeCompare(String(b.file)));
      return sendJson(res, 200, { q, count: hits.length, sessions: hits });
    }

    /* --- parse: structured session content (messages/blocks/stats) --- */
    if (p === "/api/sessions/parse") {
      const r = resolveSource(url.searchParams.get("file"));
      if (!r.ok) return sendJson(res, 400, { error: r.error });
      const cfg = readConfig();
      try {
        const raw = readSourceText(cfg, r);
        const parsed = parseSession(raw, sourceDisplayName(cfg, r));
        return sendJson(res, 200, { ...parsed, source: r.source });
      } catch (e) {
        return sendJson(res, 500, { error: String(e && e.message || e) });
      }
    }

    /* --- export: session as plain text (same format as frontend export) --- */
    if (p === "/api/sessions/export") {
      const r = resolveSource(url.searchParams.get("file"));
      if (!r.ok) return sendJson(res, 400, { error: r.error });
      const cfg = readConfig();
      try {
        const name = sourceDisplayName(cfg, r);
        const raw = readSourceText(cfg, r);
        const parsed = parseSession(raw, name);
        const text = formatSessionTxt(parsed, name, r.source);
        const fname = name.replace(/\.(jsonl|ndjson)$/i, "") + ".txt";
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
      const sources = parseSourcesParam(url);
      let toolCalls = 0, aiMsgs = 0, userMsgs = 0, thinkingBlocks = 0, sessionCount = 0;
      let pending = 0;
      const byDay = {};

      if (sources.has("claude")) {
        const sessions = scanSessions(cfg.sessionDir);
        sessionCount += sessions.length;
        // Summed from the persisted index instead of re-reading and re-parsing
        // 548 MB of transcripts on the request thread (~10 s of frozen event
        // loop). A session the warm pass hasn't reached yet is reported as
        // pending rather than silently dropped from the totals.
        warmStats(sessions);
        for (const s of sessions) {
          if (s.lastTs) {
            const day = String(s.lastTs).slice(0, 10);
            byDay[day] = (byDay[day] || 0) + 1;
          }
          const e = indexedStats(s);
          if (!e) { pending++; continue; }
          if (!e.stats) continue;   // counted as attempted, but unreadable
          toolCalls += e.stats.tool || 0;
          aiMsgs += e.stats.ai || 0;
          userMsgs += e.stats.user || 0;
          thinkingBlocks += e.stats.thinking || 0;
        }
      }

      // zcode counts come from SQL aggregates — never synthesize+parse the whole
      // set just to total it up
      if (sources.has("zcode") && zcode) {
        try {
          const z = zcode.zcodeStats(cfg.zcodeDir);
          sessionCount += z.sessionCount;
          aiMsgs += z.aiMessages;
          userMsgs += z.userMessages;
          toolCalls += z.toolCalls;
          thinkingBlocks += z.thinkingBlocks;
          for (const [day, n] of Object.entries(z.sessionsByDay)) {
            byDay[day] = (byDay[day] || 0) + n;
          }
        } catch (e) {}
      }

      // dsh totals come from the same persisted index as claude (the worker
      // counts each sidecar as it builds it).
      if (sources.has("dsh") && dsh) {
        try {
          const sessions = dsh.listDshSessions(cfg.dshDir);
          sessionCount += sessions.length;
          warmDshStats(cfg, sessions);
          for (const s of sessions) {
            if (s.lastTs) {
              const day = String(s.lastTs).slice(0, 10);
              byDay[day] = (byDay[day] || 0) + 1;
            }
            const e = indexedStats(s);
            if (!e) { pending++; continue; }
            if (!e.stats) continue;
            toolCalls += e.stats.tool || 0;
            aiMsgs += e.stats.ai || 0;
            userMsgs += e.stats.user || 0;
            thinkingBlocks += e.stats.thinking || 0;
          }
        } catch (e) {}
      }

      return sendJson(res, 200, {
        sessionCount,
        messageCount: aiMsgs + userMsgs,
        aiMessages: aiMsgs,
        userMessages: userMsgs,
        toolCalls,
        thinkingBlocks,
        sessionsByDay: byDay,
        pendingStats: pending,
      });
    }

    /* --- API documentation --- */
    if (p === "/api") {
      return sendJson(res, 200, {
        name: "agent-console API",
        version: "1.0",
        base: `http://${HOST}:${PORT}`,
        endpoints: [
          { method: "GET", path: "/api/config", desc: "读取配置（会话文件夹 / zcode 数据目录）" },
          { method: "POST", path: "/api/config", desc: "保存配置", body: "{ sessionDir, sessionId, zcodeDir }" },
          { method: "GET", path: "/api/sessions", desc: "会话列表（按结束时间倒序）；含 size/stats，顶层 statsPending 表示统计未算完的条数", params: "source=claude,zcode,dsh（缺省 claude）" },
          { method: "GET", path: "/api/sessions/raw?file=", desc: "会话原文（流式返回，带 Content-Length）；zcode 写作 zcode::<id>、dsh 写作 dsh::<id>，两者都合成 Claude Code 同构 JSONL" },
          { method: "GET", path: "/api/sessions/parse?file=", desc: "结构化解析结果（messages/blocks/stats）" },
          { method: "GET", path: "/api/sessions/export?file=", desc: "导出会话为纯文本 txt" },
          { method: "DELETE", path: "/api/sessions?file=", desc: "删除会话文件（zcode 会话只读，返回 400）" },
          { method: "GET", path: "/api/search?q=", desc: "全文搜索（claude 走 ripgrep，zcode 走 SQLite LIKE，dsh 扫已解压的 sidecar）", params: "source=claude,zcode,dsh" },
          { method: "GET", path: "/api/stats", desc: "全局统计（消息/工具/按日分布）", params: "source=claude,zcode,dsh" },
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

loadIndex();

server.listen(PORT, HOST, () => {
  const cfg = readConfig();
  console.log(`[agent-console] serving http://${HOST}:${PORT}`);
  console.log(`[agent-console] session dir: ${cfg.sessionDir}`);
  console.log(`[agent-console] stats index:  ${statsIndex.size} session(s) cached`);
  let zc = "unavailable";
  if (zcode) {
    try { zc = zcode.zcodeAvailable(cfg.zcodeDir) ? cfg.zcodeDir : `not found (${cfg.zcodeDir})`; }
    catch (e) { zc = `error: ${e.message}`; }
  } else {
    zc = "module load failed (needs Node >= 22.5)";
  }
  console.log(`[agent-console] zcode dir:   ${zc}`);
  let dc = "unavailable";
  if (dsh) { try { dc = dsh.dshAvailable(cfg.dshDir) ? cfg.dshDir : `not found (${cfg.dshDir})`; } catch (e) { dc = "error: " + e.message; } }
  else dc = "module load failed";
  console.log(`[agent-console] dsh dir:     ${dc}`);
});
