/* ============================================================
   JSONL session parser
   Parses Claude Code / Claude Agent SDK session transcripts.

   Message shapes handled:
     • user / assistant rows carry { message:{ role, content } }
       - content may be a STRING, or an ARRAY of blocks:
           {type:"text", text} | {type:"thinking", thinking}   (thinking may be
           a string OR SDK-style {thinking:{content, signature}})
           {type:"tool_use", id, name, input}
       - ASSISTANT rows may carry an internal "thinking" field (string) that
         denotes the model's reasoning as a hidden block.
     • tool_result arrives in its OWN row: type:"user", with the field
       toolUseResult:{ tool_use_id, type:"tool_result", content, is_error },
       and sourceToolAssistantUUID pointing at the assistant row that made
       the tool call.  We attach the result to the matching tool_use block.
     • ai-title rows carry the conversation title.
     • system rows carry summary/subtype status events.
   ============================================================ */
const SessionParser = (() => {

  function stripBom(s) { return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }

  function flatText(blocks) {
    const out = [];
    if (typeof blocks === "string") { out.push(blocks); return out; }
    if (!Array.isArray(blocks)) return out;
    const walk = (b) => {
      if (typeof b === "string") { out.push(b); return; }
      if (!b || typeof b !== "object") return;
      if (typeof b.text === "string") { out.push(b.text); return; }
      if (b.content != null) walk(b.content);
    };
    blocks.forEach(walk);
    return out;
  }

  function firstText(input) {
    if (typeof input === "string") return input.trim();
    if (!input || typeof input !== "object") return "";
    const arr = Array.isArray(input) ? input : [input];
    return flatText(arr).join("\n").trim();
  }

  function parse(text, fileName) {
    const lines = stripBom(String(text || "")).split(/\r?\n/).filter((l) => l.trim());
    const messages = [];
    let title = "";
    let sessionId = "";
    let firstTs = null;
    let lastTs = null;

    for (const line of lines) {
      let raw;
      try { raw = JSON.parse(line); } catch (e) { continue; }
      if (!raw || typeof raw !== "object") continue;

      const type = raw.type;
      const ts = raw.timestamp || "";
      if (ts && !firstTs) firstTs = ts;
      if (ts) lastTs = ts;

      if (type === "ai-title") {
        if (raw.title) title = raw.title;
        if (raw.sessionId) sessionId = raw.sessionId;
        continue;
      }

      const msg = raw.message || raw;
      const content = msg.content;

      // --- tool_result carrier row: a "user" row whose content holds a
      //     tool_result block (common for async tools, which also carry
      //     toolUseResult metadata on the row itself). ---
      if (type === "user") {
        const trBlock = Array.isArray(content)
          ? content.find((b) => b && typeof b === "object" && b.type === "tool_result")
          : null;
        if (trBlock) {
        const res = {
          content: flatText(trBlock.content ?? "").join("\n"),
          is_error: !!trBlock.is_error,
          summary: trBlock.summary || "",
        };
        // merge async metadata so the UI can show e.g. "async_launched · agent …"
        if (raw.toolUseResult) {
          const meta = raw.toolUseResult;
          if (meta.status) res.status = meta.status;
          if (meta.agentId) res.agentId = meta.agentId;
          if (meta.isAsync) res.isAsync = true;
        }
        // find the assistant message that produced this tool call
        const srcUuid = raw.sourceToolAssistantUUID || raw.parentUuid || "";
        let attached = false;
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.kind !== "assistant") continue;
          if (srcUuid && m.uuid !== srcUuid) continue;
          for (const b of m.blocks) {
            if (b.kind === "tool_use" && b.id === trBlock.tool_use_id && b.result == null) {
              b.result = res;
              attached = true;
              break;
            }
          }
          if (attached) break;
        }
        if (!attached) {
          messages.push({
            kind: "system", role: "system",
            summary: `工具结果 · ${trBlock.tool_use_id ? trBlock.tool_use_id.slice(0, 8) : ""}`,
            subtype: "tool_result",
            timestamp: ts,
          });
        }
        continue;
      }
      }

      if (type === "user" || type === "assistant") {
        const role = msg.role || (type === "assistant" ? "assistant" : "user");
        const blocks = Array.isArray(content) ? content : (typeof content === "string" ? [content] : []);

        if (type === "user") {
          const parts = [];
          if (typeof content === "string") parts.push(content);
          else if (Array.isArray(content)) {
            for (const b of content) {
              if (typeof b === "string") parts.push(b);
              else if (b && typeof b === "object" && typeof b.text === "string") parts.push(b.text);
            }
          }
          const text = parts.join("\n").trim();
          if (text || raw.isMeta) {
            messages.push({
              kind: "user", role: "user", text,
              isMeta: !!raw.isMeta,
              timestamp: ts, uuid: raw.uuid || "", parentUuid: raw.parentUuid || "",
              cwd: raw.cwd || "", userType: raw.userType || "",
            });
          }
          if (raw.sessionId) sessionId = raw.sessionId;
          continue;
        }

        // assistant
        const blocksOut = [];
        const pendingMap = new Map();

        // model's internal reasoning may live on the row itself (not a content block)
        if (typeof raw.thinking === "string" && raw.thinking.trim()) {
          blocksOut.push({ kind: "thinking", text: raw.thinking, signature: "" });
        }

        for (const b of blocks) {
          if (typeof b === "string") { blocksOut.push({ kind: "text", text: b }); continue; }
          if (!b || typeof b !== "object") continue;
          switch (b.type) {
            case "text":
              blocksOut.push({ kind: "text", text: b.text || "" });
              break;
            case "thinking":
              blocksOut.push({
                kind: "thinking",
                text: firstText(b.thinking ?? b.content ?? ""),
                signature: (b.thinking && b.thinking.signature) || b.signature || "",
              });
              break;
            case "tool_use": {
              const tu = { kind: "tool_use", id: b.id || "", name: b.name || "", input: b.input || null, result: undefined };
              pendingMap.set(tu.id, tu);
              blocksOut.push(tu);
              break;
            }
            case "tool_result": {
              const tuId = b.tool_use_id || "";
              const res = {
                content: flatText(b.content ?? "").join("\n"),
                is_error: !!b.is_error,
                summary: b.summary || "",
              };
              const target = pendingMap.get(tuId);
              if (target) target.result = res;
              else blocksOut.push({ kind: "tool_result", ...res });
              break;
            }
            default:
              blocksOut.push({ kind: "text", text: firstText(b.content ?? "") });
          }
        }

        const nonEmpty = blocksOut.filter((b) => {
          if (b.kind === "text") return b.text && b.text.trim().length;
          return true;
        });

        if (nonEmpty.length) {
          messages.push({
            kind: "assistant", role: "assistant", blocks: nonEmpty,
            timestamp: ts, uuid: raw.uuid || "",
          });
        }
        if (raw.sessionId) sessionId = raw.sessionId;
        continue;
      }

      if (type === "system") {
        const summary = raw.summary || "";
        const sub = raw.subtype || "";
        if (summary || sub) {
          messages.push({
            kind: "system", role: "system",
            summary, subtype: sub, targetRole: raw.message?.role || "",
            messageId: raw.messageId || "",
            timestamp: ts,
          });
        }
        continue;
      }

      // non-core lines (mode, permission-mode, queue-operation, …) — skip
    }

    // stats
    const stats = { tool: 0, ai: 0, user: 0, thinking: 0, total: messages.length };
    for (const m of messages) {
      if (m.kind === "assistant") {
        stats.ai++;
        for (const b of m.blocks) {
          if (b.kind === "thinking") stats.thinking++;
          if (b.kind === "tool_use") stats.tool++;
        }
      } else if (m.kind === "user") stats.user++;
    }

    if (!title) {
      const firstUser = messages.find((m) => m.kind === "user" && m.text && !m.isMeta);
      title = firstUser ? firstUser.text.slice(0, 60) : (fileName || "未命名会话");
    }
    if (!title.trim()) title = fileName || "未命名会话";

    return { messages, title, stats, sessionId, firstTs, lastTs };
  }

  return { parse };
})();

window.SessionParser = SessionParser;
