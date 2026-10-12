/* ============================================================
   zcode session reader — server-side adapter (zero-dependency)

   zcode keeps its sessions in SQLite, not in .jsonl files:
     <zcodeDir>/db/db.sqlite   tables: session / message / part

   Rather than teach the whole frontend a second format, we SYNTHESIZE
   Claude Code–shaped JSONL from the DB and hand it to the existing
   js/parser.js.  Everything downstream (parse, cache, render, turn rail,
   export, search) is then reused untouched.

   Read-only by contract: this module never writes to the database.
   It is served as a static asset too (/js/zcode.js), so it must stay
   browser-safe — the sqlite handle is required lazily and every entry
   point degrades to "unavailable" instead of throwing.
   ============================================================ */
const fs = require("fs");
const path = require("path");

/* ---------- sqlite handle (lazy: node:sqlite needs Node >= 22.5) ---------- */
let sqlite = null;
let sqliteChecked = false;

function loadSqlite() {
  if (sqliteChecked) return sqlite;
  sqliteChecked = true;
  try {
    // eslint-disable-next-line global-require
    sqlite = require("node:sqlite");
  } catch (e) {
    sqlite = null; // Node < 22.5 — zcode support simply stays off
  }
  return sqlite;
}

let conn = null;       // cached DatabaseSync
let connKey = "";      // resolved db path the handle belongs to

function dbPath(dir) {
  const nested = path.join(dir, "db", "db.sqlite");
  if (fs.existsSync(nested)) return nested;
  const flat = path.join(dir, "db.sqlite");
  if (fs.existsSync(flat)) return flat;
  return nested; // canonical location; open will fail → unavailable
}

function openDb(dir) {
  if (!dir) return null;
  const api = loadSqlite();
  if (!api) return null;
  const file = dbPath(dir);
  if (!fs.existsSync(file)) return null;
  if (conn && connKey === file) return conn;
  closeDb();

  let db = null;
  try {
    // read-only first: it cannot checkpoint the WAL, so we never write a
    // single byte into a database a running zcode instance owns.
    db = new api.DatabaseSync(file, { readOnly: true });
  } catch (e) {
    // fall back to a read-write handle that refuses writes at the SQL layer
    try {
      db = new api.DatabaseSync(file);
      db.exec("PRAGMA query_only = 1");
    } catch (e2) {
      return null;
    }
  }
  try { db.exec("PRAGMA busy_timeout = 2000"); } catch (e) {}
  conn = db;
  connKey = file;
  return conn;
}

function closeDb() {
  if (conn) {
    try { conn.close(); } catch (e) {}
  }
  conn = null;
  connKey = "";
}

function zcodeAvailable(dir) {
  const db = openDb(dir);
  if (!db) return false;
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------- token helpers: zcode sessions are addressed as zcode::<id> ---------- */
const TOKEN = "zcode::";
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function isZcodeToken(file) {
  return typeof file === "string" && file.startsWith(TOKEN);
}
function zcodeIdFromToken(file) {
  if (!isZcodeToken(file)) return "";
  const id = file.slice(TOKEN.length);
  return ID_RE.test(id) ? id : "";
}

/* ---------- small helpers ---------- */
function isoFromMs(ms) {
  const n = Number(ms);
  if (!n || !isFinite(n)) return "";
  const d = new Date(n);
  return isNaN(d) ? "" : d.toISOString();
}

// zcode stores `I:\实验室`; the sidebar renders forward-slash group labels
function normFolder(dir) {
  return String(dir || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function baseName(p) {
  const s = normFolder(p);
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

// json_extract() throws on malformed JSON, so always gate it behind json_valid()
function jx(col, jsonPath) {
  return `CASE WHEN json_valid(${col}) THEN json_extract(${col}, '${jsonPath}') END`;
}
const ROLE = jx("data", "$.role");
const ORIGIN = jx("data", "$.semantics.origin");
const VIS = jx("data", "$.semantics.uiVisibility");
const KIND = jx("data", "$.semantics.kind");
const PTYPE = jx("data", "$.type");
// runtime-injected rows (todo reminders, background notifications) are flagged
// hidden by zcode itself — the transcript should match what zcode shows
const VISIBLE = `COALESCE(${VIS}, 'visible') <> 'hidden'`;

/* ---------- session list ---------- */
/* Cheap by construction: titles/timestamps come straight from columns, counts
   come from two GROUP BY aggregates.  No per-message JSON parsing in Node. */
const LIST_TTL_MS = 2500;
let listCache = { key: "", at: 0, value: null };

function listZcodeSessions(dir) {
  const db = openDb(dir);
  if (!db) return [];

  let stamp = "";
  try {
    const r = db.prepare("SELECT MAX(time_updated) m FROM session").get();
    stamp = String(r && r.m);
  } catch (e) {
    return [];
  }
  const now = Date.now();
  if (listCache.key === connKey + "|" + stamp && now - listCache.at < LIST_TTL_MS && listCache.value) {
    return listCache.value;
  }

  let rows;
  try {
    rows = db.prepare(
      "SELECT id, title, directory, parent_id, task_type, time_created, time_updated " +
      "FROM session ORDER BY COALESCE(time_updated, time_created, 0) DESC"
    ).all();
  } catch (e) {
    return [];
  }

  // per-session counters, one grouped pass each
  const users = new Map();
  const parts = new Map();
  try {
    for (const r of db.prepare(
      `SELECT session_id sid, COUNT(*) n FROM message
       WHERE ${ROLE} = 'user' AND ${VISIBLE} GROUP BY session_id`
    ).all()) users.set(r.sid, Number(r.n));
  } catch (e) {}
  try {
    // assistant messages that will actually render as something
    for (const r of db.prepare(
      `SELECT p.sid sid,
              COUNT(DISTINCT CASE WHEN p.t IN ('text','reasoning','tool') THEN p.mid END) ai,
              SUM(CASE WHEN p.t = 'reasoning' THEN 1 ELSE 0 END) thinking,
              SUM(CASE WHEN p.t = 'tool' THEN 1 ELSE 0 END) tool
       FROM (SELECT p.session_id sid, p.message_id mid,
                    ${jx("p.data", "$.type")} t,
                    ${jx("m.data", "$.role")} r,
                    COALESCE(${jx("m.data", "$.semantics.uiVisibility")}, 'visible') v
             FROM part p JOIN message m ON m.id = p.message_id) p
       WHERE p.r = 'assistant' AND p.v <> 'hidden'
       GROUP BY p.sid`
    ).all()) {
      parts.set(r.sid, { ai: Number(r.ai) || 0, thinking: Number(r.thinking) || 0, tool: Number(r.tool) || 0 });
    }
  } catch (e) {}

  const out = rows.map((r) => {
    const ms = Number(r.time_updated) || Number(r.time_created) || 0;
    const p = parts.get(r.id) || { ai: 0, thinking: 0, tool: 0 };
    const user = users.get(r.id) || 0;
    const title = (r.title || "").trim() || baseName(r.directory) || r.id;
    return {
      sessionId: r.id,
      file: TOKEN + r.id,
      name: r.id,
      title: title.slice(0, 120),
      folder: normFolder(r.directory),
      directory: r.directory || "",
      mtime: ms,
      lastTs: isoFromMs(ms),
      source: "zcode",
      deletable: false,
      stats: {
        user,
        ai: p.ai,
        thinking: p.thinking,
        tool: p.tool,
        total: user + p.ai,
      },
    };
  });

  listCache = { key: connKey + "|" + stamp, at: now, value: out };
  return out;
}

/* ---------- the bridge: zcode rows → Claude Code–shaped JSONL ---------- */
const MAX_PART_CHARS = 256 * 1024; // a single tool output shouldn't melt the browser

function clip(s) {
  const text = typeof s === "string" ? s : (s == null ? "" : String(s));
  if (text.length <= MAX_PART_CHARS) return text;
  return text.slice(0, MAX_PART_CHARS) + `\n… [truncated ${text.length - MAX_PART_CHARS} chars]`;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

/* parts of one message → the assistant `content` block array.
   tool_use and its tool_result MUST land in the same array: parser.js keeps
   its pendingMap local to the assistant branch, so a separate row would not
   bind.  That same-array pairing is the whole trick. */
function partsToBlocks(partRows) {
  const blocks = [];
  for (const row of partRows) {
    const d = safeJson(row.data);
    if (!d) continue;
    const t = d.type;

    if (t === "reasoning") {
      if (d.text) {
        const sig = (d.metadata && d.metadata.anthropic && d.metadata.anthropic.signature) || "";
        blocks.push({ type: "thinking", thinking: d.text, signature: sig });
      }
    } else if (t === "text") {
      if (d.text) blocks.push({ type: "text", text: d.text });
    } else if (t === "tool") {
      const st = d.state || {};
      const callId = d.callID || "";
      blocks.push({ type: "tool_use", id: callId, name: d.tool || "tool", input: st.input != null ? st.input : null });
      // only emit a result once there is one — a pending tool rendered as an
      // empty error panel is worse than no panel at all
      if (st.output != null) {
        blocks.push({
          type: "tool_result",
          tool_use_id: callId,
          content: clip(st.output),
          is_error: st.status != null && st.status !== "completed",
        });
      }
    }
    // step-start / step-finish / file carry no transcript value
  }
  return blocks;
}

/* parts of one user message → plain text */
function partsToText(partRows) {
  const out = [];
  for (const row of partRows) {
    const d = safeJson(row.data);
    if (!d) continue;
    if (d.type === "text" && d.text) out.push(d.text);
    else if (d.type === "file" && (d.filename || d.url)) out.push(`[file] ${d.filename || d.url}`);
  }
  return out.join("\n").trim();
}

function synthesizeSession(db, sessionId) {
  const s = db.prepare(
    "SELECT id, title, directory, time_created, time_updated FROM session WHERE id = ?"
  ).get(sessionId);
  if (!s) return null;

  const msgs = db.prepare(
    `SELECT id, time_created, data FROM message
     WHERE session_id = ? AND ${VISIBLE}
     ORDER BY sequence`
  ).all(sessionId);

  const partsByMsg = new Map();
  const partRows = db.prepare(
    "SELECT message_id, data, sequence FROM part WHERE session_id = ? ORDER BY sequence"
  ).all(sessionId);
  for (const p of partRows) {
    if (!partsByMsg.has(p.message_id)) partsByMsg.set(p.message_id, []);
    partsByMsg.get(p.message_id).push(p);
  }

  const lines = [];
  lines.push(JSON.stringify({
    type: "ai-title",
    title: (s.title || "").trim() || baseName(s.directory) || s.id,
    sessionId: s.id,
  }));

  for (const m of msgs) {
    const md = safeJson(m.data) || {};
    const role = md.role;
    const parts = partsByMsg.get(m.id) || [];
    const ts = isoFromMs((md.time && md.time.created) || m.time_created);
    const cwd = (md.path && md.path.cwd) || s.directory || "";

    if (role === "user") {
      const text = partsToText(parts);
      if (!text) continue;
      lines.push(JSON.stringify({
        type: "user",
        timestamp: ts,
        sessionId: s.id,
        uuid: m.id,
        cwd,
        message: { role: "user", content: [{ type: "text", text: clip(text) }] },
      }));
      continue;
    }

    if (role === "assistant") {
      const blocks = partsToBlocks(parts);
      if (!blocks.length) continue;
      lines.push(JSON.stringify({
        type: "assistant",
        timestamp: ts,
        sessionId: s.id,
        uuid: m.id,
        cwd,
        message: { role: "assistant", content: blocks },
      }));
    }
  }

  return { text: lines.join("\n"), title: lines.length > 1 ? (s.title || "") : "" };
}

function readZcodeRaw(dir, sessionId) {
  const db = openDb(dir);
  if (!db || !sessionId) return null;
  try {
    const r = synthesizeSession(db, sessionId);
    return r ? r.text : null;
  } catch (e) {
    return null;
  }
}

/* ---------- search ---------- */
/* SQLite LIKE is case-insensitive for ASCII only; the payload here is mostly
   CJK, where case folding is moot.  Non-ASCII case parity would need FTS5 —
   not worth the index for ~6k rows. */
function likePattern(q) {
  // match against the JSON-escaped form too, so a query containing " or \ works
  const escaped = JSON.stringify(String(q)).slice(1, -1);
  return "%" + escaped.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

function zcodeSearch(dir, q, limit) {
  const db = openDb(dir);
  if (!db || !q) return [];
  const pat = likePattern(q);
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 500);
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT DISTINCT s.id, s.title, s.directory, s.time_created, s.time_updated
         FROM session s JOIN message m ON m.session_id = s.id
        WHERE m.data LIKE ? ESCAPE '\\'
       UNION
       SELECT DISTINCT s.id, s.title, s.directory, s.time_created, s.time_updated
         FROM session s JOIN part p ON p.session_id = s.id
        WHERE p.data LIKE ? ESCAPE '\\'
        LIMIT ?`
    ).all(pat, pat, cap);
  } catch (e) {
    return [];
  }
  return rows.map((r) => {
    const ms = Number(r.time_updated) || Number(r.time_created) || 0;
    return {
      sessionId: r.id,
      file: TOKEN + r.id,
      name: r.id,
      title: (r.title || "").trim() || baseName(r.directory) || r.id,
      folder: normFolder(r.directory),
      mtime: ms,
      lastTs: isoFromMs(ms),
      source: "zcode",
      deletable: false,
    };
  });
}

/* ---------- stats ---------- */
function zcodeStats(dir) {
  const sessions = listZcodeSessions(dir);
  let userMsgs = 0, aiMsgs = 0, toolCalls = 0, thinkingBlocks = 0;
  const byDay = {};
  for (const s of sessions) {
    userMsgs += s.stats.user;
    aiMsgs += s.stats.ai;
    toolCalls += s.stats.tool;
    thinkingBlocks += s.stats.thinking;
    if (s.lastTs) {
      const day = s.lastTs.slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
    }
  }
  return {
    sessionCount: sessions.length,
    messageCount: aiMsgs + userMsgs,
    aiMessages: aiMsgs,
    userMessages: userMsgs,
    toolCalls,
    thinkingBlocks,
    sessionsByDay: byDay,
  };
}

module.exports = {
  TOKEN,
  isZcodeToken,
  zcodeIdFromToken,
  zcodeAvailable,
  listZcodeSessions,
  readZcodeRaw,
  zcodeSearch,
  zcodeStats,
  closeDb,
};
