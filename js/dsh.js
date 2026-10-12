/* ============================================================
   dsh (DeepSeek Harness) source adapter — server-side only.

   Where the sessions live:
     <dshDir>/sessions/<编码后的 cwd>/<session-id>/session[.vN].jsonl.zstd

   Two things make this format awkward, both verified against the real data:

   1. The .jsonl.zstd files are NOT single zstd streams. They are APPEND-ONLY
      CONCATENATIONS of frames — each write appends another independent frame.
      The 20 MB session in this corpus holds 33,726 frames. Node's
      zlib.zstdDecompressSync does NOT walk concatenated frames; it silently
      returns after the FIRST one and drops the rest (verified with a synthetic
      two-frame file). So we split on the frame magic ourselves and decompress
      frame by frame.

   2. A single session produces ~54k rows, of which ~42k are streaming deltas
      (`assistant/chunk`, `reasoning-chunks`, `text-chunks`, `tool-call-chunks`).
      Those are redundant — `assistant/message` carries the fully assembled
      message. We keep only the assembled rows.

   Strategy (chosen over decompressing per request): decompress ONCE into a plain
   Claude Code–shaped .jsonl sidecar, then everything downstream — ripgrep
   search, parse, export, the stats worker — reuses the existing code paths
   untouched, exactly like the zcode bridge. Because frames are append-only, a
   session that grows only needs its NEW frames converted and appended; the
   sidecar is never rebuilt from scratch.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const DEFAULT_DSH_DIR = "C:\\Users\\sorye\\.dsh";
const SESSIONS_SUBDIR = "sessions";

// zstd frame magic, little-endian 0xFD2FB528
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/* ---------- paths ---------- */
function sessionsRoot(dshDir) {
  return path.join(dshDir || DEFAULT_DSH_DIR, SESSIONS_SUBDIR);
}

/* Filesystem-safe, reversible-ish name for a session id. dsh ids contain ':'
   (e.g. im:telegram_xxx:dm:123), which is illegal in Windows filenames. */
function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, (c) =>
    "~" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function cachePathFor(cacheDir, id) {
  return path.join(cacheDir, safeName(id) + ".jsonl");
}

/* ---------- frame handling ---------- */
/* Every offset where a frame starts. The odds of the 4-byte magic appearing by
   accident inside compressed (high-entropy) data are ~len/2^32 — for a 20 MB
   file that is ~0.005 expected false positives, so magic hits ARE frame starts. */
function frameOffsets(buf, from) {
  const out = [];
  let i = Math.max(0, from || 0);
  while (i + 4 <= buf.length) {
    const p = buf.indexOf(MAGIC, i);
    if (p < 0) break;
    out.push(p);
    i = p + 4;
  }
  return out;
}

/* Decompress every whole frame in [from, end). Returns the decoded text and the
   source offset of the first byte NOT consumed — a partial trailing frame (the
   writer was mid-append) is left for the next pass. */
function decodeFrom(srcBuf, from) {
  const starts = frameOffsets(srcBuf, from);
  if (!starts.length) return { text: "", consumed: from };
  const chunks = [];
  let consumed = from;
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    // a frame ends where the next one begins; the last one runs to EOF
    const e = k + 1 < starts.length ? starts[k + 1] : srcBuf.length;
    try {
      chunks.push(zlib.zstdDecompressSync(srcBuf.subarray(s, e)));
      consumed = e;
    } catch (err) {
      // truncated final frame — stop here, leave `consumed` at the last good frame
      break;
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), consumed };
}

/* ---------- dsh row → Claude Code row ----------
   Only the assembled rows are kept. Everything else (chunk deltas, request
   headers, compaction bookkeeping, sandbox/approval settings) is dropped. */
function convertRow(o, sessionId) {
  if (!o || typeof o !== "object") return null;
  const time = typeof o.time === "number" ? new Date(o.time).toISOString() : "";

  switch (o.type) {
    case "session/title": {
      const title = o.data && o.data.title;
      if (!title) return null;
      return { type: "ai-title", title, sessionId, timestamp: time };
    }
    case "user/message": {
      const content = (o.data && o.data.content) || [];
      const text = content
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text).join("\n").trim();
      if (!text) return null;
      return {
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
        timestamp: time,
        sessionId,
        uuid: (o.data && o.data.id) || "",
      };
    }
    case "assistant/message": {
      const msg = (o.data && o.data.message) || {};
      const blocks = [];
      for (const c of msg.content || []) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "reasoning" && c.text) {
          blocks.push({ type: "thinking", thinking: c.text });
        } else if (c.type === "text" && c.text) {
          blocks.push({ type: "text", text: c.text });
        } else if (c.type === "tool-call") {
          // `arguments` is a JSON *string*; the parser wants an object
          let input = null;
          try { input = JSON.parse(c.arguments); } catch (e) { input = c.arguments; }
          blocks.push({ type: "tool_use", id: c.id || "", name: c.name || "", input });
        }
      }
      if (!blocks.length) return null;
      return {
        type: "assistant",
        message: { role: "assistant", content: blocks },
        timestamp: time,
        sessionId,
        uuid: msg.id || "",
      };
    }
    case "tool/result": {
      // becomes a user row holding a tool_result block; parser.js attaches it to
      // the matching tool_use by tool_use_id, exactly as it does for Claude Code
      const msg = (o.data && o.data.message) || {};
      const tr = (msg.content || []).find((c) => c && c.type === "tool-result");
      if (!tr) return null;
      return {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: tr.toolCallId || (msg.source && msg.source.callId) || "",
            content: tr.content || "",
            is_error: !!tr.isError,
          }],
        },
        timestamp: time,
        sessionId,
        uuid: msg.id || "",
      };
    }
    default:
      return null;
  }
}

/* Convert a block of decoded JSONL text into Claude-shaped JSONL. */
function convertText(text, sessionId) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (e) { continue; }
    const row = convertRow(o, sessionId);
    if (row) out.push(JSON.stringify(row));
  }
  return out.length ? out.join("\n") + "\n" : "";
}

/* ---------- session discovery ---------- */
/* One session dir can hold several generations of the same session
   (session.jsonl.zstd, session.v3.jsonl.zstd, session.v4…). Prefer the highest
   version; the older files are the pre-migration copies. */
function pickVariant(files) {
  let best = null, bestV = -1;
  for (const name of files) {
    const m = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(name);
    if (!m) continue;
    const v = m[1] ? Number(m[1]) : 0;
    if (v > bestV) { bestV = v; best = name; }
  }
  return best;
}

/* Walk <dshDir>/sessions. One entry per session dir.
   Memoised briefly: one request routinely needs the scan three or four times
   (list → stats queue → sidecar lookup → raw), and each scan is a readdir +
   stat over 207 directories. */
const scanCache = new Map();
const SCAN_TTL_MS = 1500;

function scanDsh(dshDir) {
  const key = dshDir || DEFAULT_DSH_DIR;
  const hit = scanCache.get(key);
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.list;

  const root = sessionsRoot(dshDir);
  const out = [];
  let folders;
  try { folders = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }

  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const folderPath = path.join(root, folder.name);
    let sessionDirs;
    try { sessionDirs = fs.readdirSync(folderPath, { withFileTypes: true }); } catch (e) { continue; }
    for (const sd of sessionDirs) {
      if (!sd.isDirectory()) continue;
      const dirPath = path.join(folderPath, sd.name);
      let files;
      try { files = fs.readdirSync(dirPath); } catch (e) { continue; }
      const name = pickVariant(files);
      if (!name) continue;
      const src = path.join(dirPath, name);
      let st;
      try { st = fs.statSync(src); } catch (e) { continue; }
      out.push({ id: sd.name, dir: dirPath, src, mtime: st.mtimeMs, size: st.size });
    }
  }
  scanCache.set(key, { at: Date.now(), list: out });
  return out;
}

/* Source file for one session id (memoised scan behind it). */
function srcOf(dshDir, id) {
  const rec = scanDsh(dshDir).find((r) => r.id === id);
  return rec ? rec.src : null;
}

/* ---------- head/tail metadata (no sidecar needed) ---------- */
/* Only this much is read off each end. Reading the whole file to see its first
   frame made a 207-session listing a multi-second stall. */
const EDGE_BYTES = 128 * 1024;

function readRange(src, start, len) {
  let fd;
  try { fd = fs.openSync(src, "r"); } catch (e) { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, Math.min(start, size));
    const n = Math.max(0, Math.min(len, size - from));
    const buf = Buffer.alloc(n);
    if (n) fs.readSync(fd, buf, 0, n, from);
    return buf;
  } catch (e) {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch (e) {}
  }
}

/* Frame start offsets inside a buffer that begins at byte 0 of its own range. */
function edgeFrames(buf) {
  const starts = frameOffsets(buf, 0);
  return starts.map((s, k) => [s, k + 1 < starts.length ? starts[k + 1] : buf.length]);
}

function tryDecode(buf, s, e) {
  try { return zlib.zstdDecompressSync(buf.subarray(s, e)).toString("utf8"); }
  catch (err) { return null; }   // truncated final frame
}

/* Header + title from the head. Stops at the first frame that carries a title
   rather than decoding the whole window — an eager pass over 128 KB of small
   frames is hundreds of decompress calls per session. */
function readHead(src, id) {
  const head = { sessionId: id, cwd: "", createdAt: "" };
  const buf = readRange(src, 0, EDGE_BYTES);
  if (!buf) return head;
  const frames = edgeFrames(buf);
  const limit = Math.min(frames.length, 30);
  for (let k = 0; k < limit; k++) {
    const text = tryDecode(buf, frames[k][0], frames[k][1]);
    if (text == null) break;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch (err) { continue; }
      if (o.type === "session") {
        if (o.cwd) head.cwd = o.cwd;
        if (o.createdAt) head.createdAt = new Date(o.createdAt).toISOString();
        if (o.id) head.sessionId = o.id;
      } else if (o.type === "session/title" && o.data && o.data.title) {
        head.title = o.data.title;
      } else if (!head.firstUserText && o.type === "user/message") {
        const c = (o.data && o.data.content) || [];
        const t = c.filter((x) => x && x.type === "text").map((x) => x.text).join(" ");
        if (t.trim()) head.firstUserText = t.trim();
      }
    }
    if (head.title) break;
  }
  return head;
}

/* Session end time: walk the tail window's frames BACKWARDS and stop at the
   first one carrying a `time`. */
function readTailTime(src) {
  let size = 0;
  try { size = fs.statSync(src).size; } catch (e) { return ""; }
  const buf = readRange(src, Math.max(0, size - EDGE_BYTES), EDGE_BYTES);
  if (buf) {
    const frames = edgeFrames(buf);
    for (let k = frames.length - 1; k >= 0 && k >= frames.length - 8; k--) {
      const text = tryDecode(buf, frames[k][0], frames[k][1]);
      if (text == null) continue;
      let last = null;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try { const o = JSON.parse(line); if (typeof o.time === "number") last = o.time; } catch (e) {}
      }
      if (last != null) return new Date(last).toISOString();
    }
  }
  const head = readRange(src, 0, EDGE_BYTES);
  if (head) {
    const frames = edgeFrames(head);
    for (let k = 0; k < Math.min(frames.length, 8); k++) {
      const text = tryDecode(head, frames[k][0], frames[k][1]);
      if (text == null) break;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (typeof o.time === "number") return new Date(o.time).toISOString();
        } catch (e) {}
      }
    }
  }
  return "";
}

/* Head/tail metadata memo, keyed on the source path and revalidated on
   size+mtime. Without it every /api/sessions poll re-reads both ends of all 207
   sessions — the poll runs every 8 s and the sidebar only needs new sessions to
   show up, not a fresh decompress each time. */
const metaCache = new Map();

function metaFor(rec) {
  const hit = metaCache.get(rec.src);
  if (hit && hit.size === rec.size && hit.mtime === rec.mtime) return hit.meta;
  const meta = Object.assign(readHead(rec.src, rec.id), { lastTs: readTailTime(rec.src) });
  metaCache.set(rec.src, { size: rec.size, mtime: rec.mtime, meta });
  return meta;
}

/* ---------- sidecar ---------- */
/* index: id -> { src, srcOffset, outLength, mtime, size }  (persisted by caller) */
function ensureSidecar(rec, cacheDir, index) {
  const cacheFile = cachePathFor(cacheDir, rec.id);
  let st = 0;
  try { st = fs.statSync(cacheFile).size; } catch (e) { st = -1; }

  const entry = index.get(rec.id);
  const fresh = entry && entry.src === rec.src && entry.outLength === st && st >= 0;
  let from = fresh ? entry.srcOffset : 0;
  let outLength = fresh ? entry.outLength : 0;

  // source shrank or was rewritten → rebuild
  if (from > rec.size) { from = 0; outLength = 0; }
  if (!fresh && st >= 0) { try { fs.unlinkSync(cacheFile); } catch (e) {} }

  if (from >= rec.size) {
    index.set(rec.id, { src: rec.src, srcOffset: from, outLength, mtime: rec.mtime, size: rec.size });
    return cacheFile;
  }

  let buf;
  try { buf = fs.readFileSync(rec.src); } catch (e) { return null; }
  const { text, consumed } = decodeFrom(buf, from);
  const converted = convertText(text, rec.id);

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    if (converted) fs.appendFileSync(cacheFile, converted, "utf8");
    outLength += Buffer.byteLength(converted, "utf8");
  } catch (e) { return null; }

  index.set(rec.id, { src: rec.src, srcOffset: consumed, outLength, mtime: rec.mtime, size: rec.size });
  return cacheFile;
}

/* ---------- public API (mirrors js/zcode.js) ---------- */
function dshAvailable(dshDir) {
  try { return fs.statSync(sessionsRoot(dshDir)).isDirectory(); } catch (e) { return false; }
}

const TOKEN_RE = /^dsh::/;
const isDshToken = (raw) => typeof raw === "string" && TOKEN_RE.test(raw);
const dshIdFromToken = (raw) => (isDshToken(raw) ? raw.slice(5) : "");

/* List for the sidebar. Titles/times come from a cheap head+tail read, so this
   works before any sidecar has been built. */
function listDshSessions(dshDir) {
  const out = [];
  for (const rec of scanDsh(dshDir)) {
    const meta = metaFor(rec);
    const title = meta.title
      || (meta.firstUserText ? meta.firstUserText.slice(0, 60) : "");
    out.push({
      sessionId: meta.sessionId || rec.id,
      file: "dsh::" + rec.id,
      name: rec.id,
      mtime: rec.mtime,
      size: rec.size,
      folder: meta.cwd || "",
      title: title || rec.id,
      lastTs: meta.lastTs || meta.createdAt || "",
      source: "dsh",
      deletable: false,
      stats: null,
    });
  }
  return out;
}

/* Raw (Claude-shaped) text for one session. Builds/extends the sidecar first. */
function readDshRaw(dshDir, cacheDir, id, index) {
  const rec = scanDsh(dshDir).find((r) => r.id === id);
  if (!rec) return null;
  const cacheFile = ensureSidecar(rec, cacheDir, index);
  if (!cacheFile) return null;
  try { return fs.readFileSync(cacheFile, "utf8"); } catch (e) { return ""; }
}

/* Locate a session's source + sidecar without building anything. */
function findDsh(dshDir, id) {
  return scanDsh(dshDir).find((r) => r.id === id) || null;
}

/* Full-text search. Works on the sidecars (plain JSONL), same idea as ripgrep on
   the claude tree — but only over sessions that already have a sidecar, since
   building them all just to answer a query would be a 900 MB decompress. */
function dshSearch(cacheDir, needle, limit) {
  const hits = [];
  let files;
  try { files = fs.readdirSync(cacheDir); } catch (e) { return hits; }
  const q = String(needle).toLowerCase();
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    let text;
    try { text = fs.readFileSync(path.join(cacheDir, f), "utf8"); } catch (e) { continue; }
    if (text.toLowerCase().indexOf(q) >= 0) {
      let id = f.slice(0, -6);
      // undo safeName()
      id = id.replace(/~([0-9a-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
      hits.push({ file: "dsh::" + id, name: id, title: "", folder: "", mtime: 0, source: "dsh", deletable: false });
      if (hits.length >= (limit || 200)) break;
    }
  }
  return hits;
}

module.exports = {
  DEFAULT_DSH_DIR,
  dshAvailable,
  isDshToken,
  dshIdFromToken,
  listDshSessions,
  readDshRaw,
  findDsh,
  dshSearch,
  cachePathFor,
  ensureSidecar,
  scanDsh,
  srcOf,
  readHead,
  readTailTime,
  // exposed for the stats worker (it builds sidecars off-thread)
  decodeFrom,
  convertText,
};
