import { useState, useEffect, useRef } from "react";

/* ─────────────────────────────────────────────────────────────
   Product Brain Q&A
   index.json + synonyms.json are built by build.py from corpus/*.md.
   Retrieval (BM25 + synonyms + heading-path boost) runs here in the
   browser and mirrors eval/run.py exactly. Generation is Claude Sonnet.
   ───────────────────────────────────────────────────────────── */

const DEFAULT_INDEX_URL = "https://<your-github-user>.github.io/product-brain-rag/index.json";
const DEFAULT_SYN_URL = "https://<your-github-user>.github.io/product-brain-rag/synonyms.json";

const STOP = new Set("the a an is are do does can i my in on of for to what how when which who with and or be it its this that user users".split(" "));
const TOKEN_RE = /[a-z0-9][a-z0-9\-\.]*[a-z0-9]|[a-z0-9]/g;
const K1 = 1.2, B = 0.75, PATH_BOOST = 2.0;

function stem(t) {
  if (t.length <= 3 || t.startsWith("r-")) return t;
  for (const suf of ["ies", "es", "s", "ing", "ed"]) {
    if (t.endsWith(suf) && t.length - suf.length >= 3) {
      t = t.slice(0, -suf.length) + (suf === "ies" ? "y" : "");
      break;
    }
  }
  if (t.length > 4 && t.endsWith("e")) t = t.slice(0, -1);
  return t;
}
function tokenize(text) {
  const t = text.toLowerCase().replace(/₹/g, " rupees ");
  return (t.match(TOKEN_RE) || []).map(stem);
}
function expand(query, syn) {
  const q = query.toLowerCase();
  let toks = tokenize(q).filter((t) => !STOP.has(t));
  const phrases = Object.keys(syn).filter((p) => p.includes(" ")).sort((a, b) => b.length - a.length);
  for (const p of phrases) if (q.includes(p)) toks = toks.concat(tokenize(syn[p]));
  for (const t of [...toks]) if (syn[t]) toks = toks.concat(tokenize(syn[t]));
  return toks;
}
function retrieve(index, syn, query, k = 6) {
  const { N, avgdl, df } = index.bm25;
  const qt = expand(query, syn);
  const idf = (t) => { const n = df[t] || 0; return Math.log(1 + (N - n + 0.5) / (n + 0.5)); };
  const scored = index.chunks.map((c) => {
    let s = 0;
    const pathToks = new Set(tokenize(c.heading_path));
    for (const t of qt) {
      const f = c.tf[t] || 0;
      if (!f) continue;
      let w = idf(t) * (f * (K1 + 1)) / (f + K1 * (1 - B + (B * c.dl) / avgdl));
      if (pathToks.has(t)) w *= PATH_BOOST;
      s += w;
    }
    if ((c.slug === "l0-rules" || c.slug === "l0-glossary") && !["scope", "open_questions"].includes(c.section_type)) s *= 1.25;
    return [s, c];
  });
  scored.sort((a, b) => b[0] - a[0]);
  return scored.filter(([s]) => s > 0).slice(0, k).map(([s, c]) => ({ ...c, score: s }));
}

const SYSTEM = `You answer questions about Dream11's product using ONLY the supplied Product Brain excerpts.

Rules:
- Answer in 2–6 sentences of plain prose. No headers, no bullet lists unless the answer is genuinely a list.
- Cite every factual claim with the chunk id in square brackets, e.g. [c3f9a1b2c4]. Cite the most canonical source first: Layer 0 Cross-cutting Rules or Glossary if present.
- If a chunk mentions a rule ID like R-07, name it.
- If the excerpts explicitly say something is a GAP, not documented, unresolved or unsettled, say so plainly and name the owner if given. Do not fill the gap from general knowledge.
- If the excerpts do not contain the answer, reply exactly: "Not in the docs." followed by one sentence on which page would be the natural home for it.
- Never invent numbers, names, or behaviour not in the excerpts.`;

export default function ProductBrainQA() {
  const [index, setIndex] = useState(null);
  const [syn, setSyn] = useState(null);
  const [loadState, setLoadState] = useState({ status: "idle", msg: "" });
  const [indexUrl, setIndexUrl] = useState(DEFAULT_INDEX_URL);
  const [synUrl, setSynUrl] = useState(DEFAULT_SYN_URL);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [showSetup, setShowSetup] = useState(true);
  const fileRef = useRef();

  async function loadFromUrl() {
    setLoadState({ status: "loading", msg: "Fetching index…" });
    try {
      const [i, s] = await Promise.all([fetch(indexUrl).then((r) => r.json()), fetch(synUrl).then((r) => r.json())]);
      setIndex(i); setSyn(s);
      setLoadState({ status: "ok", msg: `${i.n_chunks} chunks from ${i.built_from.length} pages` });
      setShowSetup(false);
    } catch (e) {
      setLoadState({ status: "error", msg: "Couldn't fetch from that URL. Load the two files from disk instead." });
    }
  }
  async function loadFromFiles(files) {
    const arr = Array.from(files);
    const read = (f) => f.text().then(JSON.parse);
    try {
      let i = null, s = null;
      for (const f of arr) {
        const j = await read(f);
        if (j.chunks) i = j; else s = j;
      }
      if (!i) throw new Error("no index");
      setIndex(i); setSyn(s || {});
      setLoadState({ status: "ok", msg: `${i.n_chunks} chunks from ${i.built_from.length} pages${s ? "" : " (no synonyms file — retrieval will be weaker)"}` });
      setShowSetup(false);
    } catch (e) {
      setLoadState({ status: "error", msg: "Select index.json (and synonyms.json) produced by build.py." });
    }
  }

  async function ask() {
    if (!q.trim() || !index) return;
    setBusy(true); setResult(null);
    const hits = retrieve(index, syn || {}, q, 6);
    if (!hits.length) {
      setResult({ answer: "Not in the docs. No Product Brain section matched the question.", hits: [] });
      setBusy(false); return;
    }
    const excerpts = hits.map((h) => `<chunk id="${h.id}" page="${h.page}" path="${h.heading_path}"${h.rule_ids.length ? ` rules="${h.rule_ids.join(",")}"` : ""}${h.has_gap ? ' gap="true"' : ""}>\n${h.text}\n</chunk>`).join("\n\n");
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, system: SYSTEM,
          messages: [{ role: "user", content: `Question: ${q}\n\nProduct Brain excerpts:\n${excerpts}` }] })
      });
      const data = await r.json();
      const answer = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      setResult({ answer, hits });
    } catch (e) {
      setResult({ answer: "The model call failed. Retrieval below still shows what the docs say.", hits });
    }
    setBusy(false);
  }

  const cited = new Set((result?.answer || "").match(/\[([a-f0-9]{10})\]/g)?.map((m) => m.slice(1, -1)) || []);
  const gapHits = (result?.hits || []).filter((h) => h.has_gap && cited.has(h.id));

  return (
    <div style={S.page}>
      <style>{CSS}</style>
      <header style={S.header}>
        <div style={S.wordmark}>Product Brain</div>
        <div style={S.sub}>Ask the Dream11 product docs. Answers cite the section they came from.</div>
      </header>

      {showSetup ? (
        <section style={S.setup}>
          <div style={S.setupTitle}>Load the index</div>
          <label style={S.label}>index.json URL</label>
          <input style={S.input} value={indexUrl} onChange={(e) => setIndexUrl(e.target.value)} />
          <label style={S.label}>synonyms.json URL</label>
          <input style={S.input} value={synUrl} onChange={(e) => setSynUrl(e.target.value)} />
          <div style={S.row}>
            <button style={S.btn} onClick={loadFromUrl} disabled={loadState.status === "loading"}>Fetch from URL</button>
            <span style={S.or}>or</span>
            <button style={S.btnGhost} onClick={() => fileRef.current.click()}>Choose files from disk</button>
            <input ref={fileRef} type="file" accept=".json" multiple style={{ display: "none" }} onChange={(e) => loadFromFiles(e.target.files)} />
          </div>
          {loadState.msg && <div style={{ ...S.status, color: loadState.status === "error" ? "#9A3B00" : "#3D5A5E" }}>{loadState.msg}</div>}
        </section>
      ) : (
        <div style={S.loaded}>
          <span>{loadState.msg}</span>
          <button style={S.linkBtn} onClick={() => setShowSetup(true)}>change</button>
        </div>
      )}

      <section style={S.ask}>
        <textarea
          style={S.textarea}
          rows={2}
          placeholder={index ? "e.g. Does a Pro user see ads on their 12th join?" : "Load the index first"}
          value={q}
          disabled={!index}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
        />
        <button style={{ ...S.btn, alignSelf: "flex-end" }} onClick={ask} disabled={!index || busy || !q.trim()}>
          {busy ? "Reading…" : "Ask"}
        </button>
      </section>

      {result && (
        <section style={S.answerWrap}>
          {gapHits.length > 0 && (
            <div style={S.gapBanner}>
              This touches something the docs mark as a gap or unresolved.
              {gapHits[0].owner && gapHits[0].owner !== "unassigned" ? ` Owner to ask: ${gapHits[0].owner}.` : " No owner recorded."}
            </div>
          )}
          <div style={S.answer} className="answer">{renderAnswer(result.answer, result.hits)}</div>

          {result.hits.length > 0 && (
            <div style={S.sources}>
              <div style={S.sourcesTitle}>Where this came from</div>
              {result.hits.map((h) => (
                <details key={h.id} style={{ ...S.source, opacity: cited.has(h.id) ? 1 : 0.55 }}>
                  <summary style={S.sourceSummary}>
                    <span style={S.path}>{h.heading_path}</span>
                    <span style={S.meta}>
                      {cited.has(h.id) ? "cited" : "retrieved"}
                      {h.rule_ids.length ? ` · ${h.rule_ids.join(", ")}` : ""}
                      {h.has_gap ? " · flags a gap" : ""}
                    </span>
                  </summary>
                  <pre style={S.pre}>{h.text.replace(/^\[.*?\]\n/, "")}</pre>
                  <a style={S.notion} href={h.notion_url} target="_blank" rel="noreferrer">Open in Notion</a>
                </details>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function renderAnswer(text, hits) {
  const byId = Object.fromEntries(hits.map((h) => [h.id, h]));
  const parts = text.split(/(\[[a-f0-9]{10}\])/g);
  return parts.map((p, i) => {
    const m = p.match(/^\[([a-f0-9]{10})\]$/);
    if (m && byId[m[1]]) {
      const h = byId[m[1]];
      return <a key={i} href={h.notion_url} target="_blank" rel="noreferrer" title={h.heading_path} style={S.cite}>{h.page.replace(/^L0\.\d\s/, "")}</a>;
    }
    return <span key={i}>{p}</span>;
  });
}

const CSS = `
  .answer a:hover { text-decoration-thickness: 2px; }
  details > summary { list-style: none; cursor: pointer; }
  details > summary::-webkit-details-marker { display: none; }
  button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid #1F6F78; outline-offset: 2px; }
  @media (max-width: 560px) { .answer { font-size: 17px !important; } }
`;

const sans = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const serif = "Iowan Old Style, 'Palatino Linotype', Palatino, Georgia, serif";

const S = {
  page: { maxWidth: 720, margin: "0 auto", padding: "40px 20px 80px", background: "#F6F7F4", minHeight: "100vh", color: "#171A1C", fontFamily: sans, boxSizing: "border-box" },
  header: { marginBottom: 28 },
  wordmark: { fontFamily: serif, fontSize: 30, fontWeight: 500, letterSpacing: -0.3 },
  sub: { color: "#5A6367", marginTop: 4, fontSize: 15 },
  setup: { border: "1px solid #D6DBD6", padding: 18, borderRadius: 6, background: "#FFFFFF", marginBottom: 22 },
  setupTitle: { fontWeight: 600, marginBottom: 10 },
  label: { display: "block", fontSize: 12, color: "#5A6367", marginTop: 8 },
  input: { width: "100%", boxSizing: "border-box", padding: "8px 10px", border: "1px solid #C9CFC9", borderRadius: 4, fontFamily: sans, fontSize: 13, background: "#FBFBF9" },
  row: { display: "flex", gap: 10, alignItems: "center", marginTop: 14, flexWrap: "wrap" },
  or: { color: "#8A9194", fontSize: 13 },
  btn: { background: "#1F6F78", color: "#fff", border: "none", padding: "9px 16px", borderRadius: 4, fontSize: 14, cursor: "pointer", fontFamily: sans },
  btnGhost: { background: "transparent", color: "#1F6F78", border: "1px solid #1F6F78", padding: "8px 14px", borderRadius: 4, fontSize: 14, cursor: "pointer", fontFamily: sans },
  linkBtn: { background: "none", border: "none", color: "#1F6F78", cursor: "pointer", fontSize: 13, textDecoration: "underline", padding: 0, marginLeft: 8 },
  status: { marginTop: 10, fontSize: 13 },
  loaded: { fontSize: 13, color: "#5A6367", marginBottom: 14 },
  ask: { display: "flex", flexDirection: "column", gap: 10, marginBottom: 26 },
  textarea: { width: "100%", boxSizing: "border-box", padding: "12px 14px", fontSize: 17, fontFamily: serif, border: "1px solid #C9CFC9", borderRadius: 6, background: "#FFFFFF", resize: "vertical", lineHeight: 1.45 },
  answerWrap: {},
  gapBanner: { background: "#FFF4E0", borderLeft: "3px solid #B3620A", color: "#5C3A0F", padding: "10px 14px", fontSize: 14, marginBottom: 14, borderRadius: "0 4px 4px 0" },
  answer: { fontFamily: serif, fontSize: 19, lineHeight: 1.55, whiteSpace: "pre-wrap", marginBottom: 26 },
  cite: { color: "#1F6F78", textDecoration: "underline", textDecorationThickness: 1, textUnderlineOffset: 3, fontFamily: sans, fontSize: 13, verticalAlign: "baseline", padding: "0 3px" },
  sources: { borderTop: "1px solid #D6DBD6", paddingTop: 16 },
  sourcesTitle: { fontSize: 13, color: "#5A6367", marginBottom: 8 },
  source: { padding: "8px 0", borderBottom: "1px solid #E6E9E6" },
  sourceSummary: { display: "flex", flexDirection: "column", gap: 2 },
  path: { fontSize: 14, color: "#171A1C" },
  meta: { fontSize: 12, color: "#8A9194" },
  pre: { whiteSpace: "pre-wrap", fontFamily: sans, fontSize: 13, lineHeight: 1.5, color: "#3A4245", background: "#FBFBF9", padding: 12, borderRadius: 4, marginTop: 8, maxHeight: 320, overflow: "auto" },
  notion: { fontSize: 12, color: "#1F6F78", display: "inline-block", marginTop: 6 },
};
