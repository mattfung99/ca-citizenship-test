# Canadian Citizenship Test Practice

A static, no-backend practice app for the Canadian citizenship test.

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

Results are saved to `localStorage` under the key `citz.results`. The History page shows:
- Aggregate stats (attempts, average %, best %, real tests passed)
- A bar chart over time
- Per-attempt table with delete

### Export / import

- **Download results (.json)** — saves a portable JSON file
- **Import results...** — select one or more exported JSON files; all are merged in a single pass (duplicates skipped by attempt id). Use this to consolidate results from different devices/browsers.
- **Clear all results** — wipes localStorage (after confirmation)

Use export to back up before clearing the browser cache or to sync between devices.

## File layout

```
index.html          single-page app shell (start / quiz / results / history views)
src/
  app.js            state machine, timer, scoring, persistence, export/import
  styles.css        minimal styling (system-ui font, light/dark via prefers-color-scheme)
questions.json      the question bank
Makefile            local server convenience
```
