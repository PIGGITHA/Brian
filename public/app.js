/* Brian dashboard. Vanilla JS: one state object from /api/state, re-rendered on change. */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const BACKDROPS = ['/img/lake.jpg', '/img/valley.jpg', '/img/mist.jpg'];
const HOME_BACKDROP = '/img/night.jpg';

let state = null;
let tab = localStorage.getItem('brian.tab') || 'home';
let chatLog = [];

const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = (n) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const ago = (iso) => {
  if (!iso) return '';
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z');
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};
const fmtTime = (t) => {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    showLogin(data.setup);
    throw new Error('Please sign in.');
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
const tool = async (name, input) => (await api('/api/tool', { name, input })).result;

let toastTimer;
function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3600);
}

function setBackdrop(url) {
  const a = $('#bgA'), b = $('#bgB');
  const [front, back] = a.classList.contains('on') ? [a, b] : [b, a];
  if (front.dataset.url === url) return;
  const img = new Image();
  img.onload = () => {
    back.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
    back.dataset.url = url;
    back.classList.add('on');
    front.classList.remove('on');
  };
  img.src = url;
}
const backdropFor = (p, i) => safeUrl(p.cover) || BACKDROPS[i % BACKDROPS.length];

// ---------- Schedule helpers (times are in your local time) ----------
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const timesOf = (a) => (a.schedule_times || '').split(',').filter(Boolean);
const runsOn = (a, dow) => !a.schedule_days || a.schedule_days === 'daily' || a.schedule_days.split(',').map((d) => d.trim().slice(0, 3)).includes(DAYS[dow]);
function nextSlot(a) {
  const now = new Date();
  for (let d = 0; d < 8; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    if (!runsOn(a, day.getDay())) continue;
    for (const t of timesOf(a)) {
      const [h, m] = t.split(':').map(Number);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
      if (at > now) return at;
    }
  }
  return null;
}
function untilText(at) {
  const m = Math.round((at - Date.now()) / 60000);
  if (m < 60) return `in ${m}m`;
  if (m < 1440) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  return at.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + fmtTime(`${at.getHours()}:${at.getMinutes()}`);
}

// ---------- Rendering ----------
function render() {
  if (!state) return;
  if (tab !== 'home' && !state.projects.some((p) => String(p.id) === String(tab))) tab = 'home';
  localStorage.setItem('brian.tab', tab);
  $('#tabs').innerHTML =
    `<button class="tab ${tab === 'home' ? 'on' : ''}" data-action="tab" data-id="home">Overview</button>` +
    state.projects.map((p) => `<button class="tab ${String(p.id) === String(tab) ? 'on' : ''}" data-action="tab" data-id="${p.id}">${esc(p.name)}</button>`).join('') +
    `<button class="tab add" data-action="new-project" title="New project">+</button>`;
  if (tab === 'home') {
    setBackdrop(HOME_BACKDROP);
    $('#view').innerHTML = renderHome();
  } else {
    const i = state.projects.findIndex((p) => String(p.id) === String(tab));
    setBackdrop(backdropFor(state.projects[i], i));
    $('#view').innerHTML = renderProject(state.projects[i]);
  }
}

function tile(label, value, sub = '', extra = '') {
  return `<div class="glass tile"><div class="label"><span>${esc(label)}</span>${extra}</div><div class="value num">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

function taskRows(tasks, withProject) {
  if (!tasks.length) return `<div class="empty">Nothing is waiting on Claude.</div>`;
  return `<div class="rows">${tasks
    .map((t) => {
      const proj = withProject && t.project_id ? state.projects.find((p) => p.id === t.project_id)?.name : '';
      return `<div class="row"><span class="status ${t.status === 'done' ? 'ok' : 'wait'}"></span>
        <div class="grow"><div>${esc(t.request)}</div>${t.result ? `<div class="muted">${esc(t.result)}</div>` : ''}
        <div class="muted small">${t.status === 'done' ? 'Answered ' + ago(t.completed_at) : 'Waiting for Claude · asked ' + ago(t.created_at)}${proj ? ' · ' + esc(proj) : ''}</div></div>
        ${t.status === 'pending' ? `<button class="icon-btn" data-action="cancel-task" data-id="${t.id}" title="Cancel">×</button>` : ''}</div>`;
    })
    .join('')}</div>`;
}

function renderHome() {
  const h = new Date().getHours();
  const greeting = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const P = state.projects;
  const total = (k) => P.reduce((t, p) => t + p.totals[k], 0);
  const c = state.config;
  const check = (ok, label, hint) => `<div class="row"><span class="status ${ok ? 'ok' : ''}"></span><div class="grow"><div>${label}</div><div class="muted small">${hint}</div></div></div>`;
  return `
  <div class="hero"><div><h1 class="serif">${greeting}, sir.</h1>
    <p>${P.length ? `${P.length} project${P.length > 1 ? 's' : ''} in hand. ${money(total('profit_today'))} earned today.` : 'Nothing in hand yet. Shall we begin a project?'}</p></div>
    <div class="hero-actions"><button class="btn" data-action="ask-claude">Ask Claude to check something</button></div></div>
  <div class="grid tiles">
    ${tile('Total profit', money(total('profit')), `${money(total('profit_7d'))} in the last 7 days`)}
    ${tile('Today', money(total('profit_today')))}
    ${tile('Views', compact(total('views')))}
    ${tile('Followers', compact(total('followers')), `${total('accounts')} account${total('accounts') === 1 ? '' : 's'}`)}
  </div>
  <section class="block"><div class="block-head"><h2>Projects</h2></div>
    <div class="grid cards">
      ${P.map((p, i) => `<button class="glass project-card" data-action="tab" data-id="${p.id}">
          <div class="cover" style="background-image:url('${esc(backdropFor(p, i))}')"></div>
          <div class="body"><h3 class="serif">${esc(p.name)}</h3><div class="muted">${esc(p.description || (p.kind === 'clipping' ? 'Clipping farm' : 'Project'))}</div>
          <div class="meta"><span><b class="num">${money(p.totals.profit)}</b> profit</span><span><b class="num">${compact(p.totals.views)}</b> views</span><span><b class="num">${p.totals.accounts}</b> accounts</span></div></div>
        </button>`).join('')}
      <button class="glass project-card new" data-action="new-project"><span>+</span>New project</button>
    </div></section>
  <section class="block"><div class="grid split">
    <div class="glass panel"><h3>Waiting on Claude <button class="btn small" data-action="ask-claude">New request</button></h3>${taskRows(state.tasks, true)}</div>
    <div class="glass panel"><h3>Brian's connections</h3><div class="rows">
      ${check(c.claude, 'Brain (Claude API)', c.claude ? esc(c.model) : 'Add the ANTHROPIC_API_KEY secret')}
      ${check(c.twilio, 'Phone line (Twilio)', c.twilio ? 'Ring or text ' + esc(c.phone_number) + ' any time' : 'Add the Twilio secrets to enable calls and texts')}
      ${check(c.youtube, 'YouTube stats', c.youtube ? 'Refreshing every hour' : 'Add YOUTUBE_API_KEY for automatic views and followers')}
      ${check(Boolean(c.connector_url), 'Claude project connector', c.connector_url ? 'Add this URL as a custom connector in Claude:' : 'Add the CONNECTOR_TOKEN secret')}
      </div>
      ${c.connector_url ? `<div class="code" style="margin-top:8px">${esc(c.connector_url)}</div>` : ''}
      <div class="row" style="margin-top:10px"><div class="grow"><div>Daily briefing call</div><div class="muted small">${state.settings.briefing_time ? 'Brian rings at ' + fmtTime(state.settings.briefing_time) + ' (' + esc(state.settings.timezone) + ')' : 'Off'}</div></div>
        <button class="btn small" data-action="briefing">Change</button></div>
    </div>
  </div></section>`;
}

function renderAccount(a) {
  const next = nextSlot(a);
  const nowHM = new Date().toTimeString().slice(0, 5);
  const today = runsOn(a, new Date().getDay());
  const nextHM = next && next.toDateString() === new Date().toDateString() ? next.toTimeString().slice(0, 5) : null;
  const url = safeUrl(a.url);
  const avatar = safeUrl(a.avatar) ? `<img class="avatar" src="${esc(a.avatar)}" alt="" referrerpolicy="no-referrer">` : `<div class="avatar">${esc((a.name || a.handle || '?').replace('@', '').charAt(0).toUpperCase())}</div>`;
  return `<div class="glass account">
    <div class="account-head">${avatar}
      <div class="who"><strong>${esc(a.name || a.handle)}</strong>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(a.handle || a.platform)}</a>` : `<span class="muted small">${esc(a.handle || '')}</span>`}</div>
      <span class="pill">${esc(a.platform)}</span>
      <button class="icon-btn" data-action="edit-account" data-id="${a.id}" title="Edit">⋯</button></div>
    <div class="metrics">
      <div class="metric"><div class="k">Followers</div><div class="v num">${compact(a.followers)}</div>${a.followers_today ? `<div class="d">${a.followers_today > 0 ? '+' : ''}${compact(a.followers_today)} today</div>` : ''}</div>
      <div class="metric"><div class="k">Views</div><div class="v num">${compact(a.views)}</div>${a.views_today ? `<div class="d">+${compact(a.views_today)} today</div>` : ''}</div>
      <div class="metric"><div class="k">Profit</div><div class="v num">${money(a.profit)}</div></div>
    </div>
    <div class="sched"><span class="lbl">Posts ${esc(!a.schedule_days || a.schedule_days === 'daily' ? 'daily' : a.schedule_days)}</span>
      ${timesOf(a).length ? timesOf(a).map((t) => `<span class="pill ${t === nextHM ? 'next' : today && t < nowHM ? 'past' : ''}">${fmtTime(t)}</span>`).join('') : `<button class="btn small" data-action="edit-account" data-id="${a.id}">Set schedule</button>`}
      ${next ? `<span class="muted small">next ${untilText(next)}</span>` : ''}</div>
    ${a.posts.length ? `<div class="posts">${a.posts.slice(0, 3).map((x) => `<a class="post" href="https://www.youtube.com/watch?v=${encodeURIComponent(x.video_id)}" target="_blank" rel="noopener">
        ${safeUrl(x.thumb) ? `<img src="${esc(x.thumb)}" alt="" loading="lazy">` : ''}<span class="t">${esc(x.title)}</span><span class="m num">${compact(x.views)} · ${ago(x.published_at)}</span></a>`).join('')}</div>` : ''}
    ${a.notes ? `<div class="muted small" style="margin-top:10px">${esc(a.notes)}</div>` : ''}
  </div>`;
}

function renderTimeline(p) {
  const dow = new Date().getDay();
  const slots = p.accounts.filter((a) => runsOn(a, dow)).flatMap((a) => timesOf(a).map((t) => ({ t, a }))).sort((x, y) => x.t.localeCompare(y.t));
  if (!slots.length) return '';
  const nowHM = new Date().toTimeString().slice(0, 5);
  const nextIdx = slots.findIndex((s) => s.t >= nowHM);
  return `<section class="block"><div class="block-head"><h2>Today's posting schedule</h2><span class="muted small">${slots.filter((s) => s.t < nowHM).length} of ${slots.length} slots passed</span></div>
    <div class="glass panel"><div class="timeline">${slots.map((s, i) => `<div class="slot ${i === nextIdx ? 'next' : s.t < nowHM ? 'past' : ''}"><div class="time num">${fmtTime(s.t)}</div><div class="who">${esc(s.a.name || s.a.handle)}</div></div>`).join('')}</div></div></section>`;
}

function renderBars(p) {
  const days = [...Array(14)].map((_, i) => {
    const d = new Date(Date.now() - (13 - i) * 864e5);
    return new Intl.DateTimeFormat('en-CA', { timeZone: state.settings.timezone }).format(d);
  });
  const vals = days.map((d) => p.earnings_by_day[d] || 0);
  const max = Math.max(1, ...vals.map(Math.abs));
  return `<div class="bars">${days.map((d, i) => `<div class="bar" title="${d}: ${money(vals[i])}"><i class="${vals[i] < 0 ? 'neg' : ''}" style="height:${Math.round((Math.abs(vals[i]) / max) * 100)}%"></i><span>${Number(d.slice(8))}</span></div>`).join('')}</div>`;
}

function renderProject(p) {
  const t = p.totals;
  const clipping = p.kind === 'clipping' || p.accounts.length > 0;
  const tasks = state.tasks.filter((x) => x.project_id === p.id);
  const custom = p.stats.map((s) => tile(s.label, esc(s.value), 'updated ' + ago(s.updated_at), `<button class="icon-btn" style="margin:-6px -8px" data-action="edit-stat" data-label="${esc(s.label)}" title="Edit">⋯</button>`)).join('');
  const accountName = (id) => { const a = p.accounts.find((x) => x.id === id); return a ? a.name || a.handle : ''; };
  return `
  <div class="hero"><div><h1 class="serif">${esc(p.name)}</h1><p>${esc(p.description || (clipping ? 'Accounts, schedules, views and profit at a glance.' : 'Everything for this project in one place.'))}</p></div>
    <div class="hero-actions">
      ${clipping ? `<button class="btn" data-action="refresh">Refresh stats</button>` : ''}
      <button class="btn" data-action="ask-claude">Ask Claude</button>
      <button class="btn" data-action="edit-project">Edit project</button></div></div>
  <div class="grid tiles">
    ${tile('Profit', money(t.profit), `${money(t.profit_7d)} in the last 7 days`)}
    ${tile('Today', money(t.profit_today))}
    ${clipping ? tile('Views', compact(t.views)) + tile('Followers', compact(t.followers), `${t.accounts} account${t.accounts === 1 ? '' : 's'}`) : ''}
    ${custom}
    <button class="glass tile project-card new" style="min-height:0" data-action="add-stat"><span>+</span>Add a stat</button>
  </div>
  ${clipping ? `<section class="block"><div class="block-head"><h2>Accounts</h2><button class="btn small" data-action="add-account">Add account</button></div>
    ${p.accounts.length ? `<div class="grid cards">${p.accounts.map(renderAccount).join('')}</div>` : `<div class="glass panel empty">No accounts yet. Add your first channel and Brian will start tracking it.</div>`}</section>
  ${renderTimeline(p)}` : ''}
  <section class="block"><div class="grid split">
    <div class="glass panel"><h3>Earnings <span><button class="btn small" data-action="set-total">Set total</button> <button class="btn small" data-action="add-earning">Log earning</button></span></h3>
      ${renderBars(p)}
      ${p.earnings.length ? `<div class="rows" style="margin-top:12px">${p.earnings.slice(0, 12).map((e) => `<div class="row"><div class="grow"><div>${esc(e.note || 'Earning')}</div><div class="muted small">${esc(e.day)}${e.account_id ? ' · ' + esc(accountName(e.account_id)) : ''} · via ${esc(e.source)}</div></div>
          <span class="amt num ${e.amount < 0 ? 'neg' : ''}">${money(e.amount)}</span><button class="icon-btn" data-action="delete-earning" data-id="${e.id}" title="Delete">×</button></div>`).join('')}</div>` : `<div class="empty">No earnings logged yet.</div>`}
    </div>
    <div class="stack">
      <div class="glass panel"><h3>Waiting on Claude <button class="btn small" data-action="ask-claude">New request</button></h3>${taskRows(tasks, false)}</div>
      <div class="glass panel"><h3>Notes <button class="btn small" data-action="add-note">Add note</button></h3>
        ${p.notes.length ? `<div class="rows">${p.notes.map((n) => `<div class="row"><div class="grow"><div>${esc(n.text)}</div><div class="muted small">${ago(n.created_at)}</div></div><button class="icon-btn" data-action="delete-note" data-id="${n.id}" title="Delete">×</button></div>`).join('')}</div>` : `<div class="empty">No notes yet. Tell Brian anything worth remembering.</div>`}</div>
      <div class="glass panel"><h3>Brian's standing instructions <button class="btn small" data-action="edit-instructions">Edit</button></h3>
        <div class="prose">${esc(p.instructions) || 'None yet. Paste your Claude project instructions here so Brian knows how this project runs.'}</div></div>
      ${!clipping ? `<div class="glass panel"><h3>Accounts <button class="btn small" data-action="add-account">Add account</button></h3><div class="empty">Track social or channel accounts on this project.</div></div>` : ''}
    </div>
  </div></section>`;
}

// ---------- Modal forms ----------
function form({ title, fields, submit, submitLabel = 'Save', extra = '' }) {
  return new Promise((resolve) => {
    const f = $('#modalForm');
    f.innerHTML = `<h3 class="serif">${esc(title)}</h3>` +
      fields.map((x) => {
        const attrs = `name="${x.name}" placeholder="${esc(x.placeholder || '')}" ${x.required ? 'required' : ''}`;
        const input = x.type === 'textarea' ? `<textarea ${attrs}>${esc(x.value ?? '')}</textarea>`
          : x.type === 'select' ? `<select name="${x.name}">${x.options.map((o) => `<option value="${esc(o[0])}" ${String(o[0]) === String(x.value ?? '') ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`
          : `<input type="${x.type || 'text'}" ${x.step ? `step="${x.step}"` : ''} ${attrs} value="${esc(x.value ?? '')}">`;
        return `<label class="field">${esc(x.label)}${input}</label>`;
      }).join('') +
      `<p class="error"></p><div class="actions">${extra}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${esc(submitLabel)}</button></div>`;
    $('#modal').hidden = false;
    f.querySelector('input, textarea, select')?.focus();
    const close = (v) => { $('#modal').hidden = true; f.onsubmit = f.onclick = null; resolve(v); };
    f.onclick = async (e) => {
      if (e.target.closest('[data-close]')) close(null);
      const x = e.target.closest('[data-extra]');
      if (x) { e.preventDefault(); close({ extra: x.dataset.extra }); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(f));
      const btn = f.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        await submit(values);
        close(values);
      } catch (err) {
        f.querySelector('.error').textContent = err.message;
        btn.disabled = false;
      }
    };
  });
}
const current = () => state.projects.find((p) => String(p.id) === String(tab));
const projectField = () => tab === 'home' && state.projects.length ? [{ name: 'project', label: 'Project', type: 'select', options: [['', 'General'], ...state.projects.map((p) => [p.id, p.name])] }] : [];

const actions = {
  tab: (el) => { tab = el.dataset.id; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); },
  'toggle-chat': () => { $('#chat').hidden = !$('#chat').hidden; if (!$('#chat').hidden) $('#chatInput').focus(); },
  call: async () => {
    if (!state.config.twilio) return toast('The phone line is not connected yet, sir. Add the Twilio secrets first.');
    await api('/api/call', {});
    toast('Ringing your mobile now, sir.');
  },
  'new-project': async () => {
    let made;
    await form({
      title: 'New project', submitLabel: 'Create',
      fields: [{ name: 'name', label: 'Name', required: true, placeholder: 'e.g. Clipping' },
        { name: 'kind', label: 'Type', type: 'select', options: [['clipping', 'Clipping / social accounts'], ['general', 'General project']] },
        { name: 'description', label: 'Description', placeholder: 'One line about it' }],
      submit: async (v) => { made = await tool('create_project', v); },
    });
    if (made) { tab = String(made.id); await load(); }
  },
  'edit-project': async () => {
    const p = current();
    const r = await form({
      title: 'Edit project',
      fields: [{ name: 'name', label: 'Name', value: p.name, required: true },
        { name: 'kind', label: 'Type', type: 'select', value: p.kind, options: [['clipping', 'Clipping / social accounts'], ['general', 'General project']] },
        { name: 'description', label: 'Description', value: p.description },
        { name: 'cover', label: 'Background image URL (optional)', value: p.cover, placeholder: 'https://…' }],
      extra: `<button type="button" class="btn danger" data-extra="delete" style="margin-right:auto">Delete</button>`,
      submit: (v) => tool('update_project', { project: p.id, ...v }),
    });
    if (r?.extra === 'delete') {
      if (confirm(`Delete "${p.name}" and everything in it? This cannot be undone.`)) { await tool('delete_project', { project: p.id }); tab = 'home'; }
    }
    await load();
  },
  'edit-instructions': async () => {
    const p = current();
    await form({ title: 'Standing instructions', fields: [{ name: 'instructions', label: `How ${p.name} runs. Brian reads this before every conversation.`, type: 'textarea', value: p.instructions }], submit: (v) => tool('update_project', { project: p.id, ...v }) });
    await load();
  },
  'add-account': async () => {
    const p = current();
    await form({
      title: 'Add account', submitLabel: 'Add',
      fields: [{ name: 'platform', label: 'Platform', type: 'select', options: [['youtube', 'YouTube'], ['tiktok', 'TikTok'], ['instagram', 'Instagram'], ['x', 'X'], ['other', 'Other']] },
        { name: 'handle', label: 'Handle or channel URL', required: true, placeholder: '@yourchannel' },
        { name: 'posting_times', label: 'Daily posting times (24-hour, comma separated)', placeholder: '09:00, 15:00, 21:00' }],
      submit: async (v) => { const r = await tool('save_account', { project: p.id, ...v }); if (r.sync_error) toast('Saved, but YouTube said: ' + r.sync_error); },
    });
    await load();
  },
  'edit-account': async (el) => {
    const p = current();
    const a = p.accounts.find((x) => String(x.id) === el.dataset.id);
    const manual = a.platform !== 'youtube' || !state.config.youtube;
    const r = await form({
      title: a.name || a.handle,
      fields: [{ name: 'name', label: 'Name', value: a.name },
        { name: 'handle', label: 'Handle', value: a.handle },
        { name: 'posting_times', label: 'Posting times (24-hour, comma separated)', value: timesOf(a).join(', '), placeholder: '09:00, 15:00, 21:00' },
        { name: 'posting_days', label: 'Posting days', value: a.schedule_days || 'daily', placeholder: 'daily or mon,wed,fri' },
        ...(manual ? [{ name: 'followers', label: 'Followers', type: 'number', value: a.followers }, { name: 'views', label: 'Total views', type: 'number', value: a.views }] : []),
        { name: 'notes', label: 'Notes', value: a.notes }],
      extra: `<button type="button" class="btn danger" data-extra="remove" style="margin-right:auto">Remove</button>`,
      submit: (v) => tool('save_account', { project: p.id, account: a.id, ...v, ...(manual ? { followers: Number(v.followers), views: Number(v.views) } : {}) }),
    });
    if (r?.extra === 'remove' && confirm(`Remove ${a.name || a.handle}?`)) await tool('remove_account', { account: a.id });
    await load();
  },
  'add-earning': async () => {
    const p = current();
    await form({
      title: 'Log earning', submitLabel: 'Log',
      fields: [{ name: 'amount', label: 'Amount ($, negative for a cost)', type: 'number', step: '0.01', required: true, placeholder: '25.00' },
        ...(p.accounts.length ? [{ name: 'account', label: 'Account', type: 'select', options: [['', 'Whole project'], ...p.accounts.map((a) => [a.id, a.name || a.handle])] }] : []),
        { name: 'day', label: 'Date', type: 'date', value: state.now.day },
        { name: 'note', label: 'Note', placeholder: 'Content Rewards payout' }],
      submit: (v) => tool('log_earning', { project: p.id, ...v, amount: Number(v.amount), account: v.account || undefined }),
    });
    await load();
  },
  'set-total': async () => {
    const p = current();
    await form({
      title: 'Set profit total',
      fields: [{ name: 'total', label: 'All-time total shown on the platform ($). Brian logs the difference as today\'s earnings.', type: 'number', step: '0.01', required: true, value: p.totals.profit },
        ...(p.accounts.length ? [{ name: 'account', label: 'For', type: 'select', options: [['', 'Whole project'], ...p.accounts.map((a) => [a.id, a.name || a.handle])] }] : [])],
      submit: (v) => tool('set_profit_total', { project: p.id, total: Number(v.total), account: v.account || undefined }),
    });
    await load();
  },
  'delete-earning': async (el) => { if (confirm('Delete this entry?')) { await tool('delete_earning', { id: Number(el.dataset.id) }); await load(); } },
  'add-stat': async () => {
    await form({ title: 'Add a stat', fields: [{ name: 'label', label: 'Label', required: true, placeholder: 'Clips this week' }, { name: 'value', label: 'Value', required: true, placeholder: '42' }], submit: (v) => tool('set_stat', { project: current().id, ...v }) });
    await load();
  },
  'edit-stat': async (el) => {
    const p = current();
    const s = p.stats.find((x) => x.label === el.dataset.label);
    const r = await form({ title: s.label, fields: [{ name: 'value', label: 'Value', value: s.value, required: true }],
      extra: `<button type="button" class="btn danger" data-extra="remove" style="margin-right:auto">Remove</button>`,
      submit: (v) => tool('set_stat', { project: p.id, label: s.label, value: v.value }) });
    if (r?.extra === 'remove') await tool('set_stat', { project: p.id, label: s.label, value: '' });
    await load();
  },
  'add-note': async () => {
    await form({ title: 'Add note', fields: [{ name: 'text', label: 'Note', type: 'textarea', required: true }], submit: (v) => tool('add_note', { project: current().id, ...v }) });
    await load();
  },
  'delete-note': async (el) => { await tool('delete_note', { id: Number(el.dataset.id) }); await load(); },
  'ask-claude': async () => {
    const p = current();
    await form({
      title: 'Ask Claude', submitLabel: 'Queue request',
      fields: [{ name: 'request', label: 'What should Claude on your desktop do? It will pick this up the next time it checks in with Brian.', type: 'textarea', required: true, placeholder: 'Open Content Rewards and tell me my current earnings.' },
        ...projectField(),
        { name: 'notify', label: 'When the answer comes back', type: 'select', options: [['none', 'Just show it here'], ['text', 'Text me'], ['call', 'Call me']] }],
      submit: (v) => tool('ask_claude', { ...v, project: p ? p.id : v.project || undefined }),
    });
    await load();
  },
  'cancel-task': async (el) => { await tool('cancel_claude_task', { task_id: Number(el.dataset.id) }); await load(); },
  refresh: async (el) => {
    if (!state.config.youtube) return toast('Add the YOUTUBE_API_KEY secret to enable automatic stats, sir.');
    el.disabled = true;
    const r = await tool('refresh_youtube', { project: current().id });
    toast(r.errors.length ? r.errors[0] : `Refreshed ${r.synced} account${r.synced === 1 ? '' : 's'}.`);
    await load();
  },
  briefing: async () => {
    await form({ title: 'Daily briefing call', fields: [{ name: 'briefing_time', label: `Time for Brian to ring you each day (${state.settings.timezone}). Leave empty to turn it off.`, type: 'time', value: state.settings.briefing_time }], submit: (v) => api('/api/settings', v) });
    await load();
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  try {
    await actions[el.dataset.action](el);
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Chat ----------
function renderChat() {
  $('#chatLog').innerHTML = chatLog.map((m) => `<div class="msg ${m.who}${m.thinking ? ' thinking' : ''}">${esc(m.text)}</div>`).join('');
  $('#chatLog').scrollTop = 1e9;
}
$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  $('#chatInput').value = '';
  chatLog.push({ who: 'me', text }, { who: 'brian', text: 'One moment, sir…', thinking: true });
  renderChat();
  try {
    const r = await api('/api/chat', { message: text });
    chatLog[chatLog.length - 1] = { who: 'brian', text: r.reply };
    load();
  } catch (err) {
    chatLog[chatLog.length - 1] = { who: 'brian', text: err.message };
  }
  renderChat();
});

// ---------- Boot ----------
function showLogin(needsSetup) {
  setBackdrop(HOME_BACKDROP);
  $('#app').hidden = $('#chatFab').hidden = true;
  $('#chat').hidden = true;
  $('#login').hidden = false;
  if (needsSetup) $('#loginHint').textContent = 'Set the DASHBOARD_PASSWORD secret to finish setting me up, sir.';
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/login', { password: $('#loginPassword').value });
    $('#login').hidden = true;
    await load();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

async function load() {
  state = await api('/api/state');
  $('#app').hidden = $('#chatFab').hidden = false;
  if ($('#modal').hidden) render();
}
chatLog.push({ who: 'brian', text: 'Good day, sir. How may I help?' });
renderChat();
load().catch(() => {});
setInterval(() => { if (!document.hidden && state) load().catch(() => {}); }, 60000);
