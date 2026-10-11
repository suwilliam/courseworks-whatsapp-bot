# Exie: CourseWorks WhatsApp Bot

Exie answers questions in the MBAxMS cohort WhatsApp group (assignments, due dates, readings, syllabi, exams, announcements) using live data from Columbia CourseWorks (Canvas) and Google Gemini. For how classmates use it, see [STUDENT_GUIDE.md](STUDENT_GUIDE.md).

## Architecture

```
WhatsApp group
     │  "!exie what's due this week?"
     ▼
src/index.js ── Baileys: linked-device WhatsApp client (no browser)
     │
     ▼
src/agent.js ── Gemini function-calling loop
     │            free Gemini models first ──► Vertex AI (paid) as fallback
     ▼
src/tools.js ── read-only CourseWorks tools (assignments, syllabus, modules, files, …)
     │
     ▼
src/canvas.js ─ Canvas REST client ──► courseworks2.columbia.edu/api/v1
```

Everything runs as one Node.js process on a small Google Cloud VM, managed by systemd.

## Components

| File | Role |
|---|---|
| `src/index.js` | Connects to WhatsApp as a linked device, filters messages (trigger prefix, @mention, allowed groups), keeps a short per-chat history for follow-ups, answers one question at a time per chat, and reconnects with backoff. |
| `src/agent.js` | Sends the question plus tool definitions to Gemini, runs the tools Gemini asks for, and returns a WhatsApp-formatted answer. Handles model fallback, timeouts and caps. |
| `src/tools.js` | Read-only CourseWorks tools exposed to Gemini. Never queries grades or submissions, and excludes personal planner notes. PDFs are passed to Gemini directly. |
| `src/canvas.js` | Canvas API calls with pagination, a 5-minute cache, Eastern Time date formatting and HTML-to-text. |
| `src/config.js` | Reads settings from `.env`. |
| `src/cli.js` | Ask questions from a terminal without WhatsApp: `npm run ask -- "what's due this week?"` |
| `deploy/` | Server setup script, systemd unit and upload script. |
| `tests/failure-tests.sh` | Recovery and failure tests against the deployed bot. |

## External services

| Service | Used for | Credential |
|---|---|---|
| CourseWorks (Canvas) API | Course data | Personal access token (`CANVAS_API_TOKEN`). The bot sees only that person's courses. |
| WhatsApp (via Baileys) | Sending and receiving messages | A dedicated number, linked by scanning a QR code. Session stored in `.baileys_auth/`. |
| Gemini API, free tier | Default AI model | API key from aistudio.google.com (`GEMINI_API_KEY`) |
| Vertex AI | Paid fallback model | The VM's service account (needs the **Vertex AI User** role and full Cloud API access scope) |
| Google Compute Engine | Hosting | e2-micro VM in a free-tier region (us-east1), Ubuntu 24.04, standard 30 GB disk |

## How a question is answered

1. A message in an allowed group starts with a trigger (`!exie`, `@exie`, `!cw`) or @mentions the bot. Direct messages are answered only when they start with a trigger.
2. The agent calls Gemini with the question, the current date and the last few chat messages. Gemini calls CourseWorks tools (usually 3–7 rounds) and writes the answer.
3. Model selection for each call:
   - **Free models first**, in order (`GEMINI_MODEL`, then `GEMINI_FALLBACK_MODELS`). A model that's out of daily quota (429) is skipped until its quota resets.
   - **Vertex AI** (`VERTEX_MODELS`) takes over when a free model is overloaded (5xx), takes more than 30 seconds, rejects the key, or when every free model is out of quota. Once a question uses Vertex, it stays on Vertex.
   - At most `VERTEX_DAILY_CAP` questions a day use Vertex, and each question gets 3 minutes. Past either limit the bot replies "I'm overloaded right now. Try again in a few minutes."
4. The reply is quoted under the question and starts with 🎓. "Typing…" stays visible while the bot works.

## Configuration (`.env`)

Copy `.env.example` to `.env`. It's in `.gitignore`, so it never goes to GitHub.

| Variable | Purpose | Default |
|---|---|---|
| `CANVAS_API_TOKEN` | CourseWorks personal access token | required |
| `CANVAS_BASE_URL` | Canvas URL | `https://courseworks2.columbia.edu` |
| `GEMINI_API_KEY` | Free-tier Gemini key | required |
| `GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS` | Free models, tried in order | `gemini-flash-latest`, then other Flash models |
| `GEMINI_THINKING` | `low` (faster) or `high` | `low` |
| `VERTEX_PROJECT` | Google Cloud project for the paid fallback. Empty disables it. | empty |
| `VERTEX_LOCATION` / `VERTEX_MODELS` | Vertex region and models | `global`; `gemini-3.5-flash-lite,gemini-3.8-flash` |
| `VERTEX_DAILY_CAP` | Max questions per day that use Vertex | `20` |
| `PAID_FIRST` | `true` sends every question to Vertex first | `false` |
| `BOT_TRIGGERS` | Message prefixes that trigger the bot | `!exie,@exie,!cw` |
| `ALLOWED_GROUPS` | Exact group names the bot answers in. Empty means any group. | empty |
| `ANSWER_DMS` | Answer DMs without a trigger prefix | `false` |
| `COURSE_IDS` | Limit to specific Canvas course IDs. Empty means all active courses. | empty |
| `CONTEXT_MESSAGES` | Recent chat messages passed along for follow-ups | `8` |
| `TIMEZONE` | Timezone for dates | `America/New_York` |

## Running locally

Requires Node 20+.

```
npm install
npm run ask -- "what's due this week?"   # terminal only, no WhatsApp
npm start                                 # full bot; scan the QR code it prints
```

Only one copy of the bot should be linked to WhatsApp at a time, so stop the server's copy before running `npm start` locally.

## Server

The bot runs on a Google Cloud e2-micro VM (1 GB RAM; the bot uses about 50–130 MB):

- **Code location:** `/opt/courseworks-bot`
- **Service:** `courseworks-bot`, running as the `cwbot` user. systemd restarts it 10 seconds after a crash and starts it at boot.
- **Swap:** 2 GB of swap is configured.
- **Login:** SSH as the user from the key added to the VM (`will`).

**Deploy:** from this folder on your Mac. This copies the code and `.env`, installs Node and dependencies, and restarts the service. The WhatsApp session is kept.
```
bash deploy/upload.sh will@SERVER_IP
```

**First-time WhatsApp link:** show the QR code, then scan it from the bot's phone under WhatsApp → Settings → Linked devices.
```
ssh will@SERVER_IP 'sudo journalctl -u courseworks-bot -f -o cat'
```

**Useful commands on the server:**
```
sudo journalctl -u courseworks-bot -f -o cat     # live logs
sudo systemctl restart courseworks-bot           # restart
systemctl status courseworks-bot                 # status and memory
```

The VM's external IP is ephemeral. It survives reboots but changes if the VM is stopped and started.

## Tests

`tests/failure-tests.sh` runs against the deployed bot. It checks that:
- the bot recovers from a crash,
- it falls back to Vertex when the free key is rejected,
- it replies "overloaded" when both AI providers are down,
- it handles a rejected CourseWorks token,
- personal planner notes never reach the chat,
- and it reconnects after a network cut.

```
bash tests/failure-tests.sh will@SERVER_IP            # ~4 min; kills the bot once, cuts its network ~2.5 min
bash tests/failure-tests.sh will@SERVER_IP --quick    # skip the network test (~1 min)
bash tests/failure-tests.sh will@SERVER_IP --reboot   # also reboot the server
```

## Security and limits

- **Secrets:** `.env` and `.baileys_auth/` are excluded from git. On the server, `.env` is readable only by `cwbot`.
- **Read-only access:** the bot only reads CourseWorks and never queries grades or submissions. Questions and course content are sent to Google Gemini.
- **Unofficial client:** Baileys is an unofficial WhatsApp client, so WhatsApp can unlink or ban the number. The bot uses a dedicated number and avoids 1:1 replies to non-contacts by default.
- **Linked-device timeout:** if the bot's phone stays offline for about 14 days, WhatsApp unlinks the bot. It then clears its session and prints a new QR code to scan.
- **In-memory state:** quota cooldowns and the Vertex daily count live in memory and reset when the bot restarts.
