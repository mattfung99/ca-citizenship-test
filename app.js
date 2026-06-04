// Canadian Citizenship Test Practice - app logic
// State machine: start -> quiz -> results, plus history view.
// Persistence: localStorage key 'citz.results' (array of attempt objects).

const STORAGE_KEY = 'citz.results';
const REAL_TEST_COUNT = 20;
const REAL_TEST_DURATION_S = 45 * 60;
const REAL_TEST_PASS = 15;

const state = {
  questions: null,        // { federal, provincial }
  active: null,           // current attempt: { mode, items, answers, startedAt, durationLimitS, feedback }
  currentIdx: 0,
  timerHandle: null,
};

// ---------- helpers ----------

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function fmtTime(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function show(viewId) {
  $$('.view').forEach(v => v.hidden = v.id !== viewId);
}

// ---------- storage ----------

function loadResults() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveResults(arr) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
}

function recordAttempt(attempt) {
  const all = loadResults();
  all.push(attempt);
  saveResults(all);
}

// ---------- start ----------

async function loadQuestions() {
  const res = await fetch('questions.json');
  state.questions = await res.json();
}

function startQuiz(mode) {
  const pool = state.questions.federal.slice();
  let count, durationLimitS = null, feedback;

  if (mode === 'real') {
    count = REAL_TEST_COUNT;
    durationLimitS = REAL_TEST_DURATION_S;
    feedback = 'end';
  } else {
    count = parseInt($('#practice-count').value, 10);
    feedback = $('#practice-feedback').value;
    if ($('#practice-include-provincial').checked) {
      pool.push(...state.questions.provincial);
    }
  }

  const items = shuffle(pool).slice(0, Math.min(count, pool.length));

  state.active = {
    mode,
    items,
    answers: new Array(items.length).fill(null),  // selected option index per question
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    durationLimitS,
    feedback,
  };
  state.currentIdx = 0;

  $('#quiz-mode-label').textContent = mode === 'real' ? 'Real Test' : 'Practice';
  show('view-quiz');
  startTimer();
  renderQuestion();
}

// ---------- timer ----------

function startTimer() {
  stopTimer();
  updateTimerDisplay();
  state.timerHandle = setInterval(() => {
    updateTimerDisplay();
    if (state.active.durationLimitS !== null) {
      const remaining = state.active.durationLimitS - elapsedS();
      if (remaining <= 0) {
        stopTimer();
        finishQuiz(true);
      }
    }
  }, 1000);
}

function stopTimer() {
  if (state.timerHandle) {
    clearInterval(state.timerHandle);
    state.timerHandle = null;
  }
}

function elapsedS() {
  return (Date.now() - state.active.startedMs) / 1000;
}

function updTimerEl() { return $('#quiz-timer'); }

function updateTimerDisplay() {
  const el = updTimerEl();
  el.classList.remove('warning', 'danger');
  if (state.active.durationLimitS !== null) {
    const remaining = state.active.durationLimitS - elapsedS();
    el.textContent = fmtTime(remaining);
    if (remaining <= 60) el.classList.add('danger');
    else if (remaining <= 300) el.classList.add('warning');
  } else {
    el.textContent = fmtTime(elapsedS());
  }
}

// ---------- question rendering ----------

function renderQuestion() {
  const q = state.active.items[state.currentIdx];
  const selected = state.active.answers[state.currentIdx];
  const isImmediate = state.active.feedback === 'immediate';
  const isAnswered = selected !== null;

  $('#quiz-progress').textContent = `Q ${state.currentIdx + 1} / ${state.active.items.length}`;
  $('#quiz-question').textContent = q.question;

  const optionsEl = $('#quiz-options');
  optionsEl.innerHTML = '';
  q.options.forEach((opt, i) => {
    const li = document.createElement('li');
    li.dataset.index = i;

    const marker = document.createElement('span');
    marker.className = 'marker';
    marker.textContent = String.fromCharCode(65 + i);

    const text = document.createElement('span');
    text.textContent = opt;

    li.append(marker, text);

    if (isAnswered && isImmediate) {
      li.classList.add('locked');
      if (i === q.correct) li.classList.add('correct');
      else if (i === selected) li.classList.add('incorrect');
    } else if (i === selected) {
      li.classList.add('selected');
    }

    if (!isAnswered || !isImmediate) {
      li.addEventListener('click', () => selectOption(i));
    }
    optionsEl.appendChild(li);
  });

  const feedbackEl = $('#quiz-feedback');
  if (isAnswered && isImmediate) {
    const correct = selected === q.correct;
    feedbackEl.hidden = false;
    feedbackEl.classList.toggle('bad', !correct);
    feedbackEl.textContent = correct
      ? 'Correct.'
      : `Incorrect. The right answer is: ${q.options[q.correct]}`;
  } else {
    feedbackEl.hidden = true;
  }

  const isLast = state.currentIdx === state.active.items.length - 1;
  const nextBtn = $('#quiz-next');
  nextBtn.textContent = isLast ? 'Finish' : 'Next';
  nextBtn.disabled = !isAnswered;
}

function selectOption(i) {
  const idx = state.currentIdx;
  // For end-of-quiz feedback, allow changing the answer freely.
  // For immediate feedback, only allow first selection.
  if (state.active.feedback === 'immediate' && state.active.answers[idx] !== null) return;
  state.active.answers[idx] = i;
  renderQuestion();
}

function goNext() {
  const isLast = state.currentIdx === state.active.items.length - 1;
  if (isLast) {
    finishQuiz(false);
  } else {
    state.currentIdx++;
    renderQuestion();
  }
}

// ---------- finish ----------

function finishQuiz(timedOut) {
  stopTimer();
  const a = state.active;
  const elapsed = Math.floor(elapsedS());
  let correctCount = 0;
  a.items.forEach((q, i) => { if (a.answers[i] === q.correct) correctCount++; });

  const total = a.items.length;
  const pct = total === 0 ? 0 : Math.round((correctCount / total) * 100);
  const passed = a.mode === 'real' ? correctCount >= REAL_TEST_PASS : null;

  const attempt = {
    id: 'a_' + Date.now(),
    mode: a.mode,
    startedAt: a.startedAt,
    finishedAt: new Date().toISOString(),
    durationS: elapsed,
    durationLimitS: a.durationLimitS,
    timedOut,
    total,
    correct: correctCount,
    pct,
    passed,
    feedback: a.feedback,
    items: a.items.map((q, i) => ({
      question: q.question,
      options: q.options,
      correct: q.correct,
      selected: a.answers[i],
      category: q.category,
    })),
  };

  recordAttempt(attempt);
  renderResults(attempt, timedOut);
  show('view-results');
}

function renderSummary(container, attempt, opts = {}) {
  const passClass = attempt.passed === true ? 'pass' : attempt.passed === false ? 'fail' : '';
  const verdict = attempt.passed === true ? 'PASS' : attempt.passed === false ? 'FAIL' : '—';
  const mode = attempt.mode === 'real' ? 'Real Test' : 'Practice';
  container.innerHTML = `
    <div class="stat"><span class="label">Score</span><span class="value">${attempt.correct} / ${attempt.total}</span></div>
    <div class="stat"><span class="label">Percent</span><span class="value">${attempt.pct}%</span></div>
    <div class="stat"><span class="label">Time</span><span class="value">${fmtTime(attempt.durationS)}</span></div>
    <div class="stat"><span class="label">Mode</span><span class="value" style="font-size:1rem">${mode}</span></div>
    <div class="stat"><span class="label">Verdict</span><span class="value ${passClass}">${verdict}</span></div>
    ${opts.includeDate ? `<div class="stat"><span class="label">Date</span><span class="value" style="font-size:0.9rem">${fmtDate(attempt.finishedAt)}</span></div>` : ''}
    ${attempt.timedOut ? '<div class="stat"><span class="label">Note</span><span class="value" style="font-size:1rem">Time ran out</span></div>' : ''}
  `;
}

function renderReview(container, items) {
  container.innerHTML = '';
  items.forEach((it, i) => {
    const correct = it.selected === it.correct;
    const li = document.createElement('li');
    li.className = correct ? 'correct' : 'incorrect';
    const yourAnsHtml = it.selected === null
      ? '<em>(no answer)</em>'
      : escapeHtml(it.options[it.selected]);
    li.innerHTML = `
      <div class="q">${i + 1}. ${escapeHtml(it.question)}</div>
      <div class="a">Your answer: <strong>${yourAnsHtml}</strong></div>
      ${correct ? '' : `<div class="a">Correct answer: <strong>${escapeHtml(it.options[it.correct])}</strong></div>`}
    `;
    container.appendChild(li);
  });
}

function renderResults(attempt, timedOut) {
  renderSummary($('#results-summary'), attempt);
  renderReview($('#results-review'), attempt.items);
}

function viewAttempt(id) {
  const attempt = loadResults().find(a => a.id === id);
  if (!attempt) return;
  $('#attempt-title').textContent = `Attempt — ${fmtDate(attempt.finishedAt)}`;
  renderSummary($('#attempt-summary'), attempt, { includeDate: true });
  renderReview($('#attempt-review'), attempt.items);
  show('view-attempt');
  window.scrollTo(0, 0);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- history ----------

function renderHistory() {
  const all = loadResults().slice().sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));

  const statsEl = $('#history-stats');
  const chartEl = $('#history-chart');
  const tbody = $('#history-table tbody');

  if (all.length === 0) {
    statsEl.innerHTML = '<div class="empty">No attempts yet. Take a quiz to start tracking your progress.</div>';
    chartEl.innerHTML = '<div class="empty">Your scores will appear here.</div>';
    tbody.innerHTML = '';
    return;
  }

  const totalAttempts = all.length;
  const avgPct = Math.round(all.reduce((s, a) => s + a.pct, 0) / totalAttempts);
  const best = Math.max(...all.map(a => a.pct));
  const realTests = all.filter(a => a.mode === 'real');
  const realPasses = realTests.filter(a => a.passed).length;

  statsEl.innerHTML = `
    <div class="stat"><span class="label">Attempts</span><span class="value">${totalAttempts}</span></div>
    <div class="stat"><span class="label">Average</span><span class="value">${avgPct}%</span></div>
    <div class="stat"><span class="label">Best</span><span class="value">${best}%</span></div>
    <div class="stat"><span class="label">Real tests passed</span><span class="value">${realPasses} / ${realTests.length}</span></div>
  `;

  chartEl.innerHTML = '';
  all.forEach(a => {
    const bar = document.createElement('div');
    bar.className = 'bar';
    if (a.mode === 'real') bar.classList.add(a.passed ? 'pass' : 'fail');
    bar.style.height = `${Math.max(4, a.pct)}%`;
    bar.dataset.tip = `${fmtDate(a.finishedAt)} · ${a.pct}% (${a.correct}/${a.total})`;
    chartEl.appendChild(bar);
  });

  tbody.innerHTML = '';
  all.slice().reverse().forEach(a => {
    const tr = document.createElement('tr');
    const mode = a.mode === 'real' ? 'Real test' : 'Practice';
    const verdict = a.passed === true ? ' · PASS' : a.passed === false ? ' · FAIL' : '';
    const hasItems = Array.isArray(a.items) && a.items.length > 0;
    tr.innerHTML = `
      <td>${fmtDate(a.finishedAt)}</td>
      <td>${mode}${verdict}</td>
      <td>${a.correct} / ${a.total}</td>
      <td>${a.pct}%</td>
      <td>${fmtTime(a.durationS)}${a.timedOut ? ' (timeout)' : ''}</td>
      <td>
        ${hasItems ? `<button type="button" class="review-btn" data-review="${a.id}">Review</button>` : ''}
        <button type="button" class="ghost" data-del="${a.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function deleteAttempt(id) {
  const all = loadResults().filter(a => a.id !== id);
  saveResults(all);
  renderHistory();
}

// ---------- export / import ----------

function exportResults() {
  const data = {
    exportedAt: new Date().toISOString(),
    version: 1,
    results: loadResults(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `citizenship-results-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importResults(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const incoming = Array.isArray(data) ? data : data.results;
    if (!Array.isArray(incoming)) throw new Error('Invalid file: no results array.');

    // Merge by id (newer entries with same id win — but typically all ids are unique by Date.now()).
    const existing = loadResults();
    const byId = new Map(existing.map(a => [a.id, a]));
    let added = 0;
    incoming.forEach(a => {
      if (a && a.id && !byId.has(a.id)) {
        byId.set(a.id, a);
        added++;
      }
    });
    saveResults(Array.from(byId.values()));
    alert(`Imported ${added} new attempt(s). Skipped ${incoming.length - added} duplicate(s).`);
    renderHistory();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
}

function clearAll() {
  if (!confirm('Delete all saved results? This cannot be undone (unless you exported them).')) return;
  localStorage.removeItem(STORAGE_KEY);
  renderHistory();
}

// ---------- wire up ----------

function init() {
  // Nav
  $$('[data-go]').forEach(b => {
    b.addEventListener('click', () => {
      const target = b.dataset.go;
      if (target === 'history') renderHistory();
      show('view-' + target);
    });
  });

  // Start buttons
  $$('[data-start]').forEach(b => {
    b.addEventListener('click', () => startQuiz(b.dataset.start));
  });

  // Quiz
  $('#quiz-next').addEventListener('click', goNext);
  $('#quiz-quit').addEventListener('click', () => {
    if (confirm('Quit this quiz? Your attempt will not be saved.')) {
      stopTimer();
      state.active = null;
      show('view-start');
    }
  });

  // History actions
  $('#export-btn').addEventListener('click', exportResults);
  $('#import-file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) importResults(f);
    e.target.value = '';
  });
  $('#clear-btn').addEventListener('click', clearAll);
  $('#history-table').addEventListener('click', e => {
    const reviewId = e.target.dataset?.review;
    if (reviewId) { viewAttempt(reviewId); return; }
    const delId = e.target.dataset?.del;
    if (delId && confirm('Delete this attempt?')) deleteAttempt(delId);
  });

  loadQuestions().catch(err => {
    document.body.innerHTML = `<main><p style="color:red">Failed to load questions.json: ${err.message}. Serve the site over HTTP (run <code>make</code>).</p></main>`;
  });
}

document.addEventListener('DOMContentLoaded', init);
