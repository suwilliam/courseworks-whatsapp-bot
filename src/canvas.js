// Thin Canvas (CourseWorks) REST client: auth, pagination, caching, and
// formatting helpers that turn Canvas JSON into compact text for the model.
import { config } from "./config.js";

const API = `${config.canvasBaseUrl}/api/v1`;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export class CanvasError extends Error {
  constructor(status, path, body) {
    super(`Canvas ${status} on ${path}: ${body.slice(0, 200)}`);
    this.status = status;
  }
}

function buildUrl(path, params = {}) {
  const url = new URL(path.startsWith("http") ? path : `${API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(`${key}[]`, v));
    else url.searchParams.set(key, value);
  }
  return url.toString();
}

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.split(",").find((part) => part.includes('rel="next"'));
  return match ? match.match(/<([^>]+)>/)[1] : null;
}

/** GET a Canvas endpoint, following pagination up to maxPages. Cached for 5 minutes. */
export async function canvasGet(path, params = {}, { maxPages = 10 } = {}) {
  let url = buildUrl(path, { per_page: 100, ...params });
  const cacheKey = url;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  let results = null;
  for (let page = 0; url && page < maxPages; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${config.canvasToken}` } });
    if (!res.ok) throw new CanvasError(res.status, path, await res.text());
    const data = await res.json();
    if (!Array.isArray(data)) {
      results = data;
      break;
    }
    results = (results || []).concat(data);
    url = nextLink(res.headers.get("link"));
  }
  cache.set(cacheKey, { at: Date.now(), data: results });
  return results;
}

/** Download a file's bytes via the signed URL Canvas returns on file objects. */
export async function canvasDownload(fileUrl) {
  const res = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${config.canvasToken}` },
    redirect: "follow",
  });
  if (!res.ok) throw new CanvasError(res.status, "file download", await res.text());
  return Buffer.from(await res.arrayBuffer());
}

export async function listCourses() {
  const courses = await canvasGet("/courses", {
    enrollment_state: "active",
    include: ["term"],
  });
  const active = courses.filter((c) => c.name && !c.access_restricted_by_date);
  if (!config.courseIds.length) return active;
  return active.filter((c) => config.courseIds.includes(String(c.id)));
}

// ---------- formatting helpers ----------

export function fmtDate(iso) {
  if (!iso) return "no date";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: config.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function htmlToText(html, maxChars = 6000) {
  if (!html) return "";
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
}
