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
     │                 └── search inside course PDFs ◄── .content_index/ (built by src/build-index.js)
     ▼
src/canvas.js ─ Canvas REST client ──► courseworks2.columbia.edu/api/v1
```

The bot runs as one Node.js process on a small Google Cloud VM, managed by systemd. A separate indexer refreshes a full-text index of course PDFs every 6 hours.

## Components

| File | Role |
|---|---|
| `src/index.js` | Connects to WhatsApp as a linked device, filters messages (trigger prefix, @mention, allowed groups), keeps a short per-chat history for follow-ups, answers one question at a time per chat, and reconnects with backoff. |
| `src/agent.js` | Sends the question plus tool definitions to Gemini, runs the tools Gemini asks for, and returns a WhatsApp-formatted answer. Handles model fallback, timeouts and caps. |
| `src/tools.js` | Read-only CourseWorks tools exposed to Gemini. Never queries grades or submissions, and excludes personal planner notes. PDFs are passed to Gemini directly. |
| `src/build-index.js` | Indexer: extracts the text of course PDFs into `.content_index/index.json`. See [PDF search index](#pdf-search-index). |
| `src/content-index.js` | Loads the index and searches it for the `search_course_files` and `read_file_pages` tools. |
| `src/canvas.js` | Canvas API calls with pagination, a 5-minute cache, Eastern Time date formatting and HTML-to-text. |
| `src/config.js` | Reads settings from `.env`. |
| `src/cli.js` | Ask questions from a terminal without WhatsApp: `npm run ask -- "what's due this week?"` |
| `deploy/` | Server setup script, systemd unit and upload script. |
| `tests/failure-tests.sh` | Recovery and failure tests against the deployed bot. |

## External services

| Service | Used for | Credential |
|---|---|---|
| CourseWorks (Canvas) API | Course data | Will's personal access token (`CANVAS_API_TOKEN`). The bot sees CourseWorks exactly as Will does, so only Will's courses. |
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
4. The reply is quoted under the question and starts with 🎓. "Typing…" stays visible while the bot works. If an answer takes more than 30 seconds, Exie first posts a one-time "Still looking, give me a few more seconds…". Failed AI calls are retried once before falling back, which students don't see.

## PDF search index

Some homework and readings appear only inside lecture slides, not in the assignment itself. The indexer makes the text of course PDFs searchable so Exie can find it.

### What is stored

`.content_index/index.json` holds the **full text of every page** of each course PDF, tagged with its course, file name, CourseWorks file ID and page number. **No PDF files are stored.** Each PDF is downloaded into memory, its text extracted, then discarded. Images, diagrams and layout aren't kept. Current size: about 350 PDFs, 4,500 pages, 5 MB.

### How it's built (`src/build-index.js`)

1. For each course, list its files through the Canvas Files API. Courses that hide Files fall back to files linked in modules.
2. Keep PDFs only, and skip any file whose `updated_at` hasn't changed since the last run.
3. Download each new or changed PDF and extract its text page by page with `unpdf` (pdf.js).
4. Remove files that were deleted from CourseWorks, or whose course is no longer in the bot's list.
5. Save atomically (write a temp file, then rename), so the bot never reads a half-written index. Progress is also saved every 10 files.

It runs as its own process, separate from the bot, at low priority with a 700 MB memory cap. Opening a large PDF can take about 300 MB, and this way it can't affect the bot.

| Run | Duration |
|---|---|
| Routine refresh, nothing new | ~12 s |
| Each new or changed PDF | +2–10 s |
| First full build (empty index) | ~18 min |

**Schedule:** the `courseworks-index` systemd timer runs it 5 minutes after boot and every 6 hours. A deploy also starts a refresh. To refresh by hand, run `npm run index` locally or `sudo systemctl start courseworks-index` on the server.

### How it's searched (`src/content-index.js`)

The bot loads `index.json` into memory and reloads it whenever the file changes.

**`search_course_files(query, course_id?)`:**
1. Splits the query into keywords and drops filler words.
2. Scans every page's text for them, and scores each page:
   - **Rarity:** rare words count more than common ones, so "decode" outweighs "assignment" (IDF weighting).
   - **File name:** a keyword in the file name adds a bonus.
   - **Exact phrase:** a page containing the whole query phrase scores double.
3. Returns the top 8 pages, each with an excerpt, file ID and page number.

**`read_file_pages(file_id, pages)`** returns the full text of specific pages, which is much cheaper than sending a whole deck to Gemini.

There's no precomputed keyword table. At about 5 MB of text, a straight scan takes a fraction of a second.

### Limits

- **Matching is on exact keywords, not meaning.** "homework" won't match a slide that only says "deliverable". Gemini usually tries several phrasings.
- **PDFs only.** PowerPoint and Word files aren't indexed, and neither is text inside images or scanned pages.
- **Some files are skipped:** locked or unpublished files, and anything over 60 MB.
- **New uploads take up to 6 hours** to become searchable.

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
| `HOLDING_MESSAGE_AFTER_SECONDS` | Post "Still looking, give me a few more seconds…" once if an answer takes longer than this; `0` turns it off | `30` |
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
- **PDF index:** the `courseworks-index` timer refreshes the PDF index 5 minutes after boot and every 6 hours. The index lives in `/opt/courseworks-bot/.content_index` and is kept across deploys.
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
sudo systemctl start courseworks-index           # refresh the PDF index now
sudo journalctl -u courseworks-index -o cat      # indexer results
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

- **Secrets:** `.env`, `.baileys_auth/` and `.content_index/` (copies of course materials) are excluded from git. On the server, `.env` is readable only by `cwbot`.
- **Will's account, read-only:** the bot uses Will's CourseWorks token. It only reads, never queries grades or submissions, and filters out personal planner notes, so nothing private from Will's account reaches the chat. To hand the bot over, replace `CANVAS_API_TOKEN` with another student's token. Questions and course content are sent to Google Gemini.
- **Unofficial client:** Baileys is an unofficial WhatsApp client, so WhatsApp can unlink or ban the number. The bot uses a dedicated number and avoids 1:1 replies to non-contacts by default.
- **Linked-device timeout:** if the bot's phone stays offline for about 14 days, WhatsApp unlinks the bot. It then clears its session and prints a new QR code to scan.
- **In-memory state:** quota cooldowns and the Vertex daily count live in memory and reset when the bot restarts.
