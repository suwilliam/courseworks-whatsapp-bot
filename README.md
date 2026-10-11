# CourseWorks WhatsApp Bot

Answers cohort questions in WhatsApp (assignments, due dates, readings, syllabi, exams, announcements) using live data from Columbia CourseWorks (Canvas) and Google Gemini (free tier).

```
WhatsApp group ──► src/index.js (Baileys)    ──► src/agent.js (Gemini function calling)
                                                          │
                                                          ▼
                                     src/tools.js ──► src/canvas.js ──► CourseWorks API
```

## Setup

1. Node 20+ (installed at `~/.local/node/bin` — add `export PATH="$HOME/.local/node/bin:$PATH"` to `~/.zshrc`).
2. `npm install`
3. Fill in `.env` (see `.env.example`): `CANVAS_API_TOKEN` and `GEMINI_API_KEY` (free from aistudio.google.com).
4. Try it in the terminal: `npm run ask -- "what's due this week?"`
5. Start the bot: `npm start`, then scan the QR code from WhatsApp → Settings → Linked devices. The session is saved in `.baileys_auth/`, so you only scan once.

## Using it

In a group: start a message with `!cw` (or `@cw`, `!bot`), or @-mention the linked account.

- `!cw what's due this week?`
- `!cw when is the stats midterm?`
- `!cw what's the reading for entrepreneurship class 6?`
- `!cw summarize the syllabus grading for UI/UX`

Direct messages to the linked account are answered without a prefix (`ANSWER_DMS=false` to turn off).

## Config (`.env`)

| Var | Purpose |
|---|---|
| `COURSE_IDS` | Comma-separated course IDs to limit the bot to (e.g. only core cohort classes). Empty = all active courses. |
| `ALLOWED_GROUPS` | Exact WhatsApp group names the bot responds in. Empty = any group. |
| `BOT_TRIGGERS` | Prefixes that trigger the bot. |
| `GEMINI_MODEL` | Primary model. Default `gemini-flash-latest`. |
| `GEMINI_FALLBACK_MODELS` | Tried in order when a model is overloaded or out of free quota. |
| `GEMINI_THINKING` | `low` (default, faster) or `high` (slower, more careful). |

## Notes

- The bot sees CourseWorks **as the token owner**: only courses that person is enrolled in. Grades and submissions are never queried.
- Baileys is an unofficial WhatsApp client (no browser; ~100–200 MB RAM). Using it on a spare number is safest; WhatsApp can ban accounts it flags as automated.
- Canvas responses are cached for 5 minutes.
- Free-tier Gemini quotas are per model (e.g. 20 requests/day for the newest Flash). A question uses 3–7 requests, so the bot rotates through several free models and skips any that are exhausted until their quota resets. If all are exhausted it replies that it has hit its free limit.
- On the free tier Google may use prompts to improve its products; don't use it for anything sensitive.

## Running 24/7 on a server

Any Ubuntu 24.04 / Debian 12 server with 1 GB+ RAM — e.g. Oracle Cloud Always Free `VM.Standard.E2.1.Micro` (username `ubuntu`).

1. Create the server with your SSH public key and make sure you can `ssh ubuntu@SERVER_IP`.
2. From this folder on your Mac: `bash deploy/upload.sh ubuntu@SERVER_IP`
   (copies the project and `.env`, installs Node, and starts a systemd service that restarts on crash/reboot).
3. Scan the QR code shown by `sudo journalctl -u courseworks-bot -f -o cat` with the bot's WhatsApp account.

Useful commands on the server:

- Logs: `sudo journalctl -u courseworks-bot -f -o cat`
- Restart: `sudo systemctl restart courseworks-bot`
- Deploy code changes: rerun `bash deploy/upload.sh ubuntu@SERVER_IP` from your Mac.

Stop the bot on your Mac before starting it on the server; one WhatsApp link per bot.
