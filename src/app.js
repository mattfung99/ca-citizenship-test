// Canadian Citizenship Test Practice - app logic
// State machine: start -> quiz -> results, plus history and login views.
// Storage: Supabase (when signed in) or localStorage (guest fallback).

const STORAGE_KEY        = 'citz.results';
const MIGRATION_SKIP_KEY = 'citz.migration-skipped';  // suffixed with ':<user-id>' per account
const PENDING_SYNC_KEY   = 'citz.pending-sync';
const REAL_TEST_COUNT    = 20;
const REAL_TEST_DURATION_S = 45 * 60;
const REAL_TEST_PASS     = 15;
// A hair under the server-side 100 KB CHECK constraint to leave headroom for
// jsonb canonicalisation (sorted keys, escape sequences) inflating the row.
const MAX_ROW_BYTES      = 102000;

const sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const state = {
  questions:   null,   // { federal, provincial }
  active:      null,   // current attempt in progress
  currentIdx:  0,
  timerHandle: null,
  lastAttempt: null,   // for the /results route immediately after finishing
  user:        null,   // Supabase user object, or null for guests
  handledInitialAuth: false,  // gate the one-time post-sign-in side effects
  cachedResults: null, // last successful Supabase fetch, used as offline fallback
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
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZoneName: 'short',
  });
}

// Shorter date for table cells — no timezone, fits narrow screens.
function fmtDateShort(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function show(viewId) {
  $$('.view').forEach(v => v.hidden = v.id !== viewId);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- router ----------
// Routes: /  /login  /history  /quiz  /results  /review/<id>
// On GitHub Pages project sites the path is prefixed with the repo name.
// BASE captures that prefix so all navigations stay within the right root.

const BASE = (function () {
  let p = window.location.pathname;
  if (/\.html?$/.test(p)) p = p.replace(/[^/]*$/, '');
  if (!p.endsWith('/')) p += '/';
  return p;
})();

const routes = {
  '':      () => show('view-start'),
  home:    () => show('view-start'),
  login:   () => {
    if (state.user) { navigate('history'); return; }
    const btn = $('#login-submit');
    btn.disabled = false;
    btn.textContent = 'Sign in';
    $('#login-email').value = '';
    $('#login-password').value = '';
    show('view-login');
  },
  history: async () => {
    show('view-history');
    window.scrollTo(0, 0);
    await renderHistory();
  },
  quiz: () => {
    if (!state.active) { navigate(''); return; }
    show('view-quiz');
  },
  results: () => {
    if (!state.lastAttempt) { navigate('history'); return; }
    show('view-results');
  },
  review: async (id) => {
    show('view-attempt');
    window.scrollTo(0, 0);
    $('#attempt-title').textContent = 'Loading…';
    const all = await loadResults();
    const a = all.find(r => r.id === id);
    if (!a) { navigate('history'); return; }
    $('#attempt-title').textContent = `Result — ${fmtDate(a.finishedAt)}`;
    renderSummary($('#attempt-summary'), a, { includeDate: true });
    renderReview($('#attempt-review'), a.items);
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

  if (state.timerHandle && seg !== 'quiz') {
    stopTimer();
    state.active = null;
  }

  if (handler) {
    const result = handler(parts[1]);
    if (result instanceof Promise) result.catch(err => console.error('Route error:', err));
  } else {
    navigate('');
  }
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
// Guests:      read/write localStorage only — zero Supabase calls.
// Signed-in:   read/write Supabase; localStorage is not touched.

function loadLocalResults() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
}

// Scope by user id so a queued attempt belonging to one account can never be
// drained into a different account when multiple users share a browser.
function pendingSyncKey(userId) { return `${PENDING_SYNC_KEY}:${userId}`; }

function loadPendingSync(userId) {
  try { return JSON.parse(localStorage.getItem(pendingSyncKey(userId))) || []; } catch { return []; }
}

function appendPendingSync(userId, attempt) {
  const all = loadPendingSync(userId);
  all.push(attempt);
  localStorage.setItem(pendingSyncKey(userId), JSON.stringify(all));
}

// Best-effort: try to upload anything queued during prior failures. Silent — if
// it fails again the queue is left intact for the next attempt.
async function drainPendingSync(user) {
  const pending = loadPendingSync(user.id);
  if (pending.length === 0) return;
  const rows = pending.map(a => ({
    id:          a.id,
    user_id:     user.id,
    data:        a,
    finished_at: a.finishedAt,
  }));
  const { error } = await sbClient.from('attempts').upsert(rows);
  if (!error) localStorage.removeItem(pendingSyncKey(user.id));
}

async function loadResults() {
  if (state.user) {
    try {
      const { data, error } = await sbClient
        .from('attempts')
        .select('data')
        .eq('user_id', state.user.id)
        .order('finished_at');
      if (error) throw error;
      state.cachedResults = (data ?? []).map(r => r.data);
      return state.cachedResults;
    } catch (err) {
      if (state.cachedResults) return state.cachedResults;
      throw err;
    }
  }
  return loadLocalResults();
}

async function recordAttempt(attempt) {
  if (state.user) {
    try {
      const { error } = await sbClient.from('attempts').upsert({
        id:          attempt.id,
        user_id:     state.user.id,
        data:        attempt,
        finished_at: attempt.finishedAt,
      });
      if (error) throw error;
    } catch (err) {
      // Don't lose the user's result on network/RLS/size failure — queue it
      // locally and surface what happened.
      appendPendingSync(state.user.id, attempt);
      alert(
        'Could not save this result to your account right now.\n' +
        'It has been kept locally and will sync next time you sign in.\n\n' +
        err.message
      );
    }
  } else {
    const all = loadLocalResults();
    all.push(attempt);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  }
}

async function deleteAttempt(id) {
  if (state.user) {
    const { error } = await sbClient
      .from('attempts')
      .delete()
      .eq('id', id)
      .eq('user_id', state.user.id);
    if (error) { alert(`Delete failed: ${error.message}`); return; }
  } else {
    const all = loadLocalResults().filter(a => a.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  }
  await renderHistory();
}

// ---------- auth ----------

function updateNavAuth(user) {
  state.user = user;
  const signInBtn  = $('#nav-signin');
  const userPanel  = $('#nav-user');
  const avatarEl   = $('#nav-user-avatar');
  if (user) {
    signInBtn.hidden = true;
    userPanel.hidden = false;
    avatarEl.textContent = user.email[0].toUpperCase();
    avatarEl.dataset.tooltip = user.email;
    avatarEl.setAttribute('aria-label', `Signed in as ${user.email}`);
  } else {
    signInBtn.hidden = false;
    userPanel.hidden = true;
  }
}

async function signInWithPassword(email, password) {
  const { error } = await sbClient.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

async function signOut() {
  await sbClient.auth.signOut();
  navigate('');
}

// On first login, offer to upload any existing localStorage results.
// The skip flag is keyed by user id so a "no" on a shared device doesn't bleed
// across accounts.
async function offerLocalMigration(user) {
  const local = loadLocalResults();
  if (local.length === 0) return;
  const skipKey = `${MIGRATION_SKIP_KEY}:${user.id}`;
  if (localStorage.getItem(skipKey)) return;

  const ok = confirm(
    `You have ${local.length} result(s) saved locally.\nUpload them to your account so they appear in History?`
  );
  if (!ok) {
    localStorage.setItem(skipKey, '1');
    return;
  }

  const valid     = local.filter(a => JSON.stringify(a).length < MAX_ROW_BYTES);
  const oversized = local.filter(a => JSON.stringify(a).length >= MAX_ROW_BYTES);

  if (valid.length > 0) {
    const rows = valid.map(a => ({
      id:          a.id,
      user_id:     user.id,
      data:        a,
      finished_at: a.finishedAt,
    }));
    const { error } = await sbClient.from('attempts').upsert(rows);
    if (error) {
      alert(`Upload failed: ${error.message}`);
      return;
    }
  }

  // Keep only the rows we couldn't upload; clear the skip flag so the user can
  // be re-prompted if they later add more.
  if (oversized.length === 0) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(oversized));
  localStorage.removeItem(skipKey);

  let msg = `Uploaded ${valid.length} result(s) to your account.`;
  if (oversized.length > 0) {
    msg += `\n\n${oversized.length} result(s) were too large to upload and remain saved locally.`;
  }
  alert(msg);
}

// ---------- start ----------

async function loadQuestions() {
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
    answers: new Array(items.length).fill(null),
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

function updateTimerDisplay() {
  const el = $('#quiz-timer');
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

async function finishQuiz(timedOut) {
  stopTimer();
  const a = state.active;
  const elapsed = Math.floor(elapsedS());
  let correctCount = 0;
  a.items.forEach((q, i) => { if (a.answers[i] === q.correct) correctCount++; });

  const total = a.items.length;
  const pct = total === 0 ? 0 : Math.round((correctCount / total) * 100);
  const passed = a.mode === 'real' ? correctCount >= REAL_TEST_PASS : null;

  const attempt = {
    id: crypto.randomUUID(),
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
      options:  q.options,
      correct:  q.correct,
      selected: a.answers[i],
      category: q.category,
    })),
  };

  await recordAttempt(attempt);
  state.lastAttempt = attempt;
  renderResults(attempt);
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

function renderResults(attempt) {
  renderSummary($('#results-summary'), attempt);
  renderReview($('#results-review'), attempt.items);
}

function viewAttempt(id) {
  navigate('review/' + encodeURIComponent(id));
}

// ---------- history ----------

async function renderHistory() {
  const statsEl = $('#history-stats');
  const chartEl = $('#history-chart');
  const tbody   = $('#history-table tbody');

  statsEl.innerHTML = '<div class="empty">Loading…</div>';
  chartEl.innerHTML = '';
  tbody.innerHTML   = '';

  let all;
  try {
    all = (await loadResults()).slice().sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
  } catch (err) {
    statsEl.innerHTML =
      `<div class="empty">Could not load history: ${escapeHtml(err.message)}. ` +
      `<button type="button" id="history-retry">Retry</button></div>`;
    $('#history-retry').addEventListener('click', () => renderHistory());
    return;
  }

  if (all.length === 0) {
    statsEl.innerHTML = '<div class="empty">No results yet. Take a practice test to start tracking your progress.</div>';
    chartEl.innerHTML = '<div class="empty">Your results will appear here.</div>';
    return;
  }

  const totalAttempts = all.length;
  const avgPct = Math.round(all.reduce((s, a) => s + a.pct, 0) / totalAttempts);
  const best = Math.max(...all.map(a => a.pct));
  const realTests  = all.filter(a => a.mode === 'real');
  const realPasses = realTests.filter(a => a.passed).length;

  statsEl.innerHTML = `
    <div class="stat"><span class="label">Results</span><span class="value">${totalAttempts}</span></div>
    <div class="stat"><span class="label">Average</span><span class="value">${avgPct}%</span></div>
    <div class="stat"><span class="label">Best</span><span class="value">${best}%</span></div>
    <div class="stat"><span class="label">Real tests passed</span><span class="value">${realPasses} / ${realTests.length}</span></div>
  `;

  chartEl.innerHTML = '';
  all.forEach(a => {
    const bar = document.createElement('div');
    // Colour by whether the score meets the real-test passing threshold (75 %)
    // regardless of mode, so practice runs also go green when they would have passed.
    const wouldPass = a.mode === 'real' ? a.passed : a.pct >= 75;
    bar.className = `bar ${wouldPass ? 'pass' : 'fail'}`;
    bar.style.height = `${Math.max(4, a.pct)}%`;
    bar.dataset.tip = `${fmtDate(a.finishedAt)} · ${a.pct}% (${a.correct}/${a.total})`;
    chartEl.appendChild(bar);
  });

  all.slice().reverse().forEach(a => {
    const tr = document.createElement('tr');
    const mode    = a.mode === 'real' ? 'Real test' : 'Practice';
    const verdict = a.passed === true ? ' · PASS' : a.passed === false ? ' · FAIL' : '';
    const hasItems = Array.isArray(a.items) && a.items.length > 0;
    // a.id originates from import in some cases — escape before inlining into
    // attribute context so a crafted id can't break out of the data-* quotes.
    const safeId = escapeHtml(a.id);
    tr.innerHTML = `
      <td title="${escapeHtml(fmtDate(a.finishedAt))}">${escapeHtml(fmtDateShort(a.finishedAt))}</td>
      <td>${mode}${verdict}</td>
      <td>${a.correct} / ${a.total}</td>
      <td>${a.pct}%</td>
      <td>${fmtTime(a.durationS)}${a.timedOut ? ' (timeout)' : ''}</td>
      <td>
        ${hasItems ? `<button type="button" class="ghost" data-review="${safeId}">Review</button>` : ''}
        <button type="button" class="danger" data-del="${safeId}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Single floating tooltip for chart bars — avoids overflow clipping.
function setupChartTooltip() {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  document.body.appendChild(tip);

  function position(target) {
    const r = target.getBoundingClientRect();
    tip.style.top  = (r.top + window.scrollY - tip.offsetHeight - 6) + 'px';
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

// ---------- export / import ----------

async function exportResults() {
  const results = await loadResults();
  const data = {
    exportedAt: new Date().toISOString(),
    version: 1,
    results,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  a.download = `citizenship-results-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Defence-in-depth: imported attempts are user-controlled JSON and end up
// rendered in History, stored in Supabase, and sorted by finishedAt. Reject
// anything whose id could break out of an HTML attribute or whose finishedAt
// won't parse — the rest of the shape is allowed through but obviously bogus
// rows just won't render usefully.
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function isValidImportedAttempt(a) {
  return (
    a && typeof a === 'object' &&
    typeof a.id === 'string' && SAFE_ID_RE.test(a.id) &&
    typeof a.finishedAt === 'string' && Number.isFinite(Date.parse(a.finishedAt))
  );
}

async function importResults(files) {
  const fileList = (files instanceof FileList || Array.isArray(files)) ? Array.from(files) : [files];

  const existing = await loadResults();
  const byId = new Map(existing.map(a => [a.id, a]));

  let totalAdded    = 0;
  let totalSkipped  = 0;
  let totalRejected = 0;
  const toUpsert    = [];
  const errors      = [];

  for (const file of fileList) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const incoming = Array.isArray(data) ? data : data.results;
      if (!Array.isArray(incoming)) throw new Error('No results array found.');

      incoming.forEach(a => {
        if (!isValidImportedAttempt(a)) {
          totalRejected++;
          return;
        }
        if (!byId.has(a.id)) {
          byId.set(a.id, a);
          toUpsert.push(a);
          totalAdded++;
        } else {
          totalSkipped++;
        }
      });
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }

  if (toUpsert.length > 0) {
    if (state.user) {
      const valid     = toUpsert.filter(a => JSON.stringify(a).length < MAX_ROW_BYTES);
      const oversized = toUpsert.filter(a => JSON.stringify(a).length >= MAX_ROW_BYTES);
      if (valid.length > 0) {
        const rows = valid.map(a => ({
          id:          a.id,
          user_id:     state.user.id,
          data:        a,
          finished_at: a.finishedAt,
        }));
        const { error } = await sbClient.from('attempts').upsert(rows);
        if (error) { alert(`Import failed: ${error.message}`); return; }
      }
      if (oversized.length > 0) {
        totalAdded -= oversized.length;
        errors.push(`${oversized.length} result(s) skipped (too large to upload).`);
      }
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(byId.values())));
    }
  }

  const parts = [];
  if (fileList.length > 1) parts.push(`${fileList.length} files merged.`);
  parts.push(`Added ${totalAdded} new result(s), skipped ${totalSkipped} duplicate(s).`);
  if (totalRejected > 0) parts.push(`Rejected ${totalRejected} malformed result(s).`);
  if (errors.length) parts.push(`Errors:\n${errors.join('\n')}`);
  alert(parts.join('\n'));

  await renderHistory();
}

async function clearAll() {
  if (!confirm('Delete all saved results? This cannot be undone (unless you exported them).')) return;
  if (state.user) {
    const { error } = await sbClient
      .from('attempts')
      .delete()
      .eq('user_id', state.user.id);
    if (error) { alert(`Error: ${error.message}`); return; }
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  await renderHistory();
}

// ---------- wire up ----------

function closeNav() {
  const hdr = $('header');
  hdr.classList.remove('nav-open');
  $('#nav-toggle').setAttribute('aria-expanded', 'false');
}

async function init() {
  // Mobile hamburger menu
  $('#nav-toggle').addEventListener('click', e => {
    e.stopPropagation();
    const open = $('header').classList.toggle('nav-open');
    $('#nav-toggle').setAttribute('aria-expanded', String(open));
  });
  // Close when any nav item is activated
  $('#main-nav').addEventListener('click', closeNav);
  // Close on outside tap/click
  document.addEventListener('click', e => {
    if (!$('header').contains(e.target)) closeNav();
  });

  $('#theme-toggle')?.addEventListener('click', toggleTheme);

  $$('[data-go]').forEach(b => {
    b.addEventListener('click', () => {
      const target = b.dataset.go === 'start' ? '' : b.dataset.go;
      navigate(target);
    });
  });

  $$('[data-start]').forEach(b => {
    b.addEventListener('click', () => startQuiz(b.dataset.start));
  });

  $('#quiz-next').addEventListener('click', goNext);
  $('#quiz-quit').addEventListener('click', () => {
    if (confirm('Quit this quiz? Your result will not be saved.')) {
      stopTimer();
      state.active = null;
      navigate('');
    }
  });

  $('#export-btn').addEventListener('click', exportResults);
  $('#import-file').addEventListener('change', e => {
    if (e.target.files.length) importResults(e.target.files);
    e.target.value = '';
  });
  $('#clear-btn').addEventListener('click', clearAll);
  $('#history-table').addEventListener('click', e => {
    const reviewId = e.target.dataset?.review;
    if (reviewId) { viewAttempt(reviewId); return; }
    const delId = e.target.dataset?.del;
    if (delId && confirm('Delete this result?')) deleteAttempt(delId);
  });

  // Login form
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email    = $('#login-email').value.trim();
    const password = $('#login-password').value;
    if (!email || !password) return;
    const btn = $('#login-submit');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      await signInWithPassword(email, password);
      // onAuthStateChange handles the redirect
    } catch (err) {
      alert(`Sign in failed: ${err.message}`);
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('#nav-signout').addEventListener('click', signOut);

  // Start questions fetch in parallel with auth restore so guests pay no
  // startup cost waiting on Supabase. Attach a no-op handler to avoid an
  // unhandled-rejection warning if it errors before we await it below.
  const questionsPromise = loadQuestions();
  questionsPromise.catch(() => {});

  // Auth: restore existing session, then subscribe to changes
  const { data: { session } } = await sbClient.auth.getSession();

  // Strip access_token/refresh_token from the URL hash after a magic-link
  // round-trip so the JWT doesn't linger in browser history or screen shares.
  if (session?.user && /access_token=|refresh_token=/.test(window.location.hash)) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  updateNavAuth(session?.user ?? null);
  if (session?.user) {
    state.handledInitialAuth = true;
    await drainPendingSync(session.user);
    await offerLocalMigration(session.user);
  }

  sbClient.auth.onAuthStateChange(async (event, session) => {
    const user = session?.user ?? null;
    updateNavAuth(user);

    // Strip the Supabase token hash left in the URL after a magic-link callback
    // (e.g. /#access_token=... or the leftover /#/).
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    // SIGNED_IN fires on token refresh too, so gate the one-time side effects
    // on a flag rather than the previous user state.
    if (event === 'SIGNED_IN' && user && !state.handledInitialAuth) {
      state.handledInitialAuth = true;
      await drainPendingSync(user);
      await offerLocalMigration(user);
      // Only auto-navigate when the user is actually on /login — don't yank
      // them off the home page.
      if (currentSegments()[0] === 'login') navigate('history');
    }

    if (event === 'SIGNED_OUT') {
      state.handledInitialAuth = false;
      state.cachedResults = null;
      navigate('');
    }
  });

  // GH Pages SPA deep-link redirect restore
  const stored = sessionStorage.getItem('citz.spa-redirect');
  if (stored) {
    sessionStorage.removeItem('citz.spa-redirect');
    try { window.history.replaceState(null, '', stored); } catch (e) { /* cross-origin guard */ }
  }

  window.addEventListener('popstate', route);
  setupChartTooltip();

  try {
    await questionsPromise;
    route();
  } catch (err) {
    document.body.innerHTML = `<main><p style="color:red">Failed to load questions.json: ${err.message}. Serve the site over HTTP (run <code>make</code>).</p></main>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
