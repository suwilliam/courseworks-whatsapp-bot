// WhatsApp front end (Baileys — talks to WhatsApp's websocket directly, no browser).
// Links to a WhatsApp account as a "linked device" (scan a QR code once), listens
// in group chats for trigger-prefixed questions or @mentions, and replies.
import makeWASocket, {
  Browsers,
  DisconnectReason,
  areJidsSameUser,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidStatusBroadcast,
  normalizeMessageContent,
  useMultiFileAuthState,
} from "baileys";
import { rm } from "node:fs/promises";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { config } from "./config.js";
import { answerQuestion, OutOfQuotaError } from "./agent.js";

const AUTH_DIR = ".baileys_auth";
const REPLY_PREFIX = "🎓 ";
const logger = pino({ level: process.env.LOG_LEVEL || "warn" });
const startedAt = Math.floor(Date.now() / 1000);

let sock;
let reconnectDelay = 2000;

// ---------- small in-memory state ----------

// Recent text per chat, for follow-up context ("when is that due?").
const history = new Map();
function remember(chatId, who, text) {
  const list = history.get(chatId) || [];
  list.push(`${who}: ${text.slice(0, 400)}`);
  history.set(chatId, list.slice(-config.contextMessages));
}

const groupNames = new Map();
async function groupName(jid) {
  if (!groupNames.has(jid)) {
    const meta = await sock.groupMetadata(jid).catch(() => null);
    groupNames.set(jid, meta?.subject || "");
  }
  return groupNames.get(jid);
}

const seen = new Set();
function firstTime(id) {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 2000) seen.delete(seen.values().next().value);
  return true;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Serialize work per chat so answers come back in order.
const chatQueues = new Map();
function enqueue(chatId, task) {
  const next = (chatQueues.get(chatId) || Promise.resolve()).then(task, task);
  chatQueues.set(chatId, next.catch(() => {}));
  return next;
}

// ---------- message helpers ----------

function messageText(msg) {
  const m = normalizeMessageContent(msg.message);
  if (!m) return { text: "", mentions: [] };
  const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || "";
  const mentions = m.extendedTextMessage?.contextInfo?.mentionedJid || [];
  return { text, mentions };
}

function stripTrigger(body) {
  const lower = body.trim().toLowerCase();
  const trigger = config.triggers.find((t) => lower.startsWith(t.toLowerCase()));
  return trigger ? body.trim().slice(trigger.length).trim() : null;
}

function mentionsMe(mentions) {
  const me = [sock.user?.id, sock.user?.lid].filter(Boolean);
  return mentions.some((jid) => me.some((mine) => areJidsSameUser(jid, mine)));
}

async function handleMessage(msg) {
  const chatId = msg.key.remoteJid;
  if (!chatId || isJidStatusBroadcast(chatId) || !msg.message) return;
  if (Number(msg.messageTimestamp) < startedAt - 30) return; // skip history replay
  if (!firstTime(msg.key.id)) return;

  const { text, mentions } = messageText(msg);
  if (!text) return;
  const isGroup = isJidGroup(chatId);
  const who = msg.key.fromMe ? (text.startsWith(REPLY_PREFIX) ? "Bot" : "Me") : msg.pushName || "Someone";
  const recentChat = (history.get(chatId) || []).join("\n");
  remember(chatId, who, text);
  if (text.startsWith(REPLY_PREFIX)) return;

  let question = stripTrigger(text);
  let chatName = "DM";
  if (isGroup) {
    chatName = await groupName(chatId);
    if (config.allowedGroups.length && !config.allowedGroups.includes(chatName)) return;
    if (question === null && mentionsMe(mentions)) question = text.replace(/@\d+/g, "").trim();
  } else if (question === null && config.answerDirectMessages && !msg.key.fromMe) {
    question = text.trim();
  }
  if (!question) return;

  enqueue(chatId, async () => {
    console.log(`[${chatName}] Q: ${question}`);
    // WhatsApp hides "typing…" after ~25s, and answers can take longer, so refresh it.
    const typing = () => sock.sendPresenceUpdate("composing", chatId).catch(() => {});
    typing();
    const typingTimer = setInterval(typing, 10_000);
    let answer;
    try {
      answer = await answerQuestion(question, { askedBy: msg.pushName || "a classmate", recentChat });
      console.log(`[${chatName}] A: ${answer.slice(0, 120).replace(/\n/g, " ")}…`);
    } catch (err) {
      console.error("Failed to answer:", err);
      answer =
        err instanceof OutOfQuotaError
          ? "I'm overloaded right now. Try again in a few minutes."
          : "Sorry, something went wrong looking that up. Try again in a minute.";
    }
    clearInterval(typingTimer);
    try {
      // linkPreview: null skips fetching previews for the URLs in answers.
      const sent = await withTimeout(
        sock.sendMessage(chatId, { text: REPLY_PREFIX + answer, linkPreview: null }, { quoted: msg }),
        60_000,
      );
      console.log(`[${chatName}] Sent reply ${sent?.key?.id ?? "(no id)"}`);
    } catch (err) {
      console.error(`[${chatName}] Failed to send reply:`, err);
    }
    await sock.sendPresenceUpdate("paused", chatId).catch(() => {});
  });
}

// ---------- connection ----------

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({}));

  sock = makeWASocket({
    auth: state,
    version,
    logger,
    browser: Browsers.ubuntu("CourseWorks Bot"),
    markOnlineOnConnect: false, // keep phone notifications working
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("Scan this QR code in WhatsApp → Settings → Linked devices → Link a device:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      reconnectDelay = 2000;
      console.log(`Bot ready as ${sock.user?.id}. Triggers: ${config.triggers.join(", ")}`);
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error("Logged out from the phone. Clearing session — restart to scan a new QR code.");
        await rm(AUTH_DIR, { recursive: true, force: true });
        process.exit(1);
      }
      // After a QR scan WhatsApp sends restartRequired and expects an immediate
      // reconnect; waiting lets it drop the new device. Expired QR codes (408
      // before login) aren't failures either, so neither should back off.
      const loggedIn = Boolean(sock.authState.creds.registered);
      if (code === DisconnectReason.restartRequired || (!loggedIn && code === DisconnectReason.timedOut)) {
        console.log(code === DisconnectReason.restartRequired ? "Paired — reconnecting…" : "QR code expired; showing a new one.");
        reconnectDelay = 2000;
        connect();
        return;
      }
      console.warn(`Connection closed (${code ?? "unknown"}); reconnecting in ${reconnectDelay / 1000}s`);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    for (const msg of messages) {
      handleMessage(msg).catch((err) => console.error("Message handler error:", err));
    }
  });
}

connect();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("Shutting down…");
    sock?.end(undefined);
    process.exit(0);
  });
}
