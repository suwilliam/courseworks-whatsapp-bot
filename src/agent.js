import { GoogleGenAI } from "@google/genai";
import { config } from "./config.js";
import { functionDeclarations, toolsByName } from "./tools.js";

// Free tier (AI Studio key) first; paid Vertex AI only as a fallback.
// We do our own fallback, so the free client doesn't retry on its own.
const free = new GoogleGenAI({ apiKey: config.geminiApiKey, httpOptions: { retryOptions: { attempts: 1 } } });
const paid = config.vertexProject
  ? new GoogleGenAI({ vertexai: true, project: config.vertexProject, location: config.vertexLocation })
  : null;

const MAX_STEPS = 15;
const FREE_TIMEOUT_MS = 20_000; // per free request
const FREE_BUDGET_MS = 25_000;
const FINAL_NUDGE =
  "You've used all your lookups. Answer now from what you found; if the information isn't posted, say so and share the closest relevant thing you did find."; // total free-tier time per question before switching to paid
const PAID_TIMEOUT_MS = 25_000; // Vertex normally answers in 1–4s; a hang gets one retry
const QUESTION_DEADLINE_MS = 3 * 60_000;

const SYSTEM = `You are Exie, the friendly CourseWorks assistant in the Columbia MBAxMS cohort WhatsApp group chat (the name comes from "xMS"). Be warm and upbeat but brief. Only introduce yourself if someone greets you or asks who you are; otherwise skip greetings and go straight to the answer. You answer questions about classes — assignments, due dates, readings, syllabi, exams, announcements and schedules — using live data from CourseWorks (Canvas) via your tools.

How to answer:
- Always look things up with tools rather than guessing. Map the course the user mentions to a course ID with list_courses first.
- Be efficient: call independent tools in parallel in one step. For "what's due" questions, get_upcoming_items already covers every course — don't also list each course's assignments.
- For syllabus questions, try get_syllabus; if that is empty or only links to a PDF, find the PDF with search_files (or list_modules) and read it with read_file.
- Homework and readings are sometimes only described inside lecture slides or PDFs. If an assignment's own description is thin or missing, or a question is about homework/readings/instructions, use search_course_files (with the course_id) and read_file_pages to check the slides. Slides rarely say "due": deadlines appear as "Read …", "Reading", "We will discuss … on 10/8", "Assignment", "Homework" or a schedule table. So search for the topic or title plus words like reading/read/assignment (e.g. "truth decay reading"), not "due date", and try a couple of phrasings before concluding something isn't there. Most questions need 3–6 lookups; if about 8 turn up nothing, stop and say it isn't posted yet (mentioning the most recent related item you did find, with its date).
- For "what's due / what should I read for <day>" questions, "due" includes readings and class prep, not just Canvas assignments. Find each class meeting that day (list_calendar_events), then that session's readings: the event description (it often says "see syllabus"), the syllabus section for that session (search_course_files with the course_id for the session number/title, then read_file_pages), the latest slides, modules and announcements. List them per class.
- For "where is/are …?" questions (readings, slides, cases), give the exact place a student can click to, e.g. "Files › Readings › Class 5. Financing I", "linked in the syllabus on the course home page" or "Library Reserves tab", plus direct links. Use browse_course_files to see menu tabs, links on the course home/syllabus page and folders. Cases are often linked on the home/syllabus page rather than in Files. When asked about "the case" or "the reading" without a session, assume the next upcoming session (check the syllabus schedule), name it, and give its direct link. Never answer just "it's on Canvas".
- Readings are usually in modules, pages, Files folders or the syllabus. Exams may be assignments, calendar events, announcements or only in the syllabus — check more than one source before saying something isn't posted.
- Dates from tools are already in Eastern Time. Slide dates come labeled like "10/8 [Thu Oct 8]": use that weekday, never guess one, and compare dates with today so you don't present past readings or deadlines as upcoming. Say the weekday and time, and flag anything due within 48 hours.
- If CourseWorks genuinely doesn't have the answer, say so plainly and suggest who to ask (professor/TA) — never invent dates, policies or requirements.
- Never share grades, submissions or anything personal about any student.

Formatting (this is WhatsApp, not Markdown):
- Be concise: lead with the answer, a short list if needed, under ~1200 characters unless the question needs more.
- Use *bold* (single asterisks), _italic_, and "• " bullets. No headings, tables, **double asterisks** or [text](url) links — paste bare URLs.`;

// Thrown when no model can answer right now (quota, overload or paid cap).
export class OutOfQuotaError extends Error {}

// Free-tier daily quotas are per model: on 429 cool that model down until its
// quota resets (Google's retryDelay) and try the next free model.
const cooldownUntil = new Map();
function quotaResetMs(err) {
  const match = String(err.message).match(/retryDelay\\?"\s*:\s*\\?"(\d+)s/);
  return match ? Number(match[1]) * 1000 : 60_000;
}

// Daily cap on questions that touch the paid model (resets at midnight ET or on restart).
const paidUsage = { day: "", questions: 0 };
function claimPaidQuestion(ctx) {
  if (ctx.paid) return true;
  const today = new Date().toLocaleDateString("en-US", { timeZone: config.timezone });
  if (paidUsage.day !== today) Object.assign(paidUsage, { day: today, questions: 0 });
  if (paidUsage.questions >= config.vertexDailyCap) return false;
  paidUsage.questions++;
  ctx.paid = true;
  return true;
}

function request(client, model, contents, timeoutMs, { final = false } = {}) {
  const call = client.models.generateContent({
    model,
    contents,
    config: {
      // Vertex rejects text mixed into a turn of tool results, so the "answer now"
      // nudge for the last step goes in the system instruction instead.
      systemInstruction: final ? `${SYSTEM}\n\n${FINAL_NUDGE}` : SYSTEM,
      tools: [{ functionDeclarations }],
      // On the last allowed step, tools are switched off so the model must answer.
      ...(final && { toolConfig: { functionCallingConfig: { mode: "NONE" } } }),
      automaticFunctionCalling: { disable: true },
      thinkingConfig: { thinkingLevel: config.thinkingLevel },
      abortSignal: AbortSignal.timeout(timeoutMs),
    },
  });
  // abortSignal only covers the HTTP request; client/credential setup can hang longer.
  // A hard race guarantees the timeout (the error looks like the SDK's own abort).
  let timer;
  const hardLimit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { name: "AbortError" })), timeoutMs + 1000);
  });
  return Promise.race([call, hardLimit]).finally(() => clearTimeout(timer));
}

/** Set up the Vertex client (credentials, connection) ahead of the first real question. */
export async function warmUpPaid() {
  if (!paid) return;
  const t = Date.now();
  try {
    await paid.models.countTokens({ model: config.vertexModels[0], contents: "hi" });
    console.log(`Vertex AI ready (${Date.now() - t}ms)`);
  } catch (err) {
    console.warn(`Vertex AI warm-up failed: ${err.status ?? err.name} ${String(err.message).slice(0, 120)}`);
  }
}

// Overloaded (5xx), timed out or a network blip: often fine a moment later.
// Quota (429) and request/auth errors (other 4xx) won't fix themselves, so don't retry those.
const isTransient = (err) => !err.status || err.status >= 500;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Free models. Out of quota → next free model. Overloaded, timed out or erroring
// → return null so the caller goes to paid: the other free models are usually busy too.
let freePausedUntil = 0;

async function tryFree(contents, ctx) {
  if (freePausedUntil > Date.now()) return null;
  for (const model of [config.model, ...config.fallbackModels]) {
    if (cooldownUntil.get(model) > Date.now()) continue;
    // A slow free tier shouldn't eat the whole question: cap its total time.
    const remaining = FREE_BUDGET_MS - ctx.freeMs;
    if (remaining < 3000) {
      console.warn("  (free tier too slow for this question — trying paid)");
      return null;
    }
    const started = Date.now();
    try {
      try {
        return await request(free, model, contents, Math.min(FREE_TIMEOUT_MS, remaining), { final: ctx.final });
      } catch (err) {
        const left = FREE_BUDGET_MS - ctx.freeMs - (Date.now() - started);
        if (!isTransient(err) || left < 5000) throw err;
        console.warn(`${model}: ${err.status ?? err.name} — retrying once`);
        await pause(1000);
        return await request(free, model, contents, Math.min(FREE_TIMEOUT_MS, left - 1000), { final: ctx.final });
      }
    } catch (err) {
      if (err.status === 429) {
        cooldownUntil.set(model, Date.now() + quotaResetMs(err));
        console.warn(`${model}: free quota used up; skipping it until reset`);
        continue;
      }
      if (err.status && err.status < 500) {
        // Bad/revoked key or permissions: affects every free model, so pause the
        // free tier for a while and let paid answer instead of failing outright.
        console.error(`Free Gemini rejected the request (${err.status}): ${String(err.message).slice(0, 200)}`);
        freePausedUntil = Date.now() + 10 * 60_000;
      } else {
        console.warn(`${model}: ${err.status ?? err.name} — trying paid`);
      }
      return null;
    } finally {
      ctx.freeMs += Date.now() - started;
    }
  }
  return null;
}

// Vertex only accepts thought signatures it produced itself, so a conversation the
// free API started can't be continued there. Restart from the original question
// (contents[0]); CourseWorks lookups are cached, so redoing them is quick.
function restartFromQuestion(contents, why) {
  if (contents.length > 1) {
    console.warn(`  (restarting question on paid: ${why})`);
    contents.splice(1);
  }
}

async function tryPaid(contents, ctx) {
  let lastErr;
  for (const model of config.vertexModels) {
    try {
      let response;
      try {
        response = await request(paid, model, contents, PAID_TIMEOUT_MS, { final: ctx.final });
      } catch (err) {
        if (err.status === 400 && /thought signature/i.test(err.message) && contents.length > 1) {
          restartFromQuestion(contents, "history from another model");
        } else if (isTransient(err)) {
          console.warn(`paid ${model}: ${err.status ?? err.name} — retrying once`);
          await pause(1500);
        } else {
          throw err;
        }
        response = await request(paid, model, contents, PAID_TIMEOUT_MS, { final: ctx.final });
      }
      const u = response.usageMetadata || {};
      console.log(`  (answered by paid ${model}: ${u.promptTokenCount ?? "?"} in, ${(u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)} out)`);
      return response;
    } catch (err) {
      lastErr = err;
      console.warn(`paid ${model}: ${err.status ?? err.name} ${String(err.message).slice(0, 200)}`);
    }
  }
  throw new OutOfQuotaError(`Paid models failed: ${lastErr?.message}`);
}

async function generate(contents, ctx) {
  // Once a question has used paid, it stays on paid so it finishes quickly.
  // PAID_FIRST=true skips the free tier entirely (e.g. while Cloud credit lasts).
  if (paid && (ctx.paid || config.paidFirst) && claimPaidQuestion(ctx)) return tryPaid(contents, ctx);

  const response = await tryFree(contents, ctx);
  if (response) return response;

  if (!paid) throw new OutOfQuotaError("Free models unavailable and no paid fallback configured.");
  if (!claimPaidQuestion(ctx)) throw new OutOfQuotaError("Daily paid-question cap reached.");
  restartFromQuestion(contents, "switched from free mid-question");
  return tryPaid(contents, ctx);
}

// Fix common Markdown habits that WhatsApp doesn't render.
function toWhatsApp(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^(\s*)[*-] /gm, "$1• ")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1: $2");
}

/**
 * Answer one question. `recentChat` is a plain-text transcript of the last few
 * messages so follow-ups like "when is that due?" resolve.
 */
export async function answerQuestion(question, { askedBy = "a classmate", recentChat = "" } = {}) {
  const now = new Date().toLocaleString("en-US", {
    timeZone: config.timezone,
    dateStyle: "full",
    timeStyle: "short",
  });

  const userTurn = [
    `Current date/time: ${now} (${config.timezone})`,
    recentChat && `Recent messages in the chat (for context only):\n${recentChat}`,
    `Question from ${askedBy}:\n${question}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const contents = [{ role: "user", parts: [{ text: userTurn }] }];
  const ctx = { paid: false, freeMs: 0, final: false };
  const deadline = Date.now() + QUESTION_DEADLINE_MS;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (Date.now() > deadline) throw new OutOfQuotaError("Question took too long.");
    ctx.final = step === MAX_STEPS - 1;
    const before = contents.length;
    const response = await generate(contents, ctx);
    if (contents.length < before) step = 0; // restarted on paid: give it a fresh lookup budget

    const calls = response.functionCalls;
    if (!calls?.length) {
      const text = response.text?.trim().replace(/^(🎓\s*)+/u, ""); // the bot adds its own prefix
      return text ? toWhatsApp(text) : "Sorry, I couldn't find an answer to that on CourseWorks.";
    }

    // Echo the model turn back unchanged (it carries thought signatures).
    contents.push(response.candidates[0].content);

    const results = await Promise.all(
      calls.map(async (call) => {
        const tool = toolsByName[call.name];
        const out = tool ? await tool.run(call.args) : `Error: unknown tool ${call.name}`;
        console.log(`  ↳ ${call.name}(${JSON.stringify(call.args).slice(0, 200)})`);
        return { call, out };
      }),
    );

    // Files (e.g. syllabus PDFs) ride inside the function response itself;
    // Vertex AI rejects them as separate parts next to a function response.
    const parts = results.map(({ call, out }) => {
      const text = typeof out === "string" ? out : out.text;
      const functionResponse = { id: call.id, name: call.name, response: { result: text } };
      if (typeof out === "object" && out.inlineData) functionResponse.parts = [{ inlineData: out.inlineData }];
      return { functionResponse };
    });
    contents.push({ role: "user", parts });
  }

  return "Sorry, I couldn't pin that down on CourseWorks. Try asking a more specific question.";
}
