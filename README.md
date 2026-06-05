# Canadian Citizenship Test Practice

A practice app for the Canadian citizenship test. Runs as a static site with optional Supabase-backed account sync.

## Quick start

```bash
make        # alias for `make serve`
make stop   # kill the server when done
```

Opens `http://localhost:8001/`. Falls back to `python3 -m http.server` so no dependencies beyond Python 3.

## Modes

- **Real Test** — 20 questions, 45-minute countdown timer, no feedback until the end. Pass = 15/20 (matches the actual exam).
- **Practice** — pick 20/30/40/60/100 questions, no timer, choose immediate or end-of-quiz feedback. Option to include region-specific Provincial questions.

## Data

Questions live in `questions.json` — **507 unique questions** after dedupe:
- `federal[]` — 427 general / *Discover Canada* questions
- `provincial[]` — 80 region-specific questions (mostly Richmond, BC) — opt-in for practice

Sources:
- [Richmond Public Library answer keys](https://www.yourlibrary.ca/citizenship-test-answer-keys/)
- [mycitizen.ca full simulation tests](https://www.mycitizen.ca/full-simulation-tests.html) (18 × 20-question tests)

Each question carries a `source` URL. Dedupe runs in two passes:
1. Exact match on the normalized question fingerprint (lowercase, ASCII-folded, punctuation-stripped).
2. Jaccard token similarity ≥ 0.7 **and** identical correct-answer text — catches reworded duplicates.

Some answers reflect officials/leaders at the time of authoring (Premier, Lieutenant-Governor, etc.) and may be out of date.

### Re-running the source pull

The current pull was done with throwaway Python scripts; if you want to re-run or pull a new source, the steps are: fetch the source HTML/JSON → normalize each question to `{question, options[], correct, source, category}` → run the dedupe pass against `questions.json` → write back.

## Progress tracking

When signed in, results are saved to Supabase and sync across devices automatically. When not signed in (guest), results are saved to `localStorage` only. On first sign-in the app offers to upload any locally stored results to the account.

The History page shows:
- Aggregate stats (attempts, average %, best %, real tests passed)
- A bar chart over time
- Per-attempt table with delete

### Export / import

- **Download results (.json)** — exports all results (from Supabase if signed in, localStorage if guest)
- **Import results...** — select one or more exported JSON files; all are merged in a single pass (duplicates skipped by attempt id). When signed in, imports go directly to Supabase.
- **Clear all results** — deletes from Supabase (signed in) or wipes localStorage (guest), after confirmation

Use export to back up before clearing the browser cache.

## Supabase setup

History syncs across devices when signed in. The backend is [Supabase](https://supabase.com) (free tier).

### One-time dashboard config (already done)

1. **Authentication → Policies** — sign ups disabled (invite-only)
2. **Authentication → Sign In / Providers → Email** — magic link enabled
3. **Authentication → URL Configuration** — GitHub Pages URL + `http://localhost:8001/` added as redirect URLs
4. **Settings → Integrations → GitHub** — connected to this repo; migrations in `supabase/migrations/` auto-deploy on push to `master`
5. **Settings → Emails → Custom SMTP** — Resend configured to lift the default 2 emails/hour rate limit
6. After first deploy, run in SQL Editor: `grant select, insert, update, delete on attempts to authenticated;`

### Inviting users

Authentication → Users → **Invite** — enter the email address. The user receives a magic link and is added to the account on first click.

### Adding credentials

Put your Supabase Project URL and anon key in `src/config.js`. The anon key is intentionally public — security is enforced via Row Level Security (RLS) on the database, not by keeping the key secret. Never put the `service_role` key in this file.

### Guest access

Users who are not signed in can still take quizzes. Results are saved to `localStorage` only. On first sign-in, the app offers to upload any locally stored results to the account.

## File layout

```
index.html               single-page app shell (start / login / quiz / results / history views)
src/
  app.js                 state machine, auth, Supabase storage, export/import
  styles.css             minimal styling (system-ui font, light/dark via prefers-color-scheme)
  config.js              public Supabase credentials (anon key, safe to commit)
supabase/
  migrations/
    20260604000000_initial.sql   attempts table, RLS policy, size constraint
questions.json           the question bank
Makefile                 local server convenience
```
