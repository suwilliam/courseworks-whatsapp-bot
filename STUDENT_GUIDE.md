# Exie: Your CourseWorks Bot

Exie (from "xMS") is a WhatsApp bot in our cohort group that answers questions about classes using live CourseWorks data: due dates, assignments, readings, syllabi, exams, announcements and office hours.

## Asking a question

In the cohort group chat, start your message with **`!exie`**:

```
!exie what's due this week?
```

You can also @mention Exie instead of typing `!exie`, or type `@exie`.

Exie shows "typing…" while it looks things up, then replies with a message starting with 🎓. Most answers take **10–30 seconds**. When Google's AI servers are busy, an answer can take a couple of minutes.

**Please ask in the group, not in a direct message.** WhatsApp may disconnect the bot if it replies to lots of people one-on-one.

## Example questions

**Due dates**
- `!exie what's due this week?`
- `!exie what's due tomorrow?`
- `!exie when is stats homework 3 due?`

**Readings and class prep**
- `!exie what readings do we have for entrepreneurship class 6?`
- `!exie what should I prepare for the next human-centered design class?`
- `!exie what homework did the last tough tech slides assign?`

**Syllabus and grading**
- `!exie what's the grading breakdown for tough tech?`
- `!exie what's the late policy for UI/UX?`

**Exams**
- `!exie is there a final exam in fundamental design tools?`
- `!exie when is the stats midterm?`

**Logistics**
- `!exie when are stats office hours?`
- `!exie any new announcements this week?`
- `!exie where is the next stats lecture?`

**Follow-ups:** the bot reads the last few messages in the chat, so you can ask things like `!exie when is that due?` right after another answer. You still need `!exie` each time.

## Which courses it knows

The bot sees CourseWorks through one student's account, so it only knows courses that student is enrolled in, including:

- MBAxMS Statistics & Business Analytics (Guetta)
- Foundations of Entrepreneurship (Guzman)
- Human-Centered Design and Innovation
- Frontiers of Tough Tech
- Design of UI/UX for Connected Systems
- Fundamental Design Tools
- Career Management and MBAxMS Class of 2028 pages

If you're in a different elective or section, the bot can't see that course.

## Good to know

- **Times are Eastern Time.** The bot flags anything due within 48 hours.
- **It searches inside slides and PDFs** posted on CourseWorks, so it can find homework that's only described in lecture slides. New uploads show up within about 6 hours.
- **It only reads CourseWorks.** It can't submit work, see grades or submissions, or read Slack, email or Google Drive. Information that's only shared in class or by email won't be in its answers.
- **It can be wrong.** Double-check important deadlines and exam details on CourseWorks. Each answer includes links you can use to check.
- **If something isn't posted, it says so** instead of guessing. Ask the professor or TA in that case.
- **Your question goes to Google's Gemini AI** to produce the answer. Don't include personal or sensitive information.

## If something goes wrong

| What you see | What to do |
|---|---|
| "I'm overloaded right now. Try again in a few minutes." | Google's AI is busy or the daily limit was reached. Try again later. |
| "Sorry, something went wrong looking that up." | Try again in a minute, or rephrase the question. |
| No reply after 3–4 minutes | Check that your message started with `!exie`. If it did, the bot may be offline; let Will know. |
