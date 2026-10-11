import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

const list = (value) =>
  (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  canvasBaseUrl: (process.env.CANVAS_BASE_URL || "https://courseworks2.columbia.edu").replace(/\/$/, ""),
  canvasToken: required("CANVAS_API_TOKEN"),
  // Optional allowlist of Canvas course IDs. Empty = every active course.
  courseIds: list(process.env.COURSE_IDS),
  timezone: process.env.TIMEZONE || "America/New_York",

  geminiApiKey: required("GEMINI_API_KEY"),
  model: process.env.GEMINI_MODEL || "gemini-flash-latest",
  fallbackModels: list(
    process.env.GEMINI_FALLBACK_MODELS ||
      "gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-flash-lite-latest,gemini-3.1-flash-lite",
  ),
  thinkingLevel: process.env.GEMINI_THINKING || "low",

  // Paid fallback via Vertex AI (billed to Google Cloud). Leave VERTEX_PROJECT empty to disable.
  vertexProject: process.env.VERTEX_PROJECT || "",
  vertexLocation: process.env.VERTEX_LOCATION || "global",
  vertexModels: list(process.env.VERTEX_MODELS || "gemini-3.5-flash-lite,gemini-3.8-flash"),
  vertexDailyCap: Number(process.env.VERTEX_DAILY_CAP || 20),
  paidFirst: process.env.PAID_FIRST === "true",

  // Messages starting with one of these (case-insensitive) trigger the bot.
  triggers: list(process.env.BOT_TRIGGERS || "!cw,@cw,!bot"),
  // Optional allowlist of WhatsApp group names. Empty = any group.
  allowedGroups: list(process.env.ALLOWED_GROUPS),
  // Answer direct messages without a trigger prefix. Off by default: WhatsApp
  // removes new linked devices that reply 1:1 to non-contacts ("reachout timelock").
  answerDirectMessages: (process.env.ANSWER_DMS || "false") === "true",
  // How many recent chat messages to pass along for follow-up context.
  contextMessages: Number(process.env.CONTEXT_MESSAGES || 8),
};
