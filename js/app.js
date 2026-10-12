/* ============================================================
   Agent Console — application logic
   State: sessions (metadata up front, content loaded on demand), selectedId

   Sessions are NOT preloaded. The folder holds 500 MB+ of transcripts (the
   largest is 116 MB), and eagerly fetching them all cost more than the entire
   rest of the app. The list endpoint carries each session's title and message
   counts from the server's own index, so the sidebar is fully populated without
   a single transcript crossing the wire — content arrives only when you open a
   session, or when a search needs it.
   ============================================================ */
(function () {
  "use strict";
  const { escapeHtml, normalize, tokenize, highlight } = window.Highlighter;
  const { parse } = window.SessionParser;

  /* ---------- state ---------- */
  let sessions = [];          // { id, file, title, firstTs, lastTs, stats, messages }
  let selectedId = null;
  let seq = 0;

  // Bump when the parser or the zcode→JSONL bridge changes shape. The cache is
  // otherwise validated on mtime alone, so a format change with an unchanged
  // source file would otherwise serve a stale parse forever. Also bumped to 3
  // when the preload went away: it drops the hundreds of MB of records that the
  // old full-preload left in IndexedDB.
  const CACHE_VER = 3;
  const cacheKey = (rec) => `${CACHE_VER}|${rec.backendFile}`;

  // Above this the parsed record is bigger than any cache is worth: a 116 MB
  // source parses to ~37 MB, and writing one of those into IndexedDB is slower
  // than re-fetching it and can blow the storage quota.
  const MAX_CACHE_SOURCE_BYTES = 4 * 1024 * 1024;

  /* ---------- session sources (Claude Code files | zcode SQLite) ---------- */
  const SRC_KEY = "agent-console.sources";
  const ALL_SOURCES = ["claude", "zcode", "dsh"];
  let sources = new Set(ALL_SOURCES);
  try {
    const saved = JSON.parse(localStorage.getItem(SRC_KEY) || "null");
    if (Array.isArray(saved)) {
      const kept = saved.filter((s) => ALL_SOURCES.includes(s));
      if (kept.length) sources = new Set(kept);
    }
  } catch (e) {}
  let zcodeAvailable = true;
  let dshAvailable = true;
  const sourcesParam = () => Array.from(sources).join(",");

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
    // 优先用会话真实结束时间(lastTs)，缺失时回退 mtime
    if (s.lastTs) {
      return `${fmtDate(s.lastTs)} ${fmtClock(s.lastTs)}`;
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
    // the server ships stats with the list for zcode, so we can show a real
    // count before the transcript is ever fetched
    pill.textContent = (s.loaded || s.stats) ? " · " + (s.stats ? s.stats.total : 0) + " 条" : " · …";
    title.appendChild(pill);

    const meta = document.createElement("div");
    meta.className = "si-meta";
    // strip the routing prefix / extension so the chip shows a bare session id
    const idFull = (s.file || "").replace(/^[a-z]+::/, "").replace(/\.jsonl$/i, "");
    meta.innerHTML =
      `<span class="mono">${escapeHtml(sessionTimeLabel(s))}</span>` +
      `<span class="dot"></span>` +
      sourceBadge(s) +
      `<span class="si-tag" title="${escapeHtml(idFull)}">${escapeHtml(idFull)}</span>`;

    const counts = document.createElement("div");
    counts.className = "si-counts";
    const stat = s.stats;
    const parts = [];
    if (stat && stat.user) parts.push(`<span>${miniSvg("user")} ${stat.user}</span>`);
    if (stat && stat.ai) parts.push(`<span>${miniSvg("ai")} ${stat.ai}</span>`);
    if (stat && stat.tool) parts.push(`<span>${miniSvg("tool")} ${stat.tool}</span>`);
    counts.innerHTML = parts.join("");

    li.append(title, meta, counts);
    // zcode sessions live in the zcode app's own database — this console is a
    // read-only observer of it, so no delete affordance at all
    if (s.deletable !== false) {
      const del = document.createElement("button");
      del.className = "si-del";
      del.textContent = "✕";
      del.title = "删除该会话";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        removeSession(s.id);
      });
      li.appendChild(del);
    }
    li.addEventListener("click", () => selectSession(s.id));
    return li;
  }

  // source tag for non-default backends; '' for claude keeps rows clean
  function sourceBadge(s) {
    if (!s.source || s.source === "claude") return "";
    return `<span class="src-badge src-${escapeHtml(s.source)}">${escapeHtml(s.source)}</span>`;
  }

  // what you'd paste to get back into this conversation
  function resumeHint(s) {
    if (!s.sessionId) return "";
    // neither zcode nor dsh has a CLI on PATH here that takes a session id
    if (s.source === "zcode" || s.source === "dsh") return s.sessionId;
    return `claude --resume ${s.sessionId}`;
  }

  /* ---------- source switch ---------- */
  const srcSwitch = $("#srcSwitch");

  function syncSourceSwitch() {
    srcSwitch.querySelectorAll(".src-opt").forEach((b) => {
      const on = sources.has(b.dataset.source);
      b.classList.toggle("on", on);
      const unavailable = (b.dataset.source === "zcode" && !zcodeAvailable)
        || (b.dataset.source === "dsh" && !dshAvailable);
      b.disabled = unavailable;
      b.title = unavailable
        ? (b.dataset.source === "dsh" ? "dsh 会话目录不可用，请在配置里检查数据目录" : "zcode 数据库不可用，请在配置里检查数据目录")
        : b.dataset.source === "claude"
          ? "Claude Code 的 .jsonl 会话"
          : b.dataset.source === "dsh"
            ? "dsh（DeepSeek Harness）的 zstd 会话（只读）"
            : "zcode 的 SQLite 会话（只读）";
    });
  }

  function toggleSource(name) {
    if (!ALL_SOURCES.includes(name)) return;
    if (sources.has(name)) {
      // an empty set renders "还没有会话", which would be a lie — keep one on
      if (sources.size === 1) return;
      sources.delete(name);
    } else {
      sources.add(name);
    }
    try { localStorage.setItem(SRC_KEY, JSON.stringify(Array.from(sources))); } catch (e) {}
    syncSourceSwitch();
    loadAllFromBackend();
  }

  srcSwitch.querySelectorAll(".src-opt").forEach((b) => {
    b.addEventListener("click", () => toggleSource(b.dataset.source));
  });

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
  // 折叠正文延迟到展开时才生成。
  // 这些 <pre> 默认 max-height:0，屏幕上根本看不见，但每个都要参与布局，而且
  // 生成前得先 JSON.stringify 再转义。一个 1.8 万条的会话里有 7000+ 个工具调用
  // 和 6000+ 个思考块 —— 每次 renderChat 都在为看不见的内容做几千次字符串拼接。
  // 实测这一项占了大转录渲染耗时的大头，而折叠着的东西本来就没人看。
  function bindCollapsible(wrap, headSel, fill) {
    const head = wrap.querySelector(headSel);
    if (!head) return;
    let filled = false;
    // 搜索结果跳转直接展开时走这条路，不经过 click
    wrap._fill = () => { if (filled) return; filled = true; fill(); };
    head.addEventListener("click", () => {
      if (wrap.classList.contains("open")) { wrap.classList.remove("open"); return; }
      wrap._fill();
      wrap.classList.add("open");
    });
  }

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
      bindCollapsible(wrap, ".thinking-head", () => {
        wrap.querySelector(".thinking-body pre").innerHTML = hl(block.text);
      });
      return wrap;
    }

    if (block.kind === "tool_use") {
      wrap.className = "tool-block";
      const hasResult = block.result != null;
      wrap.innerHTML =
        `<div class="tool-head"><span class="tool-ic">${toolIcon(block.name)}</span>` +
        `<span class="tool-name">${escapeHtml(block.name)}</span>` +
        `<span class="tool-tag">tool</span>` +
        `<span class="tw">›</span></div>` +
        `<div class="tool-input"><pre></pre></div>` +
        (hasResult
          ? `<div class="tool-result"><div class="tr-label ${block.result.is_error ? "tr-err" : "tr-ok"}">` +
            `${block.result.is_error ? "error" : "result"}${block.result.summary ? " · " + escapeHtml(block.result.summary) : ""}</div>` +
            `<pre></pre></div>`
          : "");
      bindCollapsible(wrap, ".tool-head", () => {
        let inputJson = "";
        try { inputJson = JSON.stringify(block.input, null, 2); } catch (e) { inputJson = String(block.input); }
        wrap.querySelector(".tool-input pre").innerHTML = hl(inputJson);
        if (hasResult) wrap.querySelector(".tool-result pre").innerHTML = hl(block.result.content);
      });
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

  function showLoading(text) {
    timeline.innerHTML = "";
    chatTitle.textContent = "正在加载会话…";
    chatMeta.textContent = "";
    $("#chatId").hidden = true;
    $("#cidFile").textContent = "";
    $("#turnRail").hidden = true;
    chatEmpty.style.display = "flex";
    chatEmpty.innerHTML =
      `<div class="empty-ring spin"></div>` +
      `<h2>${escapeHtml(text || "正在加载中…")}</h2>` +
      `<p class="dim">扫描会话文件夹并解析…</p>`;
  }

  // snapshot of the static empty-state markup (restored after a session loads)
  let chatEmptyHTML = null;

  function renderChat(targetMsgId) {
    timeline.innerHTML = "";
    syncToolbar();
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
      $("#turnRail").hidden = true;
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
      $("#turnRail").hidden = true;
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
      const hint = resumeHint(s);
      chatId.hidden = false;
      cidFile.textContent = (s.file || "").replace(/^[a-z]+::/, "").replace(/\.jsonl$/i, "");
      cidFile.title = s.file || "";
      cidCmd.textContent = hint;
      cidCmd.title = hint;
    } else {
      chatId.hidden = true;
      cidFile.textContent = "";
    }

    // Every render rebuilds this subtree from scratch, so the rise animation
    // would replay on every row. Past a few hundred messages that's thousands of
    // concurrent animations — drop them and the render is markedly cheaper.
    timeline.classList.toggle("no-anim", s.messages.length > 300);

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
      // 筛选模式下点击消息 → 回到全部视图并定位到该消息
      if (filter !== "all") {
        row.style.cursor = "pointer";
        row.addEventListener("click", () => {
          msgFilterType = "all";
          syncMsgFilterChips();
          renderChat(mi);
        });
      }

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
    initTurnRail(s);
    // 定位到指定消息（从筛选模式点击回来）
    if (targetMsgId != null) {
      const target = timeline.querySelector(`[data-msgid="${targetMsgId}"]`);
      if (target) {
        chatScroll.scrollTop = target.offsetTop - 60;
        flash(target);
      } else {
        chatScroll.scrollTop = 0;
      }
    } else {
      chatScroll.scrollTop = 0;
    }
  }

  /* ---------- 右侧轮次刻度栏 ---------- */
  // 一根刻度 = 一条用户消息（"人说话"的节点，会话天然的分章位置）。
  //
  // 布局模型照搬 dsh 的 TurnNavigator：**定距 10px 一行**，刻度条固定 20×2，
  // 只用 scaleX 从右端伸缩表示状态。因为每行等高、每条同基准，纵向天然整齐；
  // 之前那版按真实像素偏移等比排、还各画各的宽度，密处叠成一坨、疏处空一大截。
  // 代价是超出封顶高度后要在轨道内滚动（dsh 也是如此），换来的是规整。
  //
  // 刻度数与消息数无关，只等于"轮数"：1.8 万条消息的会话也只有 200 多行。
  const RAIL_SPACING = 10;   // TURN_SPACING_PX
  const RAIL_INSET = 6;      // RAIL_INSET_PX
  const RAIL_FADE = 24;      // FADE_PX
  let railScrollHandler = null;   // 模块级引用，重渲染时先摘掉旧的监听

  function initTurnRail(s) {
    const rail = $("#turnRail");
    const frame = $("#railFrame");
    const scroller = $("#railScroller");
    const track = $("#railTrack");
    const preview = $("#railPreview");
    const promptEl = $("#railPrompt");
    const responseEl = $("#railResponse");
    track.replaceChildren();
    preview.hidden = true;

    const turns = [];
    for (const row of timeline.querySelectorAll(".msg")) {
      const types = row.dataset.types || "";
      if (types.indexOf("user") < 0) continue;
      turns.push({ mi: Number(row.dataset.msgid), row, el: null });
    }
    if (!turns.length) { rail.hidden = true; return; }
    rail.hidden = false;
    // 让开原生滚动条，否则轨道的点击区会盖住它的拖拽
    frame.style.right = `${(chatScroll.offsetWidth - chatScroll.clientWidth) + 12}px`;
    // 封顶高度在这里算成具体像素再交给滚动区。dsh 是在 CSS 里用
    // max-height:inherit 配一个由 var 算出的**长度**；写成百分比的话
    // 父元素高度又是被内容撑开的，解析不出来，轨道就一路撑到 2000+px。
    scroller.style.maxHeight = `${Math.min(420, Math.max(80, chatScroll.clientHeight - 64))}px`;

    // 定距铺开：第 i 行在 RAIL_INSET + i*RAIL_SPACING（dsh 的 paddingStart
    // 是 RAIL_INSET - RAIL_SPACING/2，加上半行高正好落在这个值上）
    const topOf = (i) => RAIL_INSET - RAIL_SPACING / 2 + i * RAIL_SPACING;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < turns.length; i++) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "rail-mark";
      el.style.top = `${topOf(i)}px`;
      el.dataset.turn = i;
      frag.appendChild(el);
      turns[i].el = el;
    }
    track.appendChild(frag);
    track.style.height = `${topOf(Math.max(0, turns.length - 1)) + RAIL_SPACING / 2 + RAIL_INSET}px`;

    /* ---- 滚动位置 ↔ 轮次 ---- */
    // 这一版按行高反推：第 i 行对应内容的 (i+0.5)/n 处。定距轨道无法表达
    // 每轮真实占多少像素，但相邻轮次的对齐误差被限制在半行以内，够用。
    function activeFromScroll() {
      const max = chatScroll.scrollHeight - chatScroll.clientHeight;
      const p = max > 0 ? chatScroll.scrollTop / max : 0;
      setActive(Math.min(turns.length - 1, Math.max(0, Math.round(p * (turns.length - 1)))));
    }
    let activeIdx = -1;
    function setActive(i) {
      if (i === activeIdx) return;
      if (activeIdx >= 0) turns[activeIdx].el.classList.remove("active");
      activeIdx = i;
      turns[activeIdx].el.classList.add("active");
      followActive();
    }
    // 把当前轮的那一行滚到轨道正中；鼠标在轨道上时不抢滚动条 ——
    // 否则手刚移过去就被"跟随"推走（dsh 的 pointerInsideRef 就是这个意思）
    function followActive() {
      if (pointerInside) return;
      const h = scroller.clientHeight;
      if (h <= 0) return;
      const max = scroller.scrollHeight - h;
      if (max <= 0) return;
      const target = Math.max(0, Math.min(max, topOf(activeIdx) + RAIL_SPACING / 2 - h / 2));
      scroller.scrollTop = target;
    }
    function syncFade() {
      const max = scroller.scrollHeight - scroller.clientHeight;
      scroller.classList.toggle("rail-fade-top", max > 0 && scroller.scrollTop > 2);
      scroller.classList.toggle("rail-fade-bottom", max > 0 && scroller.scrollTop < max - 2);
    }
    scroller.addEventListener("scroll", syncFade);

    /* ---- 交互 ---- */
    function scrollToTurn(i) {
      const t = turns[i];
      if (!t) return;
      const tlTop = timeline.getBoundingClientRect().top;
      const offset = t.row.getBoundingClientRect().top - tlTop;
      chatScroll.scrollTop = Math.max(0, offset - 12);
    }

    let pointerInside = false;
    let previewIdx = -1;
    function showPreview(i) {
      if (i === previewIdx) return;
      previewIdx = i;
      const t = turns[i];
      if (!t) { preview.hidden = true; return; }
      const msg = s.messages[t.mi] || {};
      const text = String(msg.text || "").replace(/\s+/g, " ").trim();
      promptEl.textContent = text || "（无文本）";
      // 这一轮的 AI 回复：往后找第一条 assistant 文本
      let reply = "";
      for (let k = t.mi + 1; k < s.messages.length; k++) {
        const m = s.messages[k];
        if (m.kind === "user") break;
        if (m.kind === "assistant") {
          const blk = (m.blocks || []).find((b) => b.kind === "text" && b.text);
          if (blk) { reply = String(blk.text).replace(/\s+/g, " ").trim(); break; }
        }
      }
      responseEl.textContent = reply || "";
      responseEl.hidden = !reply;
      // 贴在光标那一行的旁边，且不越出轨道上下端
      const h = frame.clientHeight;
      const rowTop = topOf(i) + RAIL_SPACING / 2 - scroller.scrollTop;
      const ph = Math.min(100, frame.clientHeight);
      preview.style.top = `${Math.max(0, Math.min(h - ph, rowTop - ph / 2))}px`;
      preview.hidden = false;
      if (previewIdx >= 0 && turns[previewIdx]) turns[previewIdx].el.classList.remove("preview");
      t.el.classList.add("preview");
    }
    function hidePreview() {
      preview.hidden = true;
      if (previewIdx >= 0 && turns[previewIdx]) turns[previewIdx].el.classList.remove("preview");
      previewIdx = -1;
    }

    frame.addEventListener("pointerenter", () => { pointerInside = true; });
    frame.addEventListener("pointerleave", () => { pointerInside = false; hidePreview(); });
    // 悬停出预览（用事件委托，200 多个按钮不各挂一个监听）
    track.addEventListener("pointerover", (e) => {
      const el = e.target.closest(".rail-mark");
      if (el) showPreview(Number(el.dataset.turn));
    });
    track.addEventListener("click", (e) => {
      const el = e.target.closest(".rail-mark");
      if (el) scrollToTurn(Number(el.dataset.turn));
    });

    // 合并到每帧一次；只切两个 class，不读 scrollHeight 再写样式
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; activeFromScroll(); });
    };
    // 摘掉上一轮渲染挂上去的监听（旧代码传新匿名函数给 removeEventListener，
    // 等于从没摘掉过，每渲染一次就多积一个）
    if (railScrollHandler) chatScroll.removeEventListener("scroll", railScrollHandler);
    railScrollHandler = onScroll;
    chatScroll.addEventListener("scroll", onScroll);

    activeFromScroll();
    // 首次把当前轮滚到正中，并同步遮罩状态
    requestAnimationFrame(() => { followActive(); syncFade(); });
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

  /* ---------- search ---------- */
  // rg-backed search: the backend greps the whole session folder and returns
  // matching files; results render immediately.
  let searchSeq = 0;
  async function runSearch(query, filter) {
    const q = query.trim();
    if (!q) return [];
    const seq = ++searchSeq;
    const res = await fetch(
      `/api/search?q=${encodeURIComponent(q)}&source=${encodeURIComponent(sourcesParam())}`
    ).catch(() => null);
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    if (!data || !data.sessions) return [];
    if (seq !== searchSeq) return []; // superseded by a newer keystroke

    // The type filter can only be applied to sessions already parsed in memory.
    // It used to fetch + parse every unloaded hit — harmless while the preload
    // kept everything in memory, but with on-demand loading that turns one
    // keystroke into a sequential download of dozens of transcripts, the 116 MB
    // one included. So: verify what we hold, and pass the rest through as
    // unverified file-level hits (flagged, so the UI doesn't claim a type match).
    const items = [];
    if (filter === "all") {
      items.push(...data.sessions);
    } else {
      const byFile = new Map();
      for (const s of sessions) if (s.backendFile) byFile.set(s.backendFile, s);
      for (const item of data.sessions) {
        const existing = byFile.get(item.file);
        if (existing && existing.loaded) {
          if (sessionMatches(existing, q, filter)) items.push(item);
        } else {
          items.push(Object.assign({ typeUnverified: true }, item));
        }
        if (items.length > 200) break;
      }
    }
    return items.map((item) => ({
      sid: item.file,
      backendFile: item.file,
      title: item.title || item.file,
      folder: item.folder || "",
      typeUnverified: !!item.typeUnverified,
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
        const typeLabel = r.typeUnverified
          ? "会话 · 未校验类型"
          : activeFilter === "all"
            ? "会话"
            : { tool: "工具调用", ai: "AI 对话", user: "用户对话", thinking: "思考过程" }[activeFilter] || "会话";
        btn.innerHTML =
          `<div class="sr-title">${escapeHtml(r.title)} <span class="si-tag">${typeLabel}</span></div>` +
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
      // 折叠正文是懒生成的，从搜索结果跳进来要先把内容补上再展开
      if (blk && blk.classList.contains("tool-block")) {
        if (blk._fill) blk._fill();
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
    lines.push(`来源：${s.source === "zcode" ? "zcode" : "Claude Code"}`);
    lines.push(`文件：${(s.file || "").replace(/^[a-z]+::/, "").replace(/\.jsonl$/i, "")}`);
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
    a.download = `${(s.file || "session").replace(/^[a-z]+::/, "").replace(/\.jsonl$/i, "")}.txt`;
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
    // 提到循环外：写在条件里会每行重读一次布局
    const foldTop = chatScroll.getBoundingClientRect().top + 50;
    let best = null;
    for (const r of rows) {
      if (r.getBoundingClientRect().top < foldTop) best = r;
      else break;
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
  // Reflect the current selection on the toolbar buttons. Deleting a zcode
  // session is not on the table — it lives in the zcode app's own database —
  // so the button is disabled rather than allowed to fail with a 400.
  function syncToolbar() {
    const s = sessions.find((x) => x.id === selectedId);
    const canDelete = !!s && !!s.backendFile && s.deletable !== false;
    delBtn.disabled = !canDelete;
    delBtn.title = !s
      ? "删除当前会话文件"
      : s.deletable === false
        ? (s.source === "dsh" ? "dsh 会话为只读" : "zcode 会话为只读，请在 zcode 应用中删除")
        : !s.backendFile
          ? "手动导入的会话不在磁盘上，无法删除"
          : "删除当前会话文件";
  }

  // delete the current session's file (no confirm)
  delBtn.addEventListener("click", async () => {
    const s = sessions.find((x) => x.id === selectedId);
    if (!s || !s.backendFile || s.deletable === false) return;
    const prev = sessions[sessions.indexOf(s) - 1] || sessions[sessions.indexOf(s) + 1] || null;
    try {
      const res = await fetch(`/api/sessions?file=${encodeURIComponent(s.backendFile)}`, { method: "DELETE" });
      if (!res.ok) { alert("删除失败"); return; }
    } catch (e) { alert("后端不可达"); return; }
    // drop from cache + list
    try { await SessionCache.put(cacheKey(s), null); } catch (e) {}
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
  // Entries are keyed `${CACHE_VER}|${file}`, so a version bump orphans every
  // old record rather than reusing it. Purge them once, or the orphans sit in
  // IndexedDB taking up space forever — which matters here, because the old
  // full-preload could have written hundreds of MB.
  async function initCache() {
    try {
      const meta = await SessionCache.getMeta();
      if (meta && meta.cacheVer === CACHE_VER) return;
      await SessionCache.clear();
      await SessionCache.putMeta(Object.assign({}, meta, { cacheVer: CACHE_VER }));
    } catch (e) {}
  }

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
    // keep local drag-dropped imports: they have no backendFile and are not
    // governed by the source switch (which scopes *backends*, not imports)
    const localOnly = sessions.filter((s) => !s.backendFile);
    const prevSelected = (sessions.find((s) => s.id === selectedId) || {}).backendFile || null;

    let res;
    try {
      res = await fetch(`/api/sessions?source=${encodeURIComponent(sourcesParam())}`);
      if (!res.ok) return 0;
    } catch (e) { return 0; }
    const data = await res.json().catch(() => null);
    if (!data || !data.sessions) return 0;

    if (typeof data.zcodeAvailable === "boolean" || typeof data.dshAvailable === "boolean") {
      if (typeof data.zcodeAvailable === "boolean") zcodeAvailable = data.zcodeAvailable;
      if (typeof data.dshAvailable === "boolean") dshAvailable = data.dshAvailable;
      syncSourceSwitch();
    }

    sessions = [];
    selectedId = null;
    renderSidebar();
    renderChat();
    const cachedCounts = { hit: 0, miss: 0 };
    // 先按后端顺序建好数组（后端已按 lastTs 倒序），再并发填充缓存，
    // 保证 sessions 顺序 = 后端排序，不被缓存读取的完成顺序打乱
    const recs = data.sessions.map((item) => ({
      id: "s" + (++seq),
      file: item.name,
      backendFile: item.file,
      folder: item.folder || "",
      title: item.title || item.name.replace(/\.jsonl$/i, ""),
      sessionId: item.sessionId,
      mtime: item.mtime,
      size: item.size || 0,
      lastTs: item.lastTs || "",
      source: item.source || "claude",
      deletable: item.deletable !== false,
      stats: item.stats || null,
      loaded: false,
      _loading: false,
    }));
    sessions = recs.concat(localOnly);
    await Promise.all(recs.map(async (rec) => {
      // restore from cache when the cached mtime matches the current file
      try {
        const cached = await SessionCache.get(cacheKey(rec));
        if (cached && cached.mtime === rec.mtime) {
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
    }));
    renderSidebar();
    showStatsProgress(data.statsPending);
    // keep the user on the same conversation across a source toggle
    const again = prevSelected && sessions.find((s) => s.backendFile === prevSelected);
    if (again) selectSession(again.id);
    else if (sessions.length) selectSession(sessions[0].id);
    return sessions.length;
  }

  // Fetch + parse a single session's full content on demand.
  // Uses a per-session in-flight promise so concurrent callers share one fetch.
  async function loadSession(s, silent) {
    if (s.loaded) return;
    if (s._loading) return; // another caller is loading it; it'll render when done
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
    // persist for next visit — fire-and-forget, never block the UI.
    // Skipped for big files: a 116 MB transcript parses to ~37 MB of objects,
    // which is slower to write than to re-fetch and can blow the storage quota.
    try {
      if (!s.size || s.size <= MAX_CACHE_SOURCE_BYTES) {
        SessionCache.put(cacheKey(s), {
          mtime: s.mtime,
          messages: s.messages,
          stats: s.stats,
          title: s.title,
          firstTs: s.firstTs,
          lastTs: s.lastTs,
          sessionId: s.sessionId,
        }).catch(() => {});
      }
    } catch (e) {}
    if (silent) return;
    renderChat();
    renderSidebar();
    if (!searchPanel.hidden) renderSearch();
  }

  // Progress readout for the server's background stats pass. The message counts
  // arrive asynchronously (see the poll's stats branch below), so this reports
  // how many sessions are still uncounted rather than showing nothing at all.
  const loadProgressEl = $("#loadProgress");
  function showStatsProgress(pending) {
    if (!pending) { loadProgressEl.hidden = true; loadProgressEl.textContent = ""; return; }
    loadProgressEl.hidden = false;
    loadProgressEl.textContent = `统计补齐中 · 剩 ${pending}`;
  }

  // Poll the backend for new/changed sessions. It deliberately does NOT pull
  // transcripts any more: the list carries titles and counts, and content is
  // fetched only for a session the user is actually looking at.
  let pollTimer = null;

  // Watching a session that Claude Code is writing means re-fetching it on every
  // mtime change, and that cost scales with the file. Small transcripts are cheap
  // enough to re-read every tick; a big one is throttled, or watching a long
  // session would pull tens of MB a minute.
  const LIVE_FULL_REFRESH_MAX = 8 * 1024 * 1024;
  const LIVE_BIG_TICKS = 8;   // ~1 min at the 8 s poll interval
  let liveBigTick = 0;
  function liveRefreshDue(rec) {
    if ((rec.size || 0) <= LIVE_FULL_REFRESH_MAX) return true;
    return (++liveBigTick % LIVE_BIG_TICKS) === 0;
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        // must carry the source filter, or a deselected zcode session would
        // look brand-new on every tick and be unshifted straight back in
        const res = await fetch(`/api/sessions?source=${encodeURIComponent(sourcesParam())}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data || !data.sessions) return;
        if ((typeof data.zcodeAvailable === "boolean" && data.zcodeAvailable !== zcodeAvailable) ||
            (typeof data.dshAvailable === "boolean" && data.dshAvailable !== dshAvailable)) {
          if (typeof data.zcodeAvailable === "boolean") zcodeAvailable = data.zcodeAvailable;
          if (typeof data.dshAvailable === "boolean") dshAvailable = data.dshAvailable;
          syncSourceSwitch();
        }
        showStatsProgress(data.statsPending);
        // one lookup table per tick rather than an O(n) scan per item
        const byFile = new Map();
        for (const s of sessions) if (s.backendFile) byFile.set(s.backendFile, s);

        let changed = false;
        for (const item of data.sessions) {
          const existing = byFile.get(item.file);
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
              size: item.size,
              lastTs: item.lastTs || "",
              source: item.source || "claude",
              deletable: item.deletable !== false,
              stats: item.stats || null,
              loaded: false,
              _loading: false,
            };
            sessions.unshift(rec);
            byFile.set(item.file, rec);
            changed = true;
            // No loadSession() here on purpose. This used to fetch every new
            // session in full, and a brand-new session can be 100 MB+ — firing
            // that download from a background tick is exactly the cost we set
            // out to remove. It loads when clicked.
          } else if (existing.mtime !== item.mtime) {
            // the file changed on disk
            existing.mtime = item.mtime;
            existing.size = item.size;
            if (existing.stats == null && item.stats) existing.stats = item.stats;
            changed = true;
            // Re-read it only if the user is actually watching it — that's the
            // session Claude Code is writing right now, and keeping it live is
            // the point of this app. The other 68 just take the new timestamp.
            //
            // Re-reading means re-downloading the whole file, which is nothing
            // for a 1 MB transcript and untenable for a 100 MB one that's still
            // being appended to — so big live sessions refresh on a slower beat.
            // When throttled we leave `loaded` alone: the currently displayed
            // content stays valid, just briefly behind.
            if (existing.id === selectedId && liveRefreshDue(existing)) {
              existing.loaded = false;
              loadSession(existing, true).then(() => {
                if (selectedId === existing.id) renderChat();
              });
            }
          } else if (existing.stats == null && item.stats) {
            // Counts can arrive without the file changing: the server's stats
            // worker fills them in after the fact. This is the branch that
            // actually paints the sidebar's "N 条" column, so without it those
            // rows would sit on "· …" until their mtime happened to change.
            existing.stats = item.stats;
            changed = true;
          }
        }
        if (changed) {
          renderSidebar();
          if (!searchPanel.hidden) renderSearch();
        }
      } catch (e) {}
    }, 8000);
  }

  /* ---------- settings modal ---------- */
  const settingsRoot = $("#settingsRoot");
  const settingsDir = $("#settingsDir");
  const settingsZcodeDir = $("#settingsZcodeDir");
  const settingsZcodeHint = $("#zcodeHint");
  const settingsDshDir = $("#settingsDshDir");
  const settingsDshHint = $("#dshHint");
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
        settingsZcodeDir.value = cfg.zcodeDir || "";
        if (settingsDshDir) settingsDshDir.value = cfg.dshDir || "";
        settingsId.value = cfg.sessionId || "";
        if (cfg.zcodeAvailable === false) {
          settingsZcodeHint.textContent = "该目录下没有找到 db/db.sqlite，zcode 来源将不可用";
        }
        if (settingsDshHint) {
          settingsDshHint.textContent = cfg.dshAvailable === false
            ? "该目录下没有找到 sessions/，dsh 来源将不可用"
            : "指向 dsh 配置目录，内含 sessions/（只读，不写入）";
        }
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
        body: JSON.stringify({
          sessionDir: settingsDir.value,
          zcodeDir: settingsZcodeDir.value,
          sessionId: settingsId.value,
          dshDir: settingsDshDir ? settingsDshDir.value : undefined,
        }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const saved = await res.json().catch(() => ({}));
      if (typeof saved.zcodeAvailable === "boolean") zcodeAvailable = saved.zcodeAvailable;
      if (typeof saved.dshAvailable === "boolean") dshAvailable = saved.dshAvailable;
      syncSourceSwitch();
      settingsStatus.textContent = "已保存，正在扫描会话…";
      const count = await loadAllFromBackend();
      settingsStatus.textContent = count
        ? `已加载 ${count} 个会话（内容按需加载，消息统计由服务端后台补齐）`
        : "目录下未发现会话文件";
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

  /* ---------- API 说明弹窗 ---------- */
  const apiRoot = $("#apiRoot");
  function openApiDoc() {
    const list = $("#apiList");
    const baseEl = $("#apiBase");
    list.innerHTML = '<div class="sr-empty"><div class="big">…</div><div>加载中</div></div>';
    baseEl.textContent = "";
    apiRoot.hidden = false;
    fetch("/api")
      .then((r) => r.json())
      .then((doc) => {
        baseEl.textContent = "base: " + (doc.base || location.origin);
        list.innerHTML = "";
        (doc.endpoints || []).forEach((e) => {
          const item = document.createElement("div");
          item.className = "api-item";
          item.innerHTML =
            `<span class="m ${e.method}">${escapeHtml(e.method)}</span>` +
            `<span class="p">${escapeHtml(e.path)}</span>` +
            `<span class="d">${escapeHtml(e.desc || "")}</span>`;
          list.appendChild(item);
        });
      })
      .catch(() => {
        list.innerHTML = '<div class="sr-empty"><div class="big">✕</div><div>后端不可达</div></div>';
      });
  }
  function closeApiDoc() { apiRoot.hidden = true; }
  $("#apiBtn").addEventListener("click", openApiDoc);
  $("#apiClose").addEventListener("click", closeApiDoc);
  $("#apiDone").addEventListener("click", closeApiDoc);
  apiRoot.addEventListener("click", (e) => { if (e.target === apiRoot) closeApiDoc(); });

  /* ---------- init ---------- */
  syncSourceSwitch();
  renderSidebar();
  renderChat();
  (async () => {
    await initCache();
    const ok = await backendAvailable();
    if (!ok) {
      showLoading("后端不可达，可手动导入 .jsonl 会话文件");
      return;
    }
    await loadAllFromBackend();
    startPolling();
  })();
})();
