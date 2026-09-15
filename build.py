#!/usr/bin/env python3
"""
build.py — Product Brain corpus -> index.json

Reads corpus/*.md (front-matter + Markdown), splits on ## headings
(falls back to ### when a section is over MAX_TOKENS), keeps tables
and lists atomic, prefixes each chunk with its heading path, derives
metadata, extracts the synonym map from the Glossary, and writes
index.json + synonyms.json for the artifact.

No third-party dependencies.
"""
import json, re, glob, os, sys, hashlib
from collections import Counter

CORPUS_DIR = "corpus"
OUT_INDEX = "index.json"
OUT_SYN = "synonyms.json"
MAX_TOKENS = 800          # approx; 1 token ~ 0.75 words
SKIP_HEADINGS = {"terminology"}   # pure pointer sections — noise for retrieval

# ---------- helpers ----------

def approx_tokens(text):
    return int(len(text.split()) / 0.75)

def parse_frontmatter(md):
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", md, re.S)
    if not m:
        return {}, md
    meta = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta, m.group(2)

def split_sections(body, level):
    """Split markdown body on headings of exactly `level` (## or ###).
    Returns list of (heading_text, content). Content before the first
    heading is returned with heading ''."""
    marker = "#" * level + " "
    parts, cur_head, cur_lines = [], "", []
    for line in body.splitlines():
        if line.startswith(marker) and not line.startswith("#" * (level + 1) + " "):
            parts.append((cur_head, "\n".join(cur_lines).strip()))
            cur_head, cur_lines = line[len(marker):].strip(), []
        else:
            cur_lines.append(line)
    parts.append((cur_head, "\n".join(cur_lines).strip()))
    return [(h, c) for h, c in parts if c or h]

def classify_section(heading):
    h = heading.lower()
    if "quick reference" in h: return "quick_reference"
    if "open question" in h: return "open_questions"
    if "what this document is" in h or h == "overview": return "scope"
    if "depend" in h or "related flow" in h: return "dependencies"
    if "limitation" in h or "gap" in h: return "gaps"
    if "rule" in h or "logic" in h or "business" in h: return "rules"
    if "terminolog" in h or "glossary" in h: return "terminology"
    if "flow" in h or "ux" in h or "journey" in h or "screen" in h: return "flow"
    if "metric" in h or "objective" in h or "behaviour" in h or "behavior" in h or "learning" in h: return "metrics"
    return "body"

RULE_RE = re.compile(r"\bR-\d{2}\b")
GAP_RE = re.compile(r"\bGAP\b|not (yet )?(documented|established|confirmed)|undocumented|unresolved|unsettled", re.I)

def strip_heading_number(h):
    return re.sub(r"^\d+(\.\d+)*\.?\s*", "", h).strip()

# ---------- chunking ----------

def chunk_page(meta, body):
    chunks = []
    title = meta.get("title", meta.get("slug", "untitled"))
    for h2, c2 in split_sections(body, 2):
        if not h2 and not c2:
            continue
        if strip_heading_number(h2).lower() in SKIP_HEADINGS:
            continue
        if approx_tokens(c2) <= MAX_TOKENS or "### " not in c2:
            chunks.append((h2, None, c2))
        else:
            # split on ### ; keep the ## preamble (text before first ###) as its own chunk
            subs = split_sections(c2, 3)
            for h3, c3 in subs:
                if not c3:
                    continue
                chunks.append((h2, h3 or None, c3))
    out = []
    for i, (h2, h3, content) in enumerate(chunks):
        path = [title]
        if h2: path.append(h2)
        if h3: path.append(h3)
        path_str = " > ".join(path)
        text = f"[{path_str}]\n{content}"
        cid = hashlib.sha1((meta["slug"] + "|" + path_str).encode()).hexdigest()[:10]
        out.append({
            "id": cid,
            "slug": meta["slug"],
            "page": title,
            "section": meta.get("section", ""),
            "owner": meta.get("owner", ""),
            "notion_url": meta.get("notion_url", ""),
            "heading_path": path_str,
            "h2": h2, "h3": h3,
            "section_type": classify_section(h3 or h2),
            "rule_ids": sorted(set(RULE_RE.findall(content))),
            "has_gap": bool(GAP_RE.search(content)),
            "tokens": approx_tokens(text),
            "text": text,
        })
    return out

# ---------- synonyms from glossary ----------

def extract_synonyms(glossary_md):
    """Parse '| Term | Also written as | ...' tables. Returns {variant_lower: canonical_lower}."""
    syn = {}
    for line in glossary_md.splitlines():
        if not line.startswith("|"): continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 3 or cells[0] in ("Term", "---") or set(cells[0]) <= {"-"}: continue
        term, also = cells[0], cells[1]
        if also in ("—", "", "Also written as"): 
            variants = []
        else:
            variants = [v.strip() for v in re.split(r",|/|·", also) if v.strip()]
        canon = term.lower()
        for v in variants:
            v = v.lower()
            if v != canon and len(v) > 1:
                syn[v] = canon
    # hand-added high-value ones not derivable from the table
    syn.update({
        "round lock": "round lock", "rl": "round lock", "roundlock": "round lock",
        "captain": "captain", "c": "captain", "vc": "vice-captain",
        "subs": "backups", "backup": "backups", "auto sub": "backups", "auto substitutes": "backups",
        "ai teams": "ai team packs", "team pack": "ai team packs", "quick teams": "ai team packs",
        "htp": "how to play", "fantasy points system": "how to play",
        "leaderboard": "leaderboard", "lb": "leaderboard",
        "otp": "otp", "kyc": "kyc",
        "one day trial": "one day trial", "odt": "one day trial", "trial": "one day trial",
        "tie": "ties shared rank", "tied": "ties shared rank", "draw": "ties shared rank",
        "max": "maximum cap limit", "maximum": "cap limit", "limit": "cap maximum", "cap": "limit maximum",
        "cost": "price rs month", "price": "rs month", "how much": "price rs",
        "delete": "delete account deletion", "remove": "delete",
        "substitute": "backups", "substitution": "backups auto-substitution",
        "lineup": "lineups announced", "playing xi": "lineups announced",
        "ads": "ad unit rewarded", "ad": "ad unit", "advert": "ad",
        "join": "contest join", "joins": "contest join",
        "prize": "winnings prize", "winnings": "prize winnings", "win": "winnings",
        "who owns": "owner", "owner": "owner unassigned",
        "how many": "max maximum count number", "many": "max count", "at most": "max cap",
        "visible": "shown", "see": "shown", "shown": "visible",
    })
    return syn

# ---------- BM25 stats ----------

TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9\-\.]*[a-z0-9]|[a-z0-9]")

def stem(t):
    if len(t) <= 3 or t.startswith("r-"): return t
    for suf in ("ies", "es", "s", "ing", "ed"):
        if t.endswith(suf) and len(t) - len(suf) >= 3:
            t = t[:-len(suf)] + ("y" if suf == "ies" else "")
            break
    if len(t) > 4 and t.endswith("e"): t = t[:-1]   # compare/compared -> compar
    return t

def tokenize(text):
    t = text.lower().replace("₹", " rupees ")
    return [stem(x) for x in TOKEN_RE.findall(t)]

def build_bm25(chunks):
    df = Counter()
    for c in chunks:
        toks = set(tokenize(c["text"]))
        df.update(toks)
    N = len(chunks)
    avgdl = sum(len(tokenize(c["text"])) for c in chunks) / N
    return {"N": N, "avgdl": avgdl, "df": dict(df)}

# ---------- main ----------

def main():
    files = sorted(glob.glob(os.path.join(CORPUS_DIR, "*.md")))
    all_chunks, glossary_md = [], ""
    for f in files:
        md = open(f, encoding="utf-8").read()
        meta, body = parse_frontmatter(md)
        meta.setdefault("slug", os.path.splitext(os.path.basename(f))[0])
        if meta["slug"] == "l0-glossary":
            glossary_md = body
        all_chunks.extend(chunk_page(meta, body))

    syn = extract_synonyms(glossary_md)
    bm25 = build_bm25(all_chunks)
    for c in all_chunks:
        c["tf"] = dict(Counter(tokenize(c["text"])))
        c["dl"] = sum(c["tf"].values())

    index = {"built_from": files, "n_chunks": len(all_chunks), "bm25": bm25, "chunks": all_chunks}
    json.dump(index, open(OUT_INDEX, "w", encoding="utf-8"), ensure_ascii=False)
    json.dump(syn, open(OUT_SYN, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    # ---- stats ----
    sizes = [c["tokens"] for c in all_chunks]
    print(f"pages: {len(files)}  chunks: {len(all_chunks)}  synonyms: {len(syn)}")
    print(f"tokens/chunk  min {min(sizes)}  median {sorted(sizes)[len(sizes)//2]}  max {max(sizes)}  over-cap {sum(s>MAX_TOKENS for s in sizes)}")
    per_page = Counter(c["page"] for c in all_chunks)
    for p, n in per_page.most_common(): print(f"  {n:3d}  {p}")
    print("section_type:", dict(Counter(c["section_type"] for c in all_chunks)))
    print("has_gap:", sum(c["has_gap"] for c in all_chunks), " with rule_ids:", sum(bool(c["rule_ids"]) for c in all_chunks))
    print(f"index.json {os.path.getsize(OUT_INDEX)//1024} KB")

if __name__ == "__main__":
    main()
