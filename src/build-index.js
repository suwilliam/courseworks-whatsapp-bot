// Builds/refreshes the full-text index of course PDFs (see src/content-index.js).
// Runs as its own process (npm run index, or the courseworks-index systemd
// timer) so a huge PDF can never take down the bot. Only new or changed files
// are downloaded; files removed from CourseWorks are dropped from the index.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { canvasDownload, canvasGet, listCourses } from "./canvas.js";
import { INDEX_PATH } from "./content-index.js";

const MAX_BYTES = 60 * 1024 * 1024;
const MAX_PAGE_CHARS = 5000;

function readIndex() {
  try {
    return JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  } catch {
    return { builtAt: null, files: {} };
  }
}

function saveIndex(index) {
  index.builtAt = new Date().toISOString();
  mkdirSync(dirname(INDEX_PATH), { recursive: true });
  writeFileSync(`${INDEX_PATH}.tmp`, JSON.stringify(index));
  renameSync(`${INDEX_PATH}.tmp`, INDEX_PATH); // atomic: the bot never reads a half-written file
}

// Course files via the Files API; courses that hide Files fall back to files linked in modules.
async function courseFiles(courseId) {
  try {
    return await canvasGet(`/courses/${courseId}/files`, {}, { maxPages: 20 });
  } catch (err) {
    if (err.status !== 403 && err.status !== 401) throw err;
    const modules = await canvasGet(`/courses/${courseId}/modules`, { include: ["items"] }).catch(() => []);
    const ids = modules.flatMap((m) => (m.items || []).filter((i) => i.type === "File").map((i) => i.content_id));
    const files = [];
    for (const id of ids) {
      const f = await canvasGet(`/files/${id}`).catch(() => null);
      if (f) files.push(f);
    }
    return files;
  }
}

async function pdfPages(bytes) {
  const doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 }); // silence font warnings
  try {
    const { text } = await extractText(doc, { mergePages: false });
    return text.map((p) => p.replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_CHARS));
  } finally {
    await doc.destroy?.(); // free pdf.js memory where supported
  }
}

const index = readIndex();
const stats = { added: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0, failed: 0 };
const started = Date.now();

for (const course of await listCourses()) {
  let files;
  try {
    files = await courseFiles(course.id);
  } catch (err) {
    console.warn(`[${course.course_code}] can't list files: ${err.message}`);
    continue; // keep whatever we had for this course
  }
  const pdfs = files.filter((f) => f["content-type"] === "application/pdf" || /\.pdf$/i.test(f.display_name || ""));
  const seen = new Set();

  for (const f of pdfs) {
    const id = String(f.id);
    seen.add(id);
    const existing = index.files[id];
    if (existing && existing.updatedAt === f.updated_at) {
      stats.unchanged++;
      continue;
    }
    if (!f.url || f.size > MAX_BYTES) {
      stats.skipped++; // locked, unpublished or too big
      continue;
    }
    try {
      const pages = await pdfPages(await canvasDownload(f.url));
      index.files[id] = {
        courseId: course.id,
        courseName: course.name,
        name: f.display_name,
        updatedAt: f.updated_at,
        pages,
      };
      stats[existing ? "updated" : "added"]++;
      if ((stats.added + stats.updated) % 10 === 0) saveIndex(index);
    } catch (err) {
      stats.failed++;
      console.warn(`[${course.course_code}] ${f.display_name}: ${err.message}`);
    }
  }

  for (const [id, f] of Object.entries(index.files)) {
    if (f.courseId === course.id && !seen.has(id)) {
      delete index.files[id];
      stats.removed++;
    }
  }
}

// Drop courses that are no longer in the bot's course list.
const courseIds = new Set((await listCourses()).map((c) => c.id));
for (const [id, f] of Object.entries(index.files)) {
  if (!courseIds.has(f.courseId)) {
    delete index.files[id];
    stats.removed++;
  }
}

saveIndex(index);
const pages = Object.values(index.files).reduce((n, f) => n + f.pages.length, 0);
console.log(
  `Index refreshed in ${Math.round((Date.now() - started) / 1000)}s: ${Object.keys(index.files).length} files, ${pages} pages ` +
    `(+${stats.added} new, ${stats.updated} updated, ${stats.removed} removed, ${stats.unchanged} unchanged, ` +
    `${stats.skipped} skipped, ${stats.failed} failed)`,
);
