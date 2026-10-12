// Full-text index of course PDFs (slides, handouts, syllabi), so the bot can find
// things like homework that only appears inside lecture slides. Built by
// src/build-index.js; this module loads it (reloading when the file changes)
// and answers keyword searches over individual pages.
import { readFileSync, statSync } from "node:fs";

export const INDEX_PATH = ".content_index/index.json";

const STOPWORDS = new Set(
  "the a an and or of to in on for is are was be with what when where which who how do does did i we our my me you your it this that these those at by from as about any there their have has".split(" "),
);
// Slides rarely say "due": a deadline reads "Read chapter 4 … discuss on 10/8". These words
// match long readings far more often than the slide with the actual date, so ignore them.
const DEADLINE_WORDS = new Set(["due", "date", "dates", "deadline", "deadlines", "dueday"]);

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

const terms = (text) =>
  [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) || [])].filter((t) => t.length > 1 && !STOPWORDS.has(t) && !DEADLINE_WORDS.has(t));

function count(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1 && n < 20; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function snippet(page, lower, term, size = 350) {
  const at = Math.max(0, lower.indexOf(term) - size / 3);
  return (at > 0 ? "…" : "") + page.slice(at, at + size).trim() + (at + size < page.length ? "…" : "");
}

/**
 * Keyword search over every indexed page (BM25), returning the best pages.
 * - Page length is normalized, so a 15-word slide that says "Read chapter 4 of
 *   Truth Decay" beats a long report page that just repeats "Truth Decay".
 * - Pages matching more of the query's terms (and adjacent term pairs) rank higher.
 * - At most PER_DOC_LIMIT hits per document (duplicate uploads count as one), so
 *   one long reading can't crowd out the slides.
 */
const K1 = 1.2;
const B = 0.75;
const PER_DOC_LIMIT = 2;

export function searchPages(query, { courseIds, limit = 8 } = {}) {
  const index = loadIndex();
  if (!index) return { index: null, hits: [] };
  const qTerms = terms(query);
  if (!qTerms.length) return { index, hits: [] };
  const words = query.toLowerCase().match(/[a-z0-9]+/g) || [];
  const bigrams = words.slice(1).map((w, i) => `${words[i]} ${w}`).filter((bg) => bg.split(" ").every((w) => qTerms.includes(w)));

  const files = Object.entries(index.files).filter(([, f]) => !courseIds || courseIds.includes(f.courseId));
  const pages = files.flatMap(([, f]) => f.lower);
  const avgLen = pages.reduce((n, p) => n + p.length, 0) / (pages.length || 1) || 1;

  // Rarer terms count more (idf), so "decode" outweighs "assignment".
  const idf = Object.fromEntries(
    qTerms.map((t) => {
      const df = pages.filter((p) => p.includes(t)).length;
      return [t, Math.log(1 + (pages.length - df + 0.5) / (df + 0.5))];
    }),
  );

  const hits = [];
  for (const [fileId, f] of files) {
    const nameLower = f.name.toLowerCase();
    // Same content uploaded twice (e.g. "RAND_RR2314.pdf" and "Truth Decay RAND_RR2314.pdf") = one document.
    const docKey = `${f.courseId}:${f.pages.length}:${f.pages.reduce((n, p) => n + p.length, 0)}`;
    f.lower.forEach((lower, i) => {
      let score = 0;
      let matched = 0;
      const norm = K1 * (1 - B + (B * Math.max(lower.length, 50)) / avgLen);
      for (const t of qTerms) {
        const tf = count(lower, t);
        if (tf) matched++;
        score += idf[t] * ((tf * (K1 + 1)) / (tf + norm)) + (nameLower.includes(t) ? idf[t] * 0.3 : 0);
      }
      if (!matched) return;
      score *= (matched / qTerms.length) ** 2; // reward covering the whole query
      score *= 1 + 0.5 * bigrams.filter((bg) => lower.includes(bg)).length;
      const best = qTerms.filter((t) => lower.includes(t)).sort((a, b) => idf[b] - idf[a])[0];
      hits.push({ fileId, file: f, docKey, page: i + 1, score, text: snippet(f.pages[i], lower, best) });
    });
  }

  hits.sort((a, b) => b.score - a.score);
  const perDoc = {};
  const top = [];
  for (const h of hits) {
    if ((perDoc[h.docKey] = (perDoc[h.docKey] || 0) + 1) > PER_DOC_LIMIT) continue;
    top.push(h);
    if (top.length === limit) break;
  }
  return { index, hits: top };
}

export function getFile(fileId) {
  return loadIndex()?.files[String(fileId)] || null;
}
