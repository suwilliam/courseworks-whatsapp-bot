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
const FREE_TIMEOUT_MS = 30_000;
const PAID_TIMEOUT_MS = 60_000;
const QUESTION_DEADLINE_MS = 3 * 60_000;

const SYSTEM = `You are Exie, the friendly CourseWorks assistant in the Columbia MBAxMS cohort WhatsApp group chat (the name comes from "xMS"). Be warm and upbeat but brief. Only introduce yourself if someone greets you or asks who you are; otherwise skip greetings and go straight to the answer. You answer questions about classes — assignments, due dates, readings, syllabi, exams, announcements and schedules — using live data from CourseWorks (Canvas) via your tools.

How to answer:
- Always look things up with tools rather than guessing. Map the course the user mentions to a course ID with list_courses first.
- Be efficient: call independent tools in parallel in one step. For "what's due" questions, get_upcoming_items already covers every course — don't also list each course's assignments.
- For syllabus questions, try get_syllabus; if that is empty or only links to a PDF, find the PDF with search_files (or list_modules) and read it with read_file.
- Homework and readings are sometimes only described inside lecture slides or PDFs. If an assignment's own description is thin or missing, or a question is about homework/readings/instructions, use search_course_files (with the course_id) and read_file_pages to check the slides. Slides rarely say "due": deadlines appear as "Read …", "Reading", "We will discuss … on 10/8", "Assignment", "Homework" or a schedule table. So search for the topic or title plus words like reading/read/assignment (e.g. "truth decay reading"), not "due date", and try a couple of phrasings before concluding something isn't there.
- Readings are usually in modules, pages or the syllabus. Exams may be assignments, calendar events, announcements or only in the syllabus — check more than one source before saying something isn't posted.
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

function request(client, model, contents, timeoutMs) {
  return client.models.generateContent({
    model,
    contents,
    config: {
      systemInstruction: SYSTEM,
      tools: [{ functionDeclarations }],
      automaticFunctionCalling: { disable: true },
      thinkingConfig: { thinkingLevel: config.thinkingLevel },
      abortSignal: AbortSignal.timeout(timeoutMs),
    },
  });
}

// Free models. Out of quota → next free model. Overloaded, timed out or erroring
// → return null so the caller goes to paid: the other free models are usually busy too.
let freePausedUntil = 0;

async function tryFree(contents) {
  if (freePausedUntil > Date.now()) return null;
  for (const model of [config.model, ...config.fallbackModels]) {
    if (cooldownUntil.get(model) > Date.now()) continue;
    try {
      return await request(free, model, contents, FREE_TIMEOUT_MS);
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

async function tryPaid(contents) {
  let lastErr;
  for (const model of config.vertexModels) {
    try {
      let response;
      try {
        response = await request(paid, model, contents, PAID_TIMEOUT_MS);
      } catch (err) {
        if (err.status !== 400 || !/thought signature/i.test(err.message) || contents.length === 1) throw err;
        restartFromQuestion(contents, "history from another model");
        response = await request(paid, model, contents, PAID_TIMEOUT_MS);
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
  if (paid && (ctx.paid || config.paidFirst) && claimPaidQuestion(ctx)) return tryPaid(contents);

  const response = await tryFree(contents);
  if (response) return response;

  if (!paid) throw new OutOfQuotaError("Free models unavailable and no paid fallback configured.");
  if (!claimPaidQuestion(ctx)) throw new OutOfQuotaError("Daily paid-question cap reached.");
  restartFromQuestion(contents, "switched from free mid-question");
  return tryPaid(contents);
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
  const ctx = { paid: false };
  const deadline = Date.now() + QUESTION_DEADLINE_MS;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (Date.now() > deadline) throw new OutOfQuotaError("Question took too long.");
    const response = await generate(contents, ctx);

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

  return "Sorry, that took too many lookups. Try asking a more specific question.";
}
