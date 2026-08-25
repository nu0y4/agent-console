/* ============================================================
   Agent Console — application logic
   State: sessions (loaded + parsed), selectedId, search index
   ============================================================ */
(function () {
  "use strict";
  const { escapeHtml, normalize, tokenize, highlight, snippet } = window.Highlighter;
  const { parse } = window.SessionParser;

  /* ---------- state ---------- */
  let sessions = [];          // { id, file, title, firstTs, lastTs, stats, messages }
  let selectedId = null;
  let index = [];             // flat search entries { sid, midx, bidx, kind, title, text }
  let seq = 0;

  /* ---------- DOM refs ---------- */
  const $ = (sel) => document.querySelector(sel);
  const sessionList = $("#sessionList");
  const sessionCount = $("#sessionCount");
  const sidebarEmpty = $("#sidebarEmpty");
  const chatTitle = $("#chatTitle");
  const chatMeta = $("#chatMeta");
  const chatEmpty = $("#chatEmpty");
  const chatScroll = $("#chatScroll");
  const timeline = $("#timeline");
  const searchInput = $("#searchInput");
  const searchPanel = $("#searchPanel");
  const searchWrap = $("#searchWrap");
  const searchResults = $("#searchResults");
  const resultMeta = $("#resultMeta");
  const fileInput = $("#fileInput");
  const delBtn = $("#delBtn");

  let activeFilter = "all";
  let searchResultsState = [];
  let selIdx = -1;
  let msgFilterType = "all"; // "all" | "user" | "tool" | "ai" | "thinking"

  /* ---------- helpers ---------- */
  function fmtClock(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d)) return ts;
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function fmtDate(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d)) return ts;
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function shortId(uuid) {
    return uuid ? String(uuid).slice(0, 8) : "";
  }

  function sessionTimeLabel(s) {
    if (s.firstTs && s.lastTs) {
      return `${fmtDate(s.firstTs)} ${fmtClock(s.firstTs)}`;
    }
    if (s.mtime) {
      return `${fmtDate(s.mtime)} ${fmtClock(s.mtime)}`;
    }
    return "—";
  }

  /* ---------- rendering: sidebar ---------- */
  let sortMode = "time"; // "time" | "folder"

  function sessionItemEl(s) {
    const li = document.createElement("li");
    li.className = "session-item" + (s.id === selectedId ? " active" : "");
    li.dataset.id = s.id;
    li.title = s.file;

    const title = document.createElement("div");
    title.className = "si-title";
    title.innerHTML = escapeHtml(s.title);
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = s.loaded ? " · " + (s.stats ? s.stats.total : 0) + " 条" : " · …";
    title.appendChild(pill);

    const meta = document.createElement("div");
    meta.className = "si-meta";
    const idFull = (s.file || "").replace(/\.jsonl$/i, "");
    meta.innerHTML =
      `<span class="mono">${escapeHtml(sessionTimeLabel(s))}</span>` +
      `<span class="dot"></span>` +
      `<span class="si-tag" title="${escapeHtml(idFull)}">${escapeHtml(idFull)}</span>`;

    const counts = document.createElement("div");
    counts.className = "si-counts";
    const stat = s.stats;
    const parts = [];
    if (stat && stat.user) parts.push(`<span>${miniSvg("user")} ${stat.user}</span>`);
    if (stat && stat.ai) parts.push(`<span>${miniSvg("ai")} ${stat.ai}</span>`);
    if (stat && stat.tool) parts.push(`<span>${miniSvg("tool")} ${stat.tool}</span>`);
    counts.innerHTML = parts.join("");

    const del = document.createElement("button");
    del.className = "si-del";
    del.textContent = "✕";
    del.title = "删除该会话";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeSession(s.id);
    });

    li.append(title, meta, counts, del);
    li.addEventListener("click", () => selectSession(s.id));
    return li;
  }

  const collapsedFolders = new Set();

  function groupTitle(label, count) {
    // Claude Code encodes path separators as "--"; make it readable
    const readable = label === "根目录" ? label : label.replace(/--/g, "/");
    const collapsed = collapsedFolders.has(label);
    const g = document.createElement("div");
    g.className = "sidebar-group" + (collapsed ? " collapsed" : "");
    g.title = collapsed ? "展开" : "折叠";
    g.innerHTML =
      `<span class="garrow">${collapsed ? "▸" : "▾"}</span>` +
      `<span>${escapeHtml(readable)}</span>` +
      `<span class="gcount">${count}</span>` +
      `<span class="gsep"></span>`;
    g.addEventListener("click", () => {
      if (collapsedFolders.has(label)) collapsedFolders.delete(label);
      else collapsedFolders.add(label);
      renderSidebar();
    });
    return g;
  }

  function renderSidebar() {
    sessionCount.textContent = sessions.length;
    sidebarEmpty.style.display = sessions.length ? "none" : "";
    sessionList.innerHTML = "";

    if (sortMode === "folder") {
      const byFolder = new Map();
      for (const s of sessions) {
        const key = s.folder || "根目录";
        if (!byFolder.has(key)) byFolder.set(key, []);
        byFolder.get(key).push(s);
      }
      const folders = Array.from(byFolder.keys()).sort((a, b) => {
        if (a === "根目录") return 1;
        if (b === "根目录") return -1;
        return a.localeCompare(b);
      });
      for (const f of folders) {
        sessionList.appendChild(groupTitle(f, byFolder.get(f).length));
        if (!collapsedFolders.has(f)) {
          byFolder.get(f).forEach((s) => sessionList.appendChild(sessionItemEl(s)));
        }
      }
    } else {
      sessions.forEach((s) => sessionList.appendChild(sessionItemEl(s)));
    }
  }

  function removeSession(id) {
    sessions = sessions.filter((s) => s.id !== id);
    if (selectedId === id) selectedId = sessions.length ? sessions[0].id : null;
    renderSidebar();
    renderChat();
  }

  /* ---------- rendering: timeline ---------- */
  function blockEl(block, idx, searchQuery) {
    const hl = (t) => (searchQuery ? highlight(t, searchQuery) : escapeHtml(t));
    const wrap = document.createElement("div");
    wrap.dataset.bidx = idx;

    if (block.kind === "text") {
      wrap.className = "text-block assistant";
      wrap.innerHTML = hl(block.text);
      return wrap;
    }

    if (block.kind === "thinking") {
      wrap.className = "thinking-block";
      const isSignal = /signature|thinking/i.test(block.text);
      if (isSignal) wrap.classList.add("signal");
      const title = isSignal ? "思维链摘要" : "思考过程";
      wrap.innerHTML =
        `<div class="thinking-head"><span class="tw">▾</span>${title}` +
        `<span class="status">${escapeHtml(block.text.split("\n").length)} 行</span></div>` +
        `<div class="thinking-body"><pre></pre></div>`;
      wrap.querySelector("pre").innerHTML = hl(block.text);
      wrap.querySelector(".thinking-head").addEventListener("click", () => wrap.classList.toggle("open"));
      return wrap;
    }

    if (block.kind === "tool_use") {
      wrap.className = "tool-block";
      let inputJson = "";
      try { inputJson = JSON.stringify(block.input, null, 2); } catch (e) { inputJson = String(block.input); }
      wrap.innerHTML =
        `<div class="tool-head"><span class="tool-ic">${toolIcon(block.name)}</span>` +
        `<span class="tool-name">${escapeHtml(block.name)}</span>` +
        `<span class="tool-tag">tool</span>` +
        `<span class="tw">›</span></div>` +
        `<div class="tool-input"><pre></pre></div>` +
        (block.result != null
          ? `<div class="tool-result"><div class="tr-label ${block.result.is_error ? "tr-err" : "tr-ok"}">` +
            `${block.result.is_error ? "error" : "result"}${block.result.summary ? " · " + escapeHtml(block.result.summary) : ""}</div>` +
            `<pre></pre></div>`
          : "");
      wrap.querySelector(".tool-input pre").innerHTML = hl(inputJson);
      if (block.result) wrap.querySelector(".tool-result pre").innerHTML = hl(block.result.content);
      wrap.querySelector(".tool-head").addEventListener("click", () => wrap.classList.toggle("open"));
      return wrap;
    }

    wrap.className = "text-block assistant";
    wrap.innerHTML = hl(block.text || "");
    return wrap;
  }

  function toolIcon(name) {
    const n = String(name || "").toLowerCase();
    const svg = {
      bash: '<path d="M4 8l6-5 6 5M4 8l6 5 6-5"/>',
      read: '<path d="M2 12V6a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v8a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-2z"/><path d="M9 12h4m-4-3h4"/>',
      write: '<path d="M4 2h8l2 2v10H4z"/><path d="M7 9h4m-4 3h4"/>',
      edit: '<path d="M11 2L4 9v3h3l7-7z"/><path d="M9 4l3 3"/>',
      glob: '<circle cx="6" cy="6" r="3"/><circle cx="14" cy="6" r="3"/><circle cx="6" cy="14" r="3"/><circle cx="14" cy="14" r="3"/>',
    }[n] || '<circle cx="8" cy="8" r="5"/><path d="M12 12l4 4"/>';
    return `<svg viewBox="0 0 16 16">${svg}</svg>`;
  }

  // tiny stat icons for the sidebar counts
  function miniSvg(kind) {
    const paths = {
      user: '<circle cx="8" cy="5.5" r="3"/><path d="M2.5 14c.8-2.8 3-4 5.5-4s4.7 1.2 5.5 4"/>',
      ai: '<path d="M8 2l1.2 2.6 2.8.4-2 2 .5 2.8L8 8.6 5.5 9.8l.5-2.8-2-2 2.8-.4z"/><path d="M3.5 11l.4.9M12.5 11l-.4.9M8 13v1.2"/>',
      tool: '<path d="M14.5 5.5a3.4 3.4 0 0 1-4.6 4.6L4 16 0 12l5.9-5.9a3.4 3.4 0 0 1 4.6-4.6L7.5 4.5 11.5 8.5z"/>',
    }[kind] || "";
    return `<svg class="mini-ic" viewBox="0 0 16 16">${paths}</svg>`;
  }

  // 消息类型判定：返回该消息包含的所有类型（一个 assistant 消息可能含多种 block）
  function messageTypes(m) {
    if (!m) return [];
    const types = new Set();
    if (m.kind === "user") types.add("user");
    if (m.kind === "system") types.add("system");
    if (m.kind === "assistant") {
      for (const b of (m.blocks || [])) {
        if (b.kind === "text") types.add("ai");
        else if (b.kind === "thinking") types.add("thinking");
        else if (b.kind === "tool_use") types.add("tool");
      }
    }
    return Array.from(types);
  }
  // 主类型（用于着色/分类）：优先级 tool > thinking > ai > user
  function primaryType(m) {
    const t = messageTypes(m);
    if (t.includes("tool")) return "tool";
    if (t.includes("thinking")) return "thinking";
    if (t.includes("ai")) return "ai";
    if (t.includes("user")) return "user";
    return "system";
  }

  function showLoading(text) {
    timeline.innerHTML = "";
    chatTitle.textContent = "正在加载会话…";
    chatMeta.textContent = "";
    $("#chatId").hidden = true;
    $("#cidFile").textContent = "";
    $("#scrub").hidden = true;
    chatEmpty.style.display = "flex";
    chatEmpty.innerHTML =
      `<div class="empty-ring spin"></div>` +
      `<h2>${escapeHtml(text || "正在加载中…")}</h2>` +
      `<p class="dim">扫描会话文件夹并解析…</p>`;
  }

  // snapshot of the static empty-state markup (restored after a session loads)
  let chatEmptyHTML = null;

  function renderChat() {
    timeline.innerHTML = "";
    if (chatEmptyHTML === null) chatEmptyHTML = chatEmpty.innerHTML;
    chatEmpty.style.display = "none";
    const s = sessions.find((x) => x.id === selectedId);
    if (!s) {
      chatTitle.textContent = "选择一个会话";
      chatMeta.textContent = "";
      chatEmpty.innerHTML = chatEmptyHTML;
      chatEmpty.style.display = "flex";
      $("#chatId").hidden = true;
      $("#cidFile").textContent = "";
      $("#scrub").hidden = true;
      $("#msgFilter").hidden = true;
      return;
    }

    // lazy-load: metadata-only session not parsed yet → placeholder + fetch
    if (!s.loaded) {
      $("#msgFilter").hidden = true;
      chatTitle.textContent = s.title;
      chatMeta.textContent = s._loading ? "正在加载内容…" : "点击查看会话内容";
      chatEmpty.style.display = "flex";
      chatEmpty.innerHTML =
        `<div class="empty-ring${s._loading ? " spin" : ""}"></div>` +
        `<h2>${escapeHtml(s._loading ? "正在加载会话…" : "会话未加载")}</h2>` +
        `<p class="dim">${escapeHtml(s._loading ? "拉取并解析完整内容…" : "单击以加载完整内容")}</p>`;
      $("#chatId").hidden = true;
      $("#cidFile").textContent = "";
      $("#scrub").hidden = true;
      if (!s._loading) loadSession(s);
      return;
    }

    chatTitle.textContent = s.title;
    chatMeta.textContent =
      `${s.stats.total} 条消息 · ${s.stats.user} 用户 · ${s.stats.ai} AI · ${s.stats.tool} 工具 · ${fmtDate(s.firstTs)}`;
    $("#msgFilter").hidden = false;
    syncMsgFilterChips();

    // session id + resume command
    const chatId = $("#chatId");
    const cidFile = $("#cidFile");
    const cidCmd = $("#cidCmd");
    if (s.sessionId) {
      chatId.hidden = false;
      cidFile.textContent = (s.file || "").replace(/\.jsonl$/i, "");
      cidFile.title = s.file || "";
      cidCmd.textContent = `claude --resume ${s.sessionId}`;
      cidCmd.title = `claude --resume ${s.sessionId}`;
    } else {
      chatId.hidden = true;
      cidFile.textContent = "";
    }

    const frag = document.createDocumentFragment();
    const filter = msgFilterType; // "all" | "user" | "tool" | "ai" | "thinking"
    s.messages.forEach((m, mi) => {
      // 类型筛选
      const types = messageTypes(m);
      if (filter !== "all" && !types.includes(filter)) return;

      const row = document.createElement("div");
      row.className = "msg" + (m.kind === "user" ? " msg--user" : m.kind === "assistant" ? " msg--assistant" : "");
      row.dataset.msgid = mi;
      row.dataset.types = types.join(",");

      const head = document.createElement("div");
      head.className = "msg-head";
      const badge = document.createElement("span");
      badge.className = "role-badge " + m.kind;
      badge.textContent = m.kind === "assistant" ? "AI" : m.kind === "user" ? "用户" : "系统";
      const time = document.createElement("span");
      time.className = "msg-time";
      time.textContent = fmtClock(m.timestamp);
      head.append(badge, time);
      row.appendChild(head);

      const content = document.createElement("div");
      content.className = "msg-content";

      if (m.kind === "system") {
        const sys = document.createElement("div");
        sys.className = "system-block";
        sys.innerHTML =
          `<span>${escapeHtml(m.summary)}</span>` +
          (m.subtype ? `<span class="mono">${escapeHtml(m.subtype)}</span>` : "") +
          (m.messageId ? `<span class="mono">${escapeHtml(shortId(m.messageId))}</span>` : "");
        content.appendChild(sys);
      } else if (m.kind === "user") {
        const b = document.createElement("div");
        b.className = "text-block user";
        b.innerHTML = escapeHtml(m.text);
        content.appendChild(b);
        if (m.isMeta) {
          const tag = document.createElement("div");
          tag.className = "system-block";
          tag.textContent = "meta · skill 指令";
          content.appendChild(tag);
        }
      } else {
        m.blocks.forEach((blk, bi) => content.appendChild(blockEl(blk, bi, null)));
      }

      row.appendChild(content);
      frag.appendChild(row);
    });
    timeline.appendChild(frag);
    chatScroll.scrollTop = 0;
    initScrub(s);
  }

  /* ---------- timeline scrubber ---------- */
  // Maps chat scroll progress (0..1) to a scrub position and a message index,
  // both directions: dragging scrubs the chat, scrolling the chat moves the thumb.
  function initScrub(s) {
    const scrub = $("#scrub");
    const track = $("#scrubTrack");
    const content = $("#scrubContent");
    const bubble = $("#scrubBubble");
    const tickEl = $("#scrubTick");
    const startEl = $("#scrubStart");
    const endEl = $("#scrubEnd");
    const rangeEl = $("#scrubRange");
    scrub.hidden = false;

    // ---- real time axis ----
    const times = s.messages.map((m) => m.timestamp).filter(Boolean).sort();
    const tStart = times.length ? times[0] : null;
    const tEnd = times.length ? times[times.length - 1] : null;
    const duration = (tStart && tEnd) ? (new Date(tEnd) - new Date(tStart)) : 0;

    const fmtFull = (t) => (t ? `${fmtDate(t)} ${fmtClock(t)}` : "—");
    startEl.textContent = tStart ? fmtFull(tStart) : "会话开始";
    endEl.textContent = tEnd ? fmtFull(tEnd) : "会话结束";

    // pick a "major" step so major ticks are finer-grained (more of them)
    function niceStep(ms) {
      const steps = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 10800000, 21600000, 43200000, 86400000];
      for (const st of steps) if (ms / st <= 30) return st;
      return steps[steps.length - 1];
    }
    const stepMs = duration > 0 ? niceStep(duration) : 30000;
    const minorMs = stepMs / 4;   // 细刻度
    const midMs = stepMs / 2;     // 中刻度

    const pxPerMajor = 160;  // 拉长时间轴：每个 major 刻度间隔更宽
    const stripW = duration > 0 ? Math.round((duration / stepMs) * pxPerMajor) : 1200;
    content.style.width = stripW + "px";

    const dotsWrap = $("#scrubDots");
    dotsWrap.innerHTML = "";
    const t0 = tStart ? new Date(tStart).getTime() : 0;
    const t1 = tEnd ? new Date(tEnd).getTime() : 0;
    const pxPerMs = duration > 0 ? stripW / duration : 0;

    if (tStart && tEnd && duration > 0) {
      // origin = earliest whole major-step boundary (so the first major tick
      // lands exactly at x=0, flush under the marker — no left gap)
      const origin = Math.floor(t0 / stepMs) * stepMs;
      const span = t1 - origin; // may be slightly longer than duration
      const px = stripW / span;

      // ticks: minor resolution from origin to t1
      let cur = origin;
      let guard = 0;
      while (cur <= t1 && guard < 2000) {
        const x = (cur - origin) * px;
        const isMajor = Math.abs(cur % stepMs) < minorMs / 2;
        const isMid = !isMajor && Math.abs(cur % midMs) < minorMs / 2;
        const tick = document.createElement("div");
        tick.className = "scrub-dot" + (isMajor ? " major" : isMid ? " mid" : "");
        tick.style.left = `${x}px`;
        dotsWrap.appendChild(tick);
        if (isMajor) {
          const lab = document.createElement("span");
          lab.className = "scrub-timelabel";
          lab.style.left = `${x}px`;
          const d = new Date(cur);
          const hh = String(d.getHours()).padStart(2, "0");
          const mm = String(d.getMinutes()).padStart(2, "0");
          const ss = String(d.getSeconds()).padStart(2, "0");
          lab.textContent = `${hh}:${mm}:${ss}`;
          dotsWrap.appendChild(lab);
        }
        cur += minorMs;
        guard++;
      }

      // event dots at every message timestamp, colored by type
      for (const m of s.messages) {
        if (!m.timestamp) continue;
        const x = (new Date(m.timestamp) - origin) * px;
        if (x < 0 || x > stripW) continue;
        const ev = document.createElement("div");
        ev.className = "scrub-ev ev-" + primaryType(m);
        ev.style.left = `${x}px`;
        dotsWrap.appendChild(ev);
      }
    }

    // time → progress [0,1]
    function pToTime(p) {
      if (!duration) return fmtFull(tStart);
      return fmtFull(new Date(t0 + p * duration));
    }

    const setRange = (p) => {
      const d = new Date(t0 + p * duration);
      rangeEl.textContent = fmtFull(d);
      tickEl.textContent = fmtClock(d);
    };

    const rows = timeline.querySelectorAll(".msg");
    const total = rows.length;
    let dragging = false;
    const setBubble = (label) => { bubble.textContent = label; };

    function applyPos(p) {
      p = Math.max(0, Math.min(1, p));
      // 完整刻度宽滚动：p=0 最早在中央，p=1 最晚在中央
      content.style.transform = `translateX(${(-p * stripW).toFixed(1)}px)`;
      setRange(p);
    }

    function scrollChatTo(p) {
      const max = chatScroll.scrollHeight - chatScroll.clientHeight;
      chatScroll.scrollTop = max * p;
    }

    function scrubToP(p) {
      p = Math.max(0, Math.min(1, p));
      applyPos(p);
      scrollChatTo(p);
      const idx = Math.min(total - 1, Math.max(0, Math.round(p * (total - 1))));
      const row = rows[idx];
      if (row) setBubble(`#${Number(row.dataset.msgid) + 1} ${pToTime(p)}`);
    }

    function posFromEvent(clientX) {
      const r = track.getBoundingClientRect();
      return (clientX - r.left) / r.width;
    }

    let dragStarted = false;
    let startX = 0, startP = 0;
    let inertiaTimer = null;
    const DRAG_THRESHOLD = 4;

    track.addEventListener("pointerdown", (e) => {
      dragging = true;
      dragStarted = false;
      startX = e.clientX;
      startP = progressOf();
      track.setPointerCapture(e.pointerId);
    });
    track.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (!dragStarted) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return; // 点击不跳
        dragStarted = true;
        scrub.classList.add("dragging");
      }
      // 手指往左(dx<0) → 看更晚时间 → p 增大
      const np = startP - dx / stripW;
      scrubToP(np);
    });
    const endDrag = (e) => {
      dragging = false;
      dragStarted = false;
      scrub.classList.remove("dragging");
    };
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);

    const scrollHandler = () => { if (!dragging) applyPos(progressOf()); };
    function progressOf() {
      const max = chatScroll.scrollHeight - chatScroll.clientHeight;
      return max > 0 ? chatScroll.scrollTop / max : 0;
    }
    chatScroll.removeEventListener("scroll", scrollHandler);
    chatScroll.addEventListener("scroll", scrollHandler);

    // 初始：最早时间对准中央指针
    applyPos(0);
    scrollChatTo(0);
  }

  /* ---------- session management ---------- */
  function addSession(source) {
    const s = parse(source.text, source.file);
    if (!s.messages.length) {
      if (!source.silent) alert(`未在 ${source.file} 中解析到有效会话行。`);
      return null;
    }
    const id = "s" + (++seq);
    const rec = Object.assign({ id, file: source.file }, s);
    sessions.unshift(rec);
    renderSidebar();
    return rec;
  }

  function selectSession(id) {
    selectedId = id;
    renderSidebar();
    renderChat();
  }

  function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let pending = files.length;
    let firstRec = null;
    const finish = () => {
      if (pending === 0) {
        if (firstRec) selectSession(firstRec.id);
        else renderSidebar();
      }
    };
    files.forEach((f) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const rec = addSession({ text: e.target.result, file: f.name });
        if (rec && !firstRec) firstRec = rec;
        pending--;
        finish();
      };
      reader.onerror = () => { pending--; finish(); };
      reader.readAsText(f, "utf-8");
    });
  }

  /* ---------- search index ---------- */
  function buildIndex() {
    index = [];
    sessions.forEach((s) => {
      if (!s.loaded) return; // only index parsed sessions
      s.messages.forEach((m, mi) => {
        if (m.kind === "user") {
          index.push({ sid: s.id, midx: mi, bidx: -1, kind: "user", title: "用户 · " + s.title, text: m.text });
        } else if (m.kind === "assistant") {
          m.blocks.forEach((b, bi) => {
            if (b.kind === "text") {
              index.push({ sid: s.id, midx: mi, bidx: bi, kind: "ai", title: "AI 回复 · " + s.title, text: b.text });
            } else if (b.kind === "thinking") {
              index.push({ sid: s.id, midx: mi, bidx: bi, kind: "thinking", title: "思考 · " + s.title, text: b.text });
            } else if (b.kind === "tool_use") {
              let inputJson = "";
              try { inputJson = JSON.stringify(b.input); } catch (e) {}
              index.push({
                sid: s.id, midx: mi, bidx: bi, kind: "tool",
                title: `工具 ${b.name} · ` + s.title,
                text: `${b.name}\n${inputJson}\n${b.result ? b.result.content : ""}`,
              });
            }
          });
        }
      });
    });
  }

  // rg-backed search: the backend greps the whole session folder and returns
  // matching files; results render immediately (not gated on the preload).
  let searchSeq = 0;
  async function runSearch(query, filter) {
    const q = query.trim();
    if (!q) return [];
    const seq = ++searchSeq;
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`).catch(() => null);
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    if (!data || !data.sessions) return [];
    if (seq !== searchSeq) return []; // superseded by a newer keystroke

    // keep it fast: only sniff the matched files for the type filter
    const items = filter === "all" ? data.sessions : [];
    if (filter !== "all") {
      for (const item of data.sessions) {
        const existing = sessions.find((x) => x.backendFile === item.file);
        if (existing && existing.loaded) {
          if (sessionMatches(existing, q, filter)) items.push(item);
          continue;
        }
        try {
          const raw = await fetch(`/api/sessions/raw?file=${encodeURIComponent(item.file)}`).then((r) => r.text());
          const parsed = parse(raw, item.name);
          if (sessionMatches({ messages: parsed.messages }, q, filter)) items.push(item);
        } catch (e) {}
        if (items.length > 200) break;
      }
    }
    return items.map((item) => ({
      sid: item.file,
      backendFile: item.file,
      title: item.title || item.file,
      folder: item.folder || "",
    }));
  }

  function sessionMatches(s, q, filter) {
    const tokens = tokenize(q).map(normalize);
    const hit = (text) => tokens.every((t) => normalize(text).includes(t));
    for (const m of s.messages) {
      if (filter === "user") { if (m.kind === "user" && hit(m.text)) return true; continue; }
      if (m.kind !== "assistant") continue;
      for (const b of m.blocks) {
        if (filter === "tool" && b.kind === "tool_use") {
          let j = "";
          try { j = JSON.stringify(b.input); } catch (e) {}
          if (hit(b.name + "\n" + j)) return true;
        } else if (filter === "ai" && b.kind === "text" && hit(b.text)) return true;
        else if (filter === "thinking" && b.kind === "thinking" && hit(b.text)) return true;
      }
    }
    return false;
  }

  /* ---------- search panel ---------- */
  function openSearch() {
    buildIndex();
    searchPanel.hidden = false;
    if (searchInput.value) {
      // keep existing query; just refresh results
      renderSearch();
      return;
    }
    renderSearch();
    searchInput.value = "";
    activeFilter = "all";
    syncFilterChips();
  }
  function closeSearch() {
    searchPanel.hidden = true;
  }
  function syncFilterChips() {
    document.querySelectorAll(".chip[data-filter]").forEach((c) => {
      c.classList.toggle("on", c.dataset.filter === activeFilter);
    });
  }

  function renderSearch() {
    const q = searchInput.value;
    const mk = (label, sub) => {
      searchResults.innerHTML = "";
      const div = document.createElement("div");
      div.className = "sr-empty";
      div.innerHTML = `<div class="big">⌕</div><div>${escapeHtml(label)}</div>` + (sub ? `<div class="dim">${escapeHtml(sub)}</div>` : "");
      searchResults.appendChild(div);
    };

    if (!q.trim()) {
      mk("输入关键词开始全文搜索\n支持 工具 / AI / 用户 / 思考 过滤", "");
      resultMeta.textContent = "";
      return;
    }

    // loading state
    searchResults.innerHTML = "";
    const loader = document.createElement("div");
    loader.className = "sr-empty";
    loader.innerHTML = `<div class="big" style="font-size:16px">搜索中…</div>`;
    searchResults.appendChild(loader);
    resultMeta.textContent = "搜索中…";

    runSearch(q, activeFilter).then((results) => {
      searchResultsState = results;
      if (searchInput.value !== q) return; // stale keystroke
      searchResults.innerHTML = "";
      if (!results.length) {
        mk(`没有匹配 “${q}” 的结果`, "试试其他关键词");
        resultMeta.textContent = "0 条结果";
        return;
      }
      const shown = results.slice(0, 60);
      shown.forEach((r, ri) => {
        const btn = document.createElement("button");
        btn.className = "sr-item" + (ri === selIdx ? " sel" : "");
        btn.dataset.ri = ri;
        const s = sessions.find((x) => x.backendFile === r.backendFile);
        btn.innerHTML =
          `<div class="sr-title">${escapeHtml(r.title)} <span class="si-tag">${activeFilter === "all" ? "会话" : { tool: "工具调用", ai: "AI 对话", user: "用户对话", thinking: "思考过程" }[activeFilter] || "会话"}</span></div>` +
          `<div class="sr-meta"><span class="mono">${escapeHtml(s ? sessionTimeLabel(s) : "")}</span>` +
          `<span>· ${escapeHtml(r.folder || "根目录")}</span></div>`;
        btn.addEventListener("click", () => jumpToResult(ri));
        searchResults.appendChild(btn);
      });
      resultMeta.textContent = `${results.length} 个会话命中` + (shown.length < results.length ? ` · 显示前 ${shown.length} 条` : "");
    });
  }

  function jumpToResult(ri) {
    const r = searchResultsState[ri];
    if (!r) return;
    const s = sessions.find((x) => x.backendFile === r.backendFile);
    if (!s) return;
    selectSession(s.id);
    closeSearch();
    // rg-backed results are file-level — no exact message index to jump to
    if (r.midx == null) return;
    const row = timeline.querySelector(`[data-msgid="${r.midx}"]`);
    if (!row) return;
    chatScroll.scrollTop = row.offsetTop - chatScroll.clientHeight / 2 + row.offsetHeight / 2;
    let target = row;
    if (r.bidx >= 0) {
      const blk = row.querySelector(`[data-bidx="${r.bidx}"]`);
      if (blk) target = blk;
      if (blk && blk.classList.contains("tool-block") && blk.querySelector(".tool-input")) {
        blk.classList.add("open");
      }
    }
    flash(target);
  }

  function flash(el) {
    el.style.transition = "none";
    el.style.outline = "2px solid var(--teal)";
    el.style.outlineOffset = "3px";
    el.style.borderRadius = "6px";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = "outline-color 1.2s ease, outline-offset 1.2s ease";
        el.style.outline = "2px solid transparent";
        el.style.outlineOffset = "6px";
      });
    });
    setTimeout(() => { el.style.outline = ""; el.style.outlineOffset = ""; }, 1400);
  }

  /* ---------- sidebar resize & collapse ---------- */
  const resizer = $("#resizer");
  const sidebarEl = $("#sidebar");
  const SB_KEY = "agent-console.sidebar";

  function applySidebarState() {
    const st = JSON.parse(localStorage.getItem(SB_KEY) || "null") || {};
    const width = st.collapsed ? 0 : Math.max(180, Math.min(520, st.width || 280));
    document.documentElement.style.setProperty("--sidebar-width", width + "px");
    sidebarEl.classList.toggle("collapsed", !!st.collapsed);
    resizer.title = st.collapsed ? "展开侧边栏" : "拖动调整宽度 · 双击折叠";
  }
  function saveSidebarState(partial) {
    const st = JSON.parse(localStorage.getItem(SB_KEY) || "null") || {};
    localStorage.setItem(SB_KEY, JSON.stringify(Object.assign(st, partial)));
  }

  let resizing = false;
  let resizedMoved = false;
  resizer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    resizing = true;
    resizedMoved = false;
    resizer.classList.add("dragging");
    resizer.setPointerCapture(e.pointerId);
  });
  resizer.addEventListener("pointermove", (e) => {
    if (!resizing) return;
    const w = e.clientX - sidebarEl.getBoundingClientRect().left;
    const clamped = Math.max(180, Math.min(520, w));
    document.documentElement.style.setProperty("--sidebar-width", clamped + "px");
    resizedMoved = true;
  });
  const endResize = () => {
    if (!resizing) return;
    resizing = false;
    resizer.classList.remove("dragging");
    if (!resizedMoved) return; // it was a click, not a drag — let click handler act
    const w = parseInt(document.documentElement.style.getPropertyValue("--sidebar-width")) || 280;
    saveSidebarState({ width: w, collapsed: false });
    applySidebarState();
  };
  resizer.addEventListener("pointerup", endResize);
  resizer.addEventListener("pointercancel", endResize);

  let suppressClickUntil = 0;
  resizer.addEventListener("dblclick", () => {
    suppressClickUntil = Date.now() + 350;
    const st = JSON.parse(localStorage.getItem(SB_KEY) || "null") || {};
    const collapsed = !st.collapsed;
    saveSidebarState({ collapsed });
    applySidebarState();
  });
  // click on collapsed resizer expands (suppressed right after a dblclick)
  resizer.addEventListener("click", () => {
    if (Date.now() < suppressClickUntil) return;
    const st = JSON.parse(localStorage.getItem(SB_KEY) || "null") || {};
    if (st.collapsed) {
      saveSidebarState({ collapsed: false });
      applySidebarState();
    }
  });

  applySidebarState();

  /* ---------- export session as plain text ---------- */
  function exportSession(s) {
    const fmtT = (t) => {
      const d = new Date(t);
      if (isNaN(d)) return "";
      const p = (n) => String(n).padStart(2, "0");
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    const lines = [];
    lines.push(`===== 会话：${s.title} =====`);
    if (s.sessionId) lines.push(`sessionId: ${s.sessionId}`);
    lines.push(`文件：${(s.file || "").replace(/\.jsonl$/i, "")}`);
    lines.push("");

    for (const m of s.messages) {
      if (m.kind === "user") {
        lines.push(`[${fmtT(m.timestamp)}]用户：${m.text}`);
      } else if (m.kind === "assistant") {
        const blocks = m.blocks || [];
        const parts = [];
        for (const b of blocks) {
          if (b.kind === "thinking" && b.text) {
            parts.push(`<thinking>${b.text}</thinking>`);
          } else if (b.kind === "text" && b.text) {
            parts.push(b.text);
          } else if (b.kind === "tool_use") {
            let input = "";
            try { input = JSON.stringify(b.input, null, 2); } catch (e) { input = String(b.input); }
            parts.push(`<tool>${b.name}${input ? "\n" + input : ""}</tool>`);
          }
        }
        if (parts.length) {
          lines.push(`[${fmtT(m.timestamp)}]AI：${parts.join("\n")}`);
        }
      }
    }
    return lines.join("\n");
  }

  $("#exportBtn").addEventListener("click", () => {
    const s = sessions.find((x) => x.id === selectedId);
    if (!s || !s.loaded) {
      alert("请先选择一个已加载的会话");
      return;
    }
    const text = exportSession(s);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(s.file || "session").replace(/\.jsonl$/i, "")}.txt`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 300);
  });

  /* ---------- events ---------- */
  // 消息类型筛选
  function syncMsgFilterChips() {
    document.querySelectorAll(".msg-filter .chip").forEach((c) => {
      c.classList.toggle("on", c.dataset.type === msgFilterType);
    });
  }
  document.querySelectorAll(".msg-filter .chip").forEach((c) => {
    c.addEventListener("click", () => {
      msgFilterType = c.dataset.type;
      syncMsgFilterChips();
      renderChat();
    });
  });

  // 上下跳转：定位到指定类型消息
  function visibleMsgIndices() {
    const s = sessions.find((x) => x.id === selectedId);
    if (!s) return [];
    const idx = [];
    s.messages.forEach((m, mi) => {
      const types = messageTypes(m);
      if (msgFilterType === "all" || types.includes(msgFilterType)) idx.push(mi);
    });
    return idx;
  }
  function currentMsgIndex() {
    // 当前滚动位置对应的第一条可见消息
    const rows = timeline.querySelectorAll(".msg");
    let best = null;
    for (const r of rows) {
      if (r.getBoundingClientRect().top < chatScroll.getBoundingClientRect().top + 50) {
        best = r;
      } else break;
    }
    return best ? Number(best.dataset.msgid) : -1;
  }
  function jumpToType(dir) {
    const indices = visibleMsgIndices();
    if (!indices.length) return;
    const cur = currentMsgIndex();
    let target = -1;
    if (dir === "next") {
      target = indices.find((i) => i > cur) ?? indices[0];
    } else {
      const rev = [...indices].reverse();
      target = rev.find((i) => i < cur) ?? indices[indices.length - 1];
    }
    if (target < 0) return;
    const row = timeline.querySelector(`[data-msgid="${target}"]`);
    if (!row) return;
    chatScroll.scrollTop = row.offsetTop - 80;
    flash(row);
  }
  $("#jumpNext").addEventListener("click", () => jumpToType("next"));
  $("#jumpPrev").addEventListener("click", () => jumpToType("prev"));

  // drag & drop .jsonl files anywhere → load like 导入会话
  const dropOverlay = $("#dropOverlay");
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (!e.dataTransfer) return;
    const types = Array.from(e.dataTransfer.types || []);
    // accept file drags (real browsers list "Files"; synthetic ones may be empty)
    if (types.length && !types.includes("Files")) return;
    dragDepth++;
    dropOverlay.hidden = false;
  });
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.hidden = true;
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    const jsonls = files.filter((f) => /\.(jsonl|ndjson|txt)$/i.test(f.name));
    if (jsonls.length) importFiles(jsonls);
    else if (files.length) alert("仅支持 .jsonl / .ndjson / .txt 会话文件");
  });
  // also let dropping directly on the sidebar/empty state work
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => e.preventDefault());

  // open on focus (also Cmd/Ctrl+K), close on outside click / Esc
  searchInput.addEventListener("focus", openSearch);
  document.addEventListener("click", (e) => {
    if (searchPanel.hidden) return;
    if (!searchWrap.contains(e.target)) closeSearch();
  });
  // delete the current session's file (no confirm)
  delBtn.addEventListener("click", async () => {
    const s = sessions.find((x) => x.id === selectedId);
    if (!s || !s.backendFile) return;
    const prev = sessions[sessions.indexOf(s) - 1] || sessions[sessions.indexOf(s) + 1] || null;
    try {
      const res = await fetch(`/api/sessions?file=${encodeURIComponent(s.backendFile)}`, { method: "DELETE" });
      if (!res.ok) { alert("删除失败"); return; }
    } catch (e) { alert("后端不可达"); return; }
    // drop from cache + list
    try { await SessionCache.put(s.backendFile, null); } catch (e) {}
    sessions = sessions.filter((x) => x.id !== s.id);
    selectedId = prev ? prev.id : null;
    renderSidebar();
    renderChat();
  });

  fileInput.addEventListener("change", () => {
    importFiles(fileInput.files);
    fileInput.value = "";
  });
  $("#loadBtn").addEventListener("click", () => fileInput.click());
  $("#emptyLoadBtn").addEventListener("click", () => fileInput.click());

  // sort mode toggle
  document.querySelectorAll(".sort-opt").forEach((b) => {
    b.addEventListener("click", () => {
      sortMode = b.dataset.sort;
      document.querySelectorAll(".sort-opt").forEach((x) => x.classList.toggle("on", x.dataset.sort === sortMode));
      renderSidebar();
    });
  });

  searchInput.addEventListener("input", () => { selIdx = -1; renderSearch(); });

  document.querySelectorAll(".chip[data-filter]").forEach((c) => {
    c.addEventListener("click", () => {
      activeFilter = c.dataset.filter;
      selIdx = -1;
      syncFilterChips();
      renderSearch();
    });
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      searchInput.focus();
      return;
    }
    if (searchPanel.hidden) return;
    if (e.key === "Escape") { closeSearch(); return; }
    const n = searchResultsState.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!n) return;
      selIdx = (selIdx + 1) % Math.min(n, 60);
      syncSel();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!n) return;
      selIdx = (selIdx - 1 + Math.min(n, 60)) % Math.min(n, 60);
      syncSel();
    } else if (e.key === "Enter") {
      const n2 = searchResultsState.length;
      if (!n2) return;
      const target = selIdx < 0 ? 0 : selIdx;
      if (target < Math.min(n2, 60)) jumpToResult(target);
    }
  });

  function syncSel() {
    document.querySelectorAll(".sr-item").forEach((el, i) => {
      el.classList.toggle("sel", i === selIdx);
    });
    const selEl = document.querySelector(`.sr-item.sel`);
    if (selEl && searchResults) {
      const srTop = searchResults.scrollTop;
      const elTop = selEl.offsetTop;
      const elH = selEl.offsetHeight;
      const vpH = searchResults.clientHeight;
      if (elTop < srTop) searchResults.scrollTop = elTop;
      else if (elTop + elH > srTop + vpH) searchResults.scrollTop = elTop + elH - vpH;
    }
  }

  /* ---------- backend sync ---------- */
  const backendAvailable = () => {
    return new Promise((resolve) => {
      fetch("/api/config")
        .then((r) => (r.ok ? resolve(true) : resolve(false)))
        .catch(() => resolve(false));
    });
  };

  // Load the session index from the backend. Cached (previously parsed)
  // sessions restore instantly; the rest load in the background.
  async function loadAllFromBackend() {
    showLoading("正在加载会话…");
    let res;
    try {
      res = await fetch("/api/sessions");
      if (!res.ok) return 0;
    } catch (e) { return 0; }
    const data = await res.json().catch(() => null);
    if (!data || !data.sessions) return 0;
    sessions = [];
    selectedId = null;
    renderSidebar();
    renderChat();
    const cachedCounts = { hit: 0, miss: 0 };
    await Promise.all(data.sessions.map(async (item) => {
      const rec = {
        id: "s" + (++seq),
        file: item.name,
        backendFile: item.file,
        folder: item.folder || "",
        title: item.title || item.name.replace(/\.jsonl$/i, ""),
        sessionId: item.sessionId,
        mtime: item.mtime,
        loaded: false,
        _loading: false,
      };
      // restore from cache when the cached mtime matches the current file
      try {
        const cached = await SessionCache.get(item.file);
        if (cached && cached.mtime === item.mtime) {
          Object.assign(rec, {
            messages: cached.messages,
            stats: cached.stats,
            firstTs: cached.firstTs,
            lastTs: cached.lastTs,
            title: cached.title || rec.title,
            sessionId: cached.sessionId || rec.sessionId,
            loaded: true,
          });
          cachedCounts.hit++;
        } else {
          cachedCounts.miss++;
        }
      } catch (e) {
        cachedCounts.miss++;
      }
      sessions.push(rec);
    }));
    renderSidebar();
    if (sessions.length) selectSession(sessions[0].id);
    // background fill for the ones we didn't have cached
    if (cachedCounts.miss) {
      preloadAll();
    }
    return sessions.length;
  }

  // Fetch + parse a single session's full content on demand.
  async function loadSession(s, silent) {
    if (s.loaded || s._loading) return;
    s._loading = true;
    if (!silent) renderChat(); // show loading placeholder
    try {
      const raw = await fetch(`/api/sessions/raw?file=${encodeURIComponent(s.backendFile)}`).then((r) => r.text());
      const parsed = parse(raw, s.file);
      if (parsed.messages.length) {
        s.messages = parsed.messages;
        s.stats = parsed.stats;
        s.firstTs = parsed.firstTs;
        s.lastTs = parsed.lastTs;
        if (parsed.title) s.title = parsed.title;
        if (parsed.sessionId) s.sessionId = parsed.sessionId;
      } else {
        s.messages = [];
        s.stats = { tool: 0, ai: 0, user: 0, thinking: 0, total: 0 };
      }
    } catch (e) {
      s.messages = [];
      s.stats = { tool: 0, ai: 0, user: 0, thinking: 0, total: 0 };
    }
    s.loaded = true;
    s._loading = false;
    // persist for next visit
    try {
      await SessionCache.put(s.backendFile, {
        mtime: s.mtime,
        messages: s.messages,
        stats: s.stats,
        title: s.title,
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        sessionId: s.sessionId,
      });
    } catch (e) {}
    if (silent) return;
    renderChat();
    renderSidebar();
    if (!searchPanel.hidden) {
      buildIndex();
      renderSearch();
    }
  }

  // Background preload: fills in every not-yet-loaded session in chunks so the
  // UI stays responsive while the sidebar counts fill up.
  const loadProgressEl = $("#loadProgress");
  let preloadToken = 0;
  function preloadAll() {
    const token = ++preloadToken;
    const queue = sessions.filter((s) => !s.loaded && !s._loading);
    if (!queue.length) return;
    loadProgressEl.hidden = false;
    let done = 0;
    const total = queue.length;
    // one at a time + a yield between parses keeps the main thread free so
    // clicks stay responsive while 400+ sessions fill in.
    const CHUNK = 1;
    let step = () => {};
    step = async () => {
      if (token !== preloadToken) return; // superseded
      const slice = queue.slice(done, done + CHUNK);
      if (!slice.length) {
        loadProgressEl.hidden = true;
        renderSidebar();
        buildIndex();
        return;
      }
      await loadSession(slice[0], true);
      done += slice.length;
      loadProgressEl.textContent = `${done}/${total}`;
      setTimeout(step, 4);
    };
    step();
  }

  // Poll the backend for new/changed sessions and load the deltas incrementally.
  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok) return;
        const data = await res.json();
        if (!data || !data.sessions) return;
        const byFile = new Map(data.sessions.map((s) => [s.file, s]));
        let changed = false;
        for (const item of data.sessions) {
          const existing = sessions.find((x) => x.backendFile === item.file);
          if (!existing) {
            // brand-new session file appeared
            const rec = {
              id: "s" + (++seq),
              file: item.name,
              backendFile: item.file,
              folder: item.folder || "",
              title: item.title || item.name.replace(/\.jsonl$/i, ""),
              sessionId: item.sessionId,
              mtime: item.mtime,
              loaded: false,
              _loading: false,
            };
            sessions.unshift(rec);
            changed = true;
            loadSession(rec, true);
          } else if (existing.mtime !== item.mtime) {
            // file changed on disk → refresh content
            existing.mtime = item.mtime;
            existing.loaded = false;
            changed = true;
            const wasSelected = selectedId === existing.id;
            loadSession(existing, true).then(() => {
              // if the user is looking at this session, repaint the chat too
              if (wasSelected) renderChat();
            });
          }
        }
        if (changed) {
          renderSidebar();
          if (!searchPanel.hidden) { buildIndex(); renderSearch(); }
        }
      } catch (e) {}
    }, 8000);
  }

  /* ---------- settings modal ---------- */
  const settingsRoot = $("#settingsRoot");
  const settingsDir = $("#settingsDir");
  const settingsId = $("#settingsId");
  const settingsStatus = $("#settingsStatus");
  let settingsBusy = false;

  function openSettings() {
    settingsStatus.textContent = "";
    settingsStatus.className = "modal-status";
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg) => {
        settingsDir.value = cfg.sessionDir || "";
        settingsId.value = cfg.sessionId || "";
      })
      .catch(() => {
        settingsStatus.textContent = "后端不可达，仅可手动导入";
        settingsStatus.className = "modal-status err";
        settingsDir.value = "C:\\Users\\sorye\\.claude\\projects";
      });
    settingsRoot.hidden = false;
  }
  function closeSettings() {
    settingsRoot.hidden = true;
  }

  async function saveSettings() {
    if (settingsBusy) return;
    settingsBusy = true;
    settingsStatus.textContent = "保存中…";
    settingsStatus.className = "modal-status";
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionDir: settingsDir.value, sessionId: settingsId.value }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      settingsStatus.textContent = "已保存，正在扫描会话…";
      const count = await loadAllFromBackend();
      settingsStatus.textContent = count ? `已加载 ${count} 个会话` : "目录下未发现会话文件";
      if (count) { preloadAll(); setTimeout(closeSettings, 800); }
    } catch (e) {
      settingsStatus.textContent = "保存失败：" + (e.message || e);
      settingsStatus.className = "modal-status err";
    } finally {
      settingsBusy = false;
    }
  }

  $("#settingsBtn").addEventListener("click", openSettings);
  $("#settingsClose").addEventListener("click", closeSettings);
  $("#settingsCancel").addEventListener("click", closeSettings);
  $("#settingsSave").addEventListener("click", saveSettings);
  settingsRoot.addEventListener("click", (e) => { if (e.target === settingsRoot) closeSettings(); });

  /* ---------- init ---------- */
  renderSidebar();
  renderChat();
  (async () => {
    const ok = await backendAvailable();
    if (!ok) {
      showLoading("后端不可达，可手动导入 .jsonl 会话文件");
      return;
    }
    await loadAllFromBackend();
    startPolling();
  })();
})();
