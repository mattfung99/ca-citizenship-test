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
  lastAttempt: null,      // for the /results route immediately after finishing
};

// ---------- helpers ----------

const THEME_KEY = 'citz.theme';

function currentTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_KEY, next);
}

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
  // Render in the device's local timezone, with the timezone abbreviation
  // (e.g. "PDT", "EST") appended so it's unambiguous on import/export.
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZoneName: 'short',
  });
}

function show(viewId) {
  $$('.view').forEach(v => v.hidden = v.id !== viewId);
}

// ---------- router (path-based, History API) ----------
// Routes: /  /history  /quiz  /results  /review/<id>
// On GitHub Pages project sites, all of these are prefixed with the repo path
// (e.g. /ca-citizenship-test/history). BASE captures that prefix.

const BASE = (function () {
  let p = window.location.pathname;
  // If the user arrived directly at /something/index.html, strip the filename.
  if (/\.html?$/.test(p)) p = p.replace(/[^/]*$/, '');
  if (!p.endsWith('/')) p += '/';
  return p;
})();

const routes = {
  '': () => show('view-start'),
  home: () => show('view-start'),
  history: () => { renderHistory(); show('view-history'); window.scrollTo(0, 0); },
  quiz: () => {
    if (!state.active) { navigate(''); return; }
    show('view-quiz');
  },
  results: () => {
    if (!state.lastAttempt) { navigate('history'); return; }
    show('view-results');
  },
  review: (id) => {
    const a = loadResults().find(r => r.id === id);
    if (!a) { navigate('history'); return; }
    $('#attempt-title').textContent = `Attempt — ${fmtDate(a.finishedAt)}`;
    renderSummary($('#attempt-summary'), a, { includeDate: true });
    renderReview($('#attempt-review'), a.items);
    show('view-attempt');
    window.scrollTo(0, 0);
  },
};

function currentSegments() {
  const path = window.location.pathname;
  const rel = path.startsWith(BASE) ? path.slice(BASE.length) : path.replace(/^\//, '');
  return rel.split('/').filter(Boolean);
}

function route() {
  const parts = currentSegments();
  const seg = parts[0] || '';
  const handler = routes[seg];

  // Stop a running quiz if user navigates away
  if (state.timerHandle && seg !== 'quiz') {
    stopTimer();
    state.active = null;
  }

  if (handler) handler(parts[1]);
  else navigate('');
}

function navigate(seg) {
  const url = BASE + (seg || '');
  if (window.location.pathname === url) {
    route();
  } else {
    window.history.pushState(null, '', url);
    route();
  }
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
  // Use BASE so the fetch works regardless of the current route
  // (e.g. when the user deep-links to /review/<id>, a relative fetch would
  // resolve to /review/questions.json — which doesn't exist).
  const res = await fetch(BASE + 'questions.json');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  navigate('quiz');
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
  state.lastAttempt = attempt;
  renderResults(attempt, timedOut);
  navigate('results');
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
  navigate('review/' + encodeURIComponent(id));
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
        ${hasItems ? `<button type="button" class="ghost" data-review="${a.id}">Review</button>` : ''}
        <button type="button" class="danger" data-del="${a.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Single floating tooltip element attached to <body>. Bars on the chart trigger
// it via delegated mouseover/mouseout — this avoids being clipped by chart overflow.
function setupChartTooltip() {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  document.body.appendChild(tip);

  function position(target) {
    const r = target.getBoundingClientRect();
    tip.style.top = (r.top + window.scrollY - tip.offsetHeight - 6) + 'px';
    tip.style.left = (r.left + window.scrollX + r.width / 2) + 'px';
  }

  document.addEventListener('mouseover', e => {
    const bar = e.target.closest?.('.chart .bar');
    if (!bar) return;
    tip.textContent = bar.dataset.tip || '';
    tip.hidden = false;
    position(bar);
  });
  document.addEventListener('mouseout', e => {
    const bar = e.target.closest?.('.chart .bar');
    if (!bar) return;
    tip.hidden = true;
  });
  window.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
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
  // Theme toggle (persistent light/dark)
  $('#theme-toggle')?.addEventListener('click', toggleTheme);

  // Nav — all data-go buttons drive the router via hash
  $$('[data-go]').forEach(b => {
    b.addEventListener('click', () => {
      const target = b.dataset.go === 'start' ? '' : b.dataset.go;
      navigate(target);
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
      navigate('');
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

  // If 404.html stored a redirect (refresh on deep link via GH Pages), restore it now.
  const stored = sessionStorage.getItem('citz.spa-redirect');
  if (stored) {
    sessionStorage.removeItem('citz.spa-redirect');
    try { window.history.replaceState(null, '', stored); } catch (e) { /* ignore cross-origin */ }
  }

  // Browser back/forward
  window.addEventListener('popstate', route);

  setupChartTooltip();

  loadQuestions()
    .then(() => route())   // route once questions are available
    .catch(err => {
      document.body.innerHTML = `<main><p style="color:red">Failed to load questions.json: ${err.message}. Serve the site over HTTP (run <code>make</code>).</p></main>`;
    });
}

document.addEventListener('DOMContentLoaded', init);
