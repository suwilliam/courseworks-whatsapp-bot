// Full-text index of course PDFs (slides, handouts, syllabi), so the bot can find
// things like homework that only appears inside lecture slides. Built by
// src/build-index.js; this module loads it (reloading when the file changes)
// and answers keyword searches over individual pages.
import { readFileSync, statSync } from "node:fs";

export const INDEX_PATH = ".content_index/index.json";

const STOPWORDS = new Set(
  "the a an and or of to in on for is are was be with what when where which who how do does did i we our my me you your it this that these those at by from as about any there their have has".split(" "),
);

let cache = { mtimeMs: 0, data: null };

export function loadIndex() {
  let mtimeMs;
  try {
    mtimeMs = statSync(INDEX_PATH).mtimeMs;
  } catch {
    return null; // not built yet
  }
  if (mtimeMs !== cache.mtimeMs) {
    const data = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
    // Lowercased copies for searching; originals kept for snippets.
    for (const file of Object.values(data.files)) file.lower = file.pages.map((p) => p.toLowerCase());
    cache = { mtimeMs, data };
  }
  return cache.data;
}

const terms = (text) => [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) || [])].filter((t) => t.length > 1 && !STOPWORDS.has(t));

function count(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1 && n < 20; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function snippet(page, lower, term, size = 350) {
  const at = Math.max(0, lower.indexOf(term) - size / 3);
  return (at > 0 ? "…" : "") + page.slice(at, at + size).trim() + (at + size < page.length ? "…" : "");
}

/** Keyword search over every indexed page; returns the best-matching pages. */
export function searchPages(query, { courseIds, limit = 8 } = {}) {
  const index = loadIndex();
  if (!index) return { index: null, hits: [] };
  const qTerms = terms(query);
  const phrase = query.toLowerCase().trim();
  const files = Object.entries(index.files).filter(([, f]) => !courseIds || courseIds.includes(f.courseId));
  const totalPages = files.reduce((n, [, f]) => n + f.pages.length, 0) || 1;

  // Rarer terms count more (idf), so "decode" outweighs "assignment".
  const idf = Object.fromEntries(
    qTerms.map((t) => {
      const df = files.reduce((n, [, f]) => n + f.lower.filter((p) => p.includes(t)).length, 0);
      return [t, Math.log(1 + totalPages / (1 + df))];
    }),
  );

  const hits = [];
  for (const [fileId, f] of files) {
    const nameLower = f.name.toLowerCase();
    f.lower.forEach((lower, i) => {
      let score = 0;
      for (const t of qTerms) score += Math.min(count(lower, t), 5) * idf[t] + (nameLower.includes(t) ? idf[t] : 0);
      if (phrase.length > 3 && lower.includes(phrase)) score *= 2;
      if (score > 0) {
        const best = qTerms.filter((t) => lower.includes(t)).sort((a, b) => idf[b] - idf[a])[0] || qTerms[0];
        hits.push({ fileId, file: f, page: i + 1, score, text: snippet(f.pages[i], lower, best) });
      }
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return { index, hits: hits.slice(0, limit) };
}

export function getFile(fileId) {
  return loadIndex()?.files[String(fileId)] || null;
}
