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
  const clearBtn = $("#clearBtn");

  let activeFilter = "all";
  let searchResultsState = [];
  let selIdx = -1;

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
    meta.innerHTML =
      `<span class="mono">${escapeHtml(sessionTimeLabel(s))}</span>` +
      `<span class="dot"></span>` +
      `<span class="si-tag">${escapeHtml((s.file || "").replace(/\.jsonl$/i, "").slice(0, 22))}</span>`;

    const counts = document.createElement("div");
    counts.className = "si-counts";
    const stat = s.stats;
    const parts = [];
    if (stat && stat.user) parts.push(`<span>👤 ${stat.user}</span>`);
    if (stat && stat.ai) parts.push(`<span>🤖 ${stat.ai}</span>`);
    if (stat && stat.tool) parts.push(`<span>🔧 ${stat.tool}</span>`);
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

  function groupTitle(label, count) {
    // Claude Code encodes path separators as "--"; make it readable
    const readable = label === "根目录" ? label : label.replace(/--/g, "/");
    const g = document.createElement("div");
    g.className = "sidebar-group";
    g.innerHTML =
      `<span>${escapeHtml(readable)}</span>` +
      `<span class="gcount">${count}</span>` +
      `<span class="gsep"></span>`;
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
        byFolder.get(f).forEach((s) => sessionList.appendChild(sessionItemEl(s)));
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
      return;
    }

    // lazy-load: metadata-only session not parsed yet → placeholder + fetch
    if (!s.loaded) {
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

    // session id + resume command
    const chatId = $("#chatId");
    const cidFile = $("#cidFile");
    const cidCmd = $("#cidCmd");
    if (s.sessionId) {
      chatId.hidden = false;
      cidFile.textContent = s.file || "";
      cidFile.title = s.file || "";
      cidCmd.textContent = `claude --resume ${s.sessionId}`;
      cidCmd.title = `claude --resume ${s.sessionId}`;
    } else {
      chatId.hidden = true;
      cidFile.textContent = "";
    }

    const frag = document.createDocumentFragment();
    s.messages.forEach((m, mi) => {
      const row = document.createElement("div");
      row.className = "msg";
      row.dataset.msgid = mi;

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
    const fill = $("#scrubFill");
    const thumb = $("#scrubThumb");
    const bubble = $("#scrubBubble");
    const startEl = $("#scrubStart");
    const endEl = $("#scrubEnd");
    const rangeEl = $("#scrubRange");

    // anchor time for earliest message (fall back to session start)
    const ts = s.messages
      .map((m) => m.timestamp)
      .filter(Boolean)
      .sort()[0] || s.firstTs || null;

    const fmt = (t) => (t ? `${fmtDate(t)} ${fmtClock(t)}` : "—");
    startEl.textContent = ts ? fmt(ts) : "会话开始";
    endEl.textContent = s.messages.length
      ? (s.messages[s.messages.length - 1].timestamp ? fmt(s.messages[s.messages.length - 1].timestamp) : "会话结束")
      : "—";

    // per-message timestamps for scrub-time label
    const msgTimes = s.messages.map((m) => m.timestamp);
    const setRange = (p) => {
      // nearest message index by progress → show its timestamp
      const idx = Math.min(msgTimes.length - 1, Math.max(0, Math.round(p * (msgTimes.length - 1))));
      const t = msgTimes[idx];
      rangeEl.textContent = t ? fmt(t) : (ts ? fmt(ts) : "");
    };

    // magnet anchors: evenly spaced message indexes (the ones with a timestamp)
    const magnetIdx = [];
    msgTimes.forEach((t, i) => { if (t) magnetIdx.push(i); });
    const N = magnetIdx.length;
    const MAGNET_RATIO = 0.34; // snap within 34% of the node spacing
    const magnetSnap = (p) => {
      if (N < 2) return p;
      const x = p * (N - 1);           // continuous node-space position
      const nearest = Math.round(x);   // nearest node
      const dist = x - nearest;
      if (Math.abs(dist) <= MAGNET_RATIO) return nearest / (N - 1); // magnetized
      return p;                         // free
    };

    // tick dots on the track, one per timestamped message
    const dotsWrap = $("#scrubDots");
    dotsWrap.innerHTML = "";
    const dotEls = [];
    if (N > 1) {
      for (let i = 0; i < N; i++) {
        const dot = document.createElement("div");
        dot.className = "scrub-dot";
        dot.style.left = `${(i / (N - 1)) * 100}%`;
        dotsWrap.appendChild(dot);
        dotEls.push(dot);
      }
    }
    const setActiveDot = (p) => {
      if (!dotEls.length) return;
      const i = Math.min(N - 1, Math.max(0, Math.round(p * (N - 1))));
      dotEls.forEach((d, di) => d.classList.toggle("active", di === i));
    };

    const rows = timeline.querySelectorAll(".msg");
    const total = rows.length;
    let dragging = false;

    const setBubble = (label) => { bubble.textContent = label; };

    function fromScroll() {
      const max = chatScroll.scrollHeight - chatScroll.clientHeight;
      const p = max > 0 ? chatScroll.scrollTop / max : 0;
      applyPos(p, false);
    }

    function applyPos(p, magnet) {
      p = Math.max(0, Math.min(1, p));
      if (magnet !== false) p = magnetSnap(p);
      fill.style.width = `${p * 100}%`;
      thumb.style.left = `${p * 100}%`;
      setRange(p);
      setActiveDot(p);
    }

    function scrubToP(p, magnet) {
      p = Math.max(0, Math.min(1, p));
      let snapped = false;
      if (magnet !== false) {
        const snappedP = magnetSnap(p);
        snapped = snappedP !== p;
        p = snappedP;
      }
      if (snapped) pulseThumb();
      applyPos(p, false);
      // scroll the chat to the same progress
      const max = chatScroll.scrollHeight - chatScroll.clientHeight;
      chatScroll.scrollTop = max * p;
      // show the message index under the cursor
      const idx = Math.min(total - 1, Math.max(0, Math.round(p * (total - 1))));
      const row = rows[idx];
      if (row) {
        const msgTs = s.messages[idx].timestamp;
        setBubble(row.dataset.msgid !== undefined ? `#${Number(row.dataset.msgid) + 1} ${msgTs ? fmt(msgTs) : ""}` : "");
      }
    }

    // thumb drag
    function pulseThumb() {
      thumb.classList.remove("snap");
      void thumb.offsetWidth; // restart animation
      thumb.classList.add("snap");
      setTimeout(() => thumb.classList.remove("snap"), 90);
    }
    function posFromEvent(clientX) {
      const r = track.getBoundingClientRect();
      return (clientX - r.left) / r.width;
    }
    track.addEventListener("pointerdown", (e) => {
      dragging = true;
      scrub.classList.add("dragging");
      track.setPointerCapture(e.pointerId);
      scrubToP(posFromEvent(e.clientX), false);
    });
    track.addEventListener("pointermove", (e) => {
      if (dragging) scrubToP(posFromEvent(e.clientX), false);
    });
    const endDrag = (e) => {
      dragging = false;
      scrub.classList.remove("dragging");
      // magnetize only on release
      if (e && typeof e.clientX === "number") scrubToP(posFromEvent(e.clientX), true);
    };
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);

    // click anywhere on track also scrubs (with magnet)
    track.addEventListener("click", (e) => {
      if (e.pointerType === "mouse") scrubToP(posFromEvent(e.clientX), true);
    });

    // scroll the chat → move the thumb (one-way lock while dragging)
    const scrollHandler = () => {
      if (dragging) return;
      fromScroll();
    };
    chatScroll.removeEventListener("scroll", scrollHandler);
    chatScroll.addEventListener("scroll", scrollHandler);

    const startP = total ? chatScroll.scrollTop / Math.max(chatScroll.scrollHeight - chatScroll.clientHeight, 1) : 0;
    applyPos(startP);

    scrub.hidden = false;
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

  function runSearch(query, filter) {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const out = [];
    for (const e of index) {
      if (filter === "tool" && e.kind !== "tool") continue;
      if (filter === "ai" && e.kind !== "ai") continue;
      if (filter === "user" && e.kind !== "user") continue;
      if (filter === "thinking" && e.kind !== "thinking") continue;
      const src = normalize(e.text);
      const nTokens = tokens.map(normalize);
      if (nTokens.every((t) => src.includes(t))) out.push(e);
    }
    return out;
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
    searchResults.innerHTML = "";
    const results = runSearch(q, activeFilter);
    searchResultsState = results;

    const mk = (label) => {
      const div = document.createElement("div");
      div.className = "sr-empty";
      div.innerHTML = `<div class="big">⌕</div><div>${label}</div>`;
      searchResults.appendChild(div);
    };

    if (!q.trim()) {
      mk("输入关键词开始全文搜索\n支持 工具 / AI / 用户 / 思考 过滤");
      resultMeta.textContent = "";
      return;
    }
    if (!results.length) {
      mk(`没有匹配 “${escapeHtml(q)}” 的结果`);
      resultMeta.textContent = "0 条结果";
      return;
    }

    const shown = results.slice(0, 60);
    shown.forEach((r, ri) => {
      const btn = document.createElement("button");
      btn.className = "sr-item" + (ri === selIdx ? " sel" : "");
      btn.dataset.ri = ri;
      const s = sessions.find((x) => x.id === r.sid);
      const kindLabel = { tool: "工具调用", ai: "AI 对话", user: "用户对话", thinking: "思考过程" }[r.kind] || "内容";
      btn.innerHTML =
        `<div class="sr-title">${escapeHtml(r.title)} <span class="si-tag">${kindLabel}</span></div>` +
        `<div class="sr-snippet">${highlight(snippet(r.text, q, 220), q)}</div>` +
        `<div class="sr-meta"><span class="mono">${escapeHtml(s ? sessionTimeLabel(s) : "")}</span>` +
        `<span>· ${escapeHtml(s ? s.file : "")}</span></div>`;
      btn.addEventListener("click", () => jumpToResult(ri));
      searchResults.appendChild(btn);
    });

    const total = results.length;
    resultMeta.textContent =
      `${total} 条结果${shown.length < total ? ` · 显示前 ${shown.length} 条` : ""}` +
      ` · 范围 ${sessions.length} 个会话`;
  }

  function jumpToResult(ri) {
    const r = searchResultsState[ri];
    if (!r) return;
    selectSession(r.sid);
    const row = timeline.querySelector(`[data-msgid="${r.midx}"]`);
    if (!row) return;
    closeSearch();
    row.scrollIntoView({ block: "center" });
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

  /* ---------- events ---------- */
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
  clearBtn.addEventListener("click", () => {
    if (!sessions.length) return;
    if (!confirm("清空所有已加载的会话？")) return;
    sessions = [];
    selectedId = null;
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
    if (selEl) selEl.scrollIntoView({ block: "nearest" });
  }

  /* ---------- backend sync ---------- */
  const backendAvailable = () => {
    return new Promise((resolve) => {
      fetch("/api/config")
        .then((r) => (r.ok ? resolve(true) : resolve(false)))
        .catch(() => resolve(false));
    });
  };

  // Load only the session index (metadata) — near-instant. Full content is
  // fetched lazily when a session is opened (see loadSession).
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
    for (const item of data.sessions) {
      sessions.push({
        id: "s" + (++seq),
        file: item.name,
        backendFile: item.file,
        folder: item.folder || "",
        title: item.title || item.name.replace(/\.jsonl$/i, ""),
        sessionId: item.sessionId,
        mtime: item.mtime,
        loaded: false,
        _loading: false,
      });
    }
    renderSidebar();
    if (sessions.length) selectSession(sessions[0].id);
    return sessions.length;
  }

  // Fetch + parse a single session's full content on demand.
  async function loadSession(s) {
    if (s.loaded || s._loading) return;
    s._loading = true;
    renderChat(); // show loading placeholder
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
    renderChat();
    renderSidebar();
    if (!searchPanel.hidden) {
      buildIndex();
      renderSearch();
    }
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
      if (count) setTimeout(closeSettings, 800);
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
  })();
})();
