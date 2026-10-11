// Read-only CourseWorks tools exposed to the LLM. Each returns compact text
// (or, for PDFs, { text, inlineData } so the model can read the file itself).
// Deliberately excludes grades/submissions: answers are posted to a group chat
// and should never reveal the token owner's personal data.
import { z } from "zod";
import { config } from "./config.js";
import { canvasGet, canvasDownload, listCourses, fmtDate, htmlToText } from "./canvas.js";

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const courseId = z.number().int().describe("Canvas course ID (from list_courses)");

async function assertCourseAllowed(id) {
  const courses = await listCourses();
  if (!courses.some((c) => c.id === id)) {
    throw new Error(`Course ${id} is not one of the bot's courses. Call list_courses for valid IDs.`);
  }
}

// Validate input, enforce the course allowlist, and turn thrown errors into a
// result the model can read and recover from.
function safeTool({ name, description, inputSchema, run }) {
  const { $schema, ...parameters } = z.toJSONSchema(inputSchema);
  return {
    declaration: { name, description, parametersJsonSchema: parameters },
    run: async (rawInput) => {
      try {
        const input = inputSchema.parse(rawInput ?? {});
        if (input.course_id !== undefined) await assertCourseAllowed(input.course_id);
        const out = await run(input);
        return out === "" ? "No results." : out;
      } catch (err) {
        const hint = err.status === 403 || err.status === 401 ? " (not accessible to this account)" : "";
        return `Error: ${err.message}${hint}`;
      }
    },
  };
}

// Absolute link, minus any per-student "/submissions/<id>" suffix.
const linkFor = (path) =>
  (path.startsWith("http") ? path : `${config.canvasBaseUrl}${path}`).replace(/\/submissions\/\d+$/, "");

const toolList = [
  safeTool({
    name: "list_courses",
    description:
      "List the cohort's active CourseWorks courses with IDs, codes and terms. Call this first to map a course name the user mentions (e.g. 'stats', 'Guetta', 'entrepreneurship') to a course ID.",
    inputSchema: z.object({}),
    run: async () => {
      const courses = await listCourses();
      return courses
        .map((c) => `${c.id} | ${c.course_code} | ${c.name} | ${c.term?.name ?? ""}`)
        .join("\n");
    },
  }),

  safeTool({
    name: "get_upcoming_items",
    description:
      "Everything due or scheduled across ALL courses in a date range (assignments, quizzes, discussions, calendar events). Best tool for 'what's due this week/tomorrow?' questions.",
    inputSchema: z.object({
      start_date: z.string().describe("ISO date, e.g. 2026-10-07"),
      end_date: z.string().describe("ISO date, inclusive end of range"),
    }),
    run: async ({ start_date, end_date }) => {
      const allowed = new Set((await listCourses()).map((c) => c.id));
      const items = await canvasGet("/planner/items", {
        start_date,
        end_date: `${end_date}T23:59:59`,
      });
      return items
        // Course items only: personal planner notes (no course_id) are the token
        // owner's private to-dos and must never reach the group chat.
        .filter((i) => i.course_id && allowed.has(i.course_id) && i.plannable_type !== "planner_note")
        .map((i) => {
          const p = i.plannable || {};
          const when = p.due_at || p.todo_date || p.start_at || i.plannable_date;
          return `• [${i.context_name}] ${p.title || p.name} (${i.plannable_type}) — ${fmtDate(when)}${
            i.html_url ? ` — ${linkFor(i.html_url)}` : ""
          }`;
        })
        .join("\n");
    },
  }),

  safeTool({
    name: "list_assignments",
    description:
      "List assignments in one course with due dates, points and links. Use bucket to narrow (upcoming, past, undated, future) or search_term to match names.",
    inputSchema: z.object({
      course_id: courseId,
      bucket: z.enum(["upcoming", "future", "past", "undated"]).optional(),
      search_term: z.string().optional(),
    }),
    run: async ({ course_id, bucket, search_term }) => {
      const list = await canvasGet(`/courses/${course_id}/assignments`, {
        order_by: "due_at",
        bucket,
        search_term,
      });
      return list
        .map(
          (a) =>
            `• ${a.name} (id ${a.id}) — due ${fmtDate(a.due_at)}` +
            `${a.lock_at ? `, closes ${fmtDate(a.lock_at)}` : ""}` +
            `${a.points_possible != null ? `, ${a.points_possible} pts` : ""}` +
            `, ${(a.submission_types || []).join("/")} — ${a.html_url}`,
        )
        .join("\n");
    },
  }),

  safeTool({
    name: "get_assignment",
    description: "Full details and instructions for one assignment.",
    inputSchema: z.object({ course_id: courseId, assignment_id: z.number().int() }),
    run: async ({ course_id, assignment_id }) => {
      const a = await canvasGet(`/courses/${course_id}/assignments/${assignment_id}`);
      return [
        `${a.name}`,
        `Due: ${fmtDate(a.due_at)}`,
        a.unlock_at && `Opens: ${fmtDate(a.unlock_at)}`,
        a.lock_at && `Closes: ${fmtDate(a.lock_at)}`,
        `Points: ${a.points_possible ?? "n/a"} | Submit via: ${(a.submission_types || []).join(", ")}`,
        a.group_category_id ? "Group assignment" : null,
        `Link: ${a.html_url}`,
        "",
        htmlToText(a.description, 8000) || "(no description)",
      ]
        .filter((x) => x !== null && x !== undefined && x !== false)
        .join("\n");
    },
  }),

  safeTool({
    name: "get_syllabus",
    description:
      "The course's Syllabus page text. Many courses instead post the syllabus as a PDF — if this is empty or only links, use search_files / read_file.",
    inputSchema: z.object({ course_id: courseId }),
    run: async ({ course_id }) => {
      const c = await canvasGet(`/courses/${course_id}`, { include: ["syllabus_body"] });
      return htmlToText(c.syllabus_body, 15000) || "(syllabus page is empty)";
    },
  }),

  safeTool({
    name: "list_modules",
    description:
      "Course modules and their items (weekly sessions, readings, slides, files, pages). Good for 'what's the reading for session 5?'.",
    inputSchema: z.object({ course_id: courseId }),
    run: async ({ course_id }) => {
      const modules = await canvasGet(`/courses/${course_id}/modules`, { include: ["items"] });
      return modules
        .map((m) => {
          const items = (m.items || [])
            .map((it) => {
              const ref = it.page_url
                ? ` [page_url: ${it.page_url}]`
                : it.type === "File"
                  ? ` [file_id: ${it.content_id}]`
                  : it.type === "Assignment"
                    ? ` [assignment_id: ${it.content_id}]`
                    : it.external_url
                      ? ` (${it.external_url})`
                      : "";
              return `   - ${it.title} (${it.type})${ref}`;
            })
            .join("\n");
          return `■ ${m.name}${m.unlock_at ? ` (unlocks ${fmtDate(m.unlock_at)})` : ""}\n${items}`;
        })
        .join("\n");
    },
  }),

  safeTool({
    name: "search_pages",
    description: "Search a course's wiki pages by title. Returns page_url slugs for get_page.",
    inputSchema: z.object({ course_id: courseId, search_term: z.string().optional() }),
    run: async ({ course_id, search_term }) => {
      const pages = await canvasGet(`/courses/${course_id}/pages`, { search_term, sort: "title" });
      return pages.map((p) => `• ${p.title} [page_url: ${p.url}] updated ${fmtDate(p.updated_at)}`).join("\n");
    },
  }),

  safeTool({
    name: "get_page",
    description: "Read the content of one course wiki page.",
    inputSchema: z.object({ course_id: courseId, page_url: z.string().describe("page slug") }),
    run: async ({ course_id, page_url }) => {
      const p = await canvasGet(`/courses/${course_id}/pages/${encodeURIComponent(page_url)}`);
      return `${p.title}\n${p.html_url}\n\n${htmlToText(p.body, 15000)}`;
    },
  }),

  safeTool({
    name: "list_announcements",
    description: "Recent announcements, optionally for specific courses. Instructors often post exam logistics and changes here.",
    inputSchema: z.object({
      course_ids: z.array(z.number().int()).optional().describe("Omit for all courses"),
      days_back: z.number().int().optional().describe("Default 21"),
    }),
    run: async ({ course_ids, days_back = 21 }) => {
      const allowed = (await listCourses()).map((c) => c.id);
      const ids = course_ids?.length ? course_ids.filter((id) => allowed.includes(id)) : allowed;
      const start = new Date(Date.now() - days_back * 86400000).toISOString();
      const items = await canvasGet("/announcements", {
        context_codes: ids.map((id) => `course_${id}`),
        start_date: start,
        end_date: new Date(Date.now() + 86400000).toISOString(),
      });
      return items
        .map((a) => `■ [${a.context_code}] ${a.title} — ${fmtDate(a.posted_at)}\n${htmlToText(a.message, 1500)}`)
        .join("\n\n");
    },
  }),

  safeTool({
    name: "list_calendar_events",
    description:
      "Calendar events (class sessions, exams, review sessions, office hours) for given courses in a date range.",
    inputSchema: z.object({
      course_ids: z.array(z.number().int()).optional().describe("Omit for all courses"),
      start_date: z.string(),
      end_date: z.string(),
    }),
    run: async ({ course_ids, start_date, end_date }) => {
      const allowed = (await listCourses()).map((c) => c.id);
      const ids = course_ids?.length ? course_ids.filter((id) => allowed.includes(id)) : allowed;
      // Canvas caps context_codes at 10 per request.
      const chunks = [];
      for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
      const results = (
        await Promise.all(
          chunks.map((chunk) =>
            canvasGet("/calendar_events", {
              type: "event",
              context_codes: chunk.map((id) => `course_${id}`),
              start_date,
              end_date,
            }),
          ),
        )
      ).flat();
      return results
        .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
        .map(
          (e) =>
            `• [${e.context_name}] ${e.title} — ${fmtDate(e.start_at)}` +
            `${e.location_name ? ` @ ${e.location_name}` : ""}` +
            `${e.description ? `\n   ${htmlToText(e.description, 300)}` : ""}`,
        )
        .join("\n");
    },
  }),

  safeTool({
    name: "search_files",
    description: "Search a course's Files by name (e.g. 'syllabus', 'case', 'reading'). Returns file IDs for read_file.",
    inputSchema: z.object({ course_id: courseId, search_term: z.string().min(2).optional() }),
    run: async ({ course_id, search_term }) => {
      const files = await canvasGet(`/courses/${course_id}/files`, { search_term, sort: "updated_at", order: "desc" });
      return files
        .slice(0, 50)
        .map((f) => `• ${f.display_name} [file_id: ${f.id}] ${f["content-type"]}, ${Math.round(f.size / 1024)} KB`)
        .join("\n");
    },
  }),

  safeTool({
    name: "read_file",
    description: "Read a course file's contents (PDF or text) by file ID — e.g. a syllabus PDF or reading list.",
    inputSchema: z.object({ file_id: z.number().int() }),
    run: async ({ file_id }) => {
      const f = await canvasGet(`/files/${file_id}`);
      const allowed = (await listCourses()).map((c) => c.id);
      if (f.context_type === "Course" && !allowed.includes(f.context_id)) {
        throw new Error("File belongs to a course outside the bot's course list.");
      }
      if (!f.url) return `File is locked or unavailable: ${f.display_name}`;
      if (f.size > MAX_FILE_BYTES) return `File too large to read (${Math.round(f.size / 1e6)} MB). Link: ${f.url}`;
      const type = f["content-type"] || "";
      const bytes = await canvasDownload(f.url);
      if (type === "application/pdf") {
        return {
          text: `File: ${f.display_name} (PDF attached below)`,
          inlineData: { mimeType: "application/pdf", data: bytes.toString("base64") },
        };
      }
      if (type.startsWith("text/") || type.includes("html")) {
        return `File: ${f.display_name}\n\n${htmlToText(bytes.toString("utf8"), 20000)}`;
      }
      return `Can't read ${type} files directly. File: ${f.display_name}`;
    },
  }),
];

export const functionDeclarations = toolList.map((t) => t.declaration);
export const toolsByName = Object.fromEntries(toolList.map((t) => [t.declaration.name, t]));
