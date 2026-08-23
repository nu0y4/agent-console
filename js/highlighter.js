/* DOM-safe string helpers + query highlighting */
const Highlighter = (() => {
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function normalize(s) {
    return String(s).normalize("NFKC").toLowerCase();
  }

  // Split a search term into tokens on whitespace.
  function tokenize(query) {
    return String(query || "")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  // Highlight every occurrence of any token inside the source text.
  // Escapes HTML first, so it is safe for pre/div injection.
  function highlight(source, query) {
    const tokens = tokenize(query);
    if (!tokens.length) return escapeHtml(source);
    const src = escapeHtml(source);
    const tokenPools = tokens.map((t) => [escapeRegex(t), escapeRegex(normalize(t))]);
    let out = "";
    let i = 0;
    const lower = normalize(src);
    while (i < src.length) {
      let best = -1;
      let bestLen = 0;
      for (const pool of tokenPools) {
        for (const esc of pool) {
          // match case-insensitively against normalized text
          const re = new RegExp(esc, "i");
          const m = re.exec(lower.slice(i));
          if (m && m.index === 0 && m[0].length > bestLen) {
            bestLen = m[0].length;
            best = 0;
          }
        }
      }
      if (best >= 0 && bestLen > 0) {
        out += "<mark>" + src.slice(i, i + bestLen) + "</mark>";
        i += bestLen;
      } else {
        out += src[i];
        i += 1;
      }
    }
    return out;
  }

  function snippet(source, query, maxLen) {
    const clean = String(source || "").replace(/\s+/g, " ").trim();
    const tokens = tokenize(query);
    const needle = tokens.length ? normalize(tokens[0]) : null;
    const idx = needle ? clean.toLowerCase().indexOf(needle) : -1;
    const len = maxLen || 180;
    if (clean.length <= len) return clean;
    let start = idx > 0 ? idx - Math.floor(len * 0.35) : 0;
    start = Math.max(0, start);
    let slice = clean.slice(start, start + len);
    const prefix = start > 0 ? "…" : "";
    const suffix = start + len < clean.length ? "…" : "";
    return prefix + slice + suffix;
  }

  return { escapeHtml, normalize, tokenize, highlight, snippet };
})();

window.Highlighter = Highlighter;
