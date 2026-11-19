// One tool registry, shared by Brian (voice, text, chat), the dashboard, and the Claude connector.
// audience: 'all' | 'brian' (Brian only) | 'claude' (connector only)
import { all, first, run, findProject, findAccount, snapshot, slugify, localNow } from './db.js';
import { syncAccount, syncAll, parseChannelRef } from './youtube.js';
import { callOwner, textOwner } from './twilio.js';

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const PROJECT = str('Project name, slug, or id. May be omitted when there is only one project.');

function compactProject(p) {
  return {
    id: p.id, name: p.name, kind: p.kind, description: p.description, totals: p.totals,
    accounts: p.accounts.map((a) => ({
      id: a.id, platform: a.platform, name: a.name, handle: a.handle, followers: a.followers, views: a.views,
      views_today: a.views_today, profit: a.profit, posting_times: a.schedule_times, posting_days: a.schedule_days,
      latest_posts: a.posts.slice(0, 3).map((x) => ({ title: x.title, views: x.views, published: x.published_at })),
    })),
    stats: Object.fromEntries(p.stats.map((s) => [s.label, s.value])),
  };
}

export async function overview(env) {
  const s = await snapshot(env);
  return {
    now: s.now,
    projects: s.projects.map(compactProject),
    pending_claude_tasks: s.tasks.filter((t) => t.status === 'pending').map((t) => ({ id: t.id, request: t.request })),
    recent_claude_results: s.tasks.filter((t) => t.status === 'done').slice(0, 3).map((t) => ({ request: t.request, result: t.result, completed_at: t.completed_at })),
  };
}

function cleanTimes(value) {
  if (value === undefined || value === null) return undefined;
  const list = (Array.isArray(value) ? value : String(value).split(/[,;\s]+/)).map((t) => String(t).trim()).filter(Boolean);
  return list
    .map((t) => {
      const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
      if (!m) throw new Error(`"${t}" is not a time. Use 24-hour HH:MM, for example 09:00 or 18:30.`);
      let h = Number(m[1]);
      if (m[3]) h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
      if (h > 23 || Number(m[2] || 0) > 59) throw new Error(`"${t}" is not a valid time.`);
      return `${String(h).padStart(2, '0')}:${m[2] || '00'}`;
    })
    .sort()
    .join(',');
}

export const TOOLS = [
  {
    name: 'get_overview',
    audience: 'all',
    description: 'Current state of every project: accounts, followers, views, posting schedules, profit totals, custom stats, and pending tasks.',
    input_schema: { type: 'object', properties: {} },
    run: (env) => overview(env),
  },
  {
    name: 'get_project',
    audience: 'all',
    description: 'Full detail for one project, including its instructions, notes, recent posts and the earnings log.',
    input_schema: { type: 'object', properties: { project: PROJECT } },
    run: async (env, i) => {
      const p = await findProject(env, i.project);
      const full = (await snapshot(env)).projects.find((x) => x.id === p.id);
      return { ...compactProject(full), instructions: full.instructions, notes: full.notes, earnings_log: full.earnings.slice(0, 20), earnings_by_day: full.earnings_by_day };
    },
  },
  {
    name: 'create_project',
    audience: 'all',
    description: 'Create a new project. It appears as a new tab in the dashboard. Use kind "clipping" for social/clipping account farms, "general" for anything else.',
    input_schema: {
      type: 'object',
      properties: { name: str('Project name'), kind: { type: 'string', enum: ['clipping', 'general'] }, description: str('One-line description') },
      required: ['name'],
    },
    run: async (env, i) => {
      const name = String(i.name || '').trim();
      if (!name) throw new Error('A project name is required.');
      let slug = slugify(name);
      if (await first(env, 'SELECT id FROM projects WHERE slug = ?', slug)) slug += '-' + Date.now().toString(36).slice(-4);
      const r = await run(env, 'INSERT INTO projects (slug, name, kind, description) VALUES (?, ?, ?, ?)', slug, name, i.kind || 'general', i.description || '');
      return { created: true, id: r.meta.last_row_id, name, slug };
    },
  },
  {
    name: 'update_project',
    audience: 'all',
    description: 'Rename a project or change its description, kind, cover image URL, or the standing instructions Brian follows for it.',
    input_schema: {
      type: 'object',
      properties: { project: PROJECT, name: str('New name'), kind: { type: 'string', enum: ['clipping', 'general'] }, description: str('Description'), instructions: str('Standing instructions and context for this project'), cover: str('Background image URL for the project tab') },
    },
    run: async (env, i) => {
      const p = await findProject(env, i.project);
      for (const f of ['name', 'kind', 'description', 'instructions', 'cover']) {
        if (i[f] !== undefined) await run(env, `UPDATE projects SET ${f} = ? WHERE id = ?`, String(i[f]), p.id);
      }
      return { updated: true, project: i.name || p.name };
    },
  },
  {
    name: 'delete_project',
    audience: 'all',
    description: 'Permanently delete a project and everything in it. Only do this when explicitly asked, and confirm first.',
    input_schema: { type: 'object', properties: { project: str('Project name, slug, or id') }, required: ['project'] },
    run: async (env, i) => {
      const p = await findProject(env, i.project);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM posts WHERE account_id IN (SELECT id FROM accounts WHERE project_id = ?)').bind(p.id),
        env.DB.prepare('DELETE FROM snapshots WHERE account_id IN (SELECT id FROM accounts WHERE project_id = ?)').bind(p.id),
        ...['accounts', 'earnings', 'stats', 'notes', 'tasks'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE project_id = ?`).bind(p.id)),
        env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(p.id),
      ]);
      return { deleted: true, project: p.name };
    },
  },
  {
    name: 'save_account',
    audience: 'all',
    description:
      'Add an account to a project, or update an existing one (pass account to update). YouTube accounts sync followers, views and recent posts automatically; for other platforms pass followers and views by hand. posting_times are the daily upload slots.',
    input_schema: {
      type: 'object',
      properties: {
        project: PROJECT,
        account: str('Existing account id, handle, or name to update. Omit to add a new account.'),
        platform: str('youtube, tiktok, instagram, x, ...'),
        handle: str('Handle or channel URL, e.g. @mychannel'),
        name: str('Display name'),
        posting_times: str('Comma-separated 24-hour times, e.g. "09:00,15:00,21:00". Empty string clears the schedule.'),
        posting_days: str('"daily" or comma-separated days, e.g. "mon,wed,fri"'),
        followers: num('Follower count (manual platforms)'),
        views: num('Total views (manual platforms)'),
        notes: str('Notes about the account'),
      },
    },
    run: async (env, i) => {
      const p = await findProject(env, i.project);
      const times = cleanTimes(i.posting_times);
      let acc = i.account ? await findAccount(env, i.account, p.id) : null;
      if (!acc) {
        if (!i.handle && !i.name) throw new Error('A handle or name is required to add an account.');
        const platform = (i.platform || 'youtube').toLowerCase();
        const ref = platform === 'youtube' ? parseChannelRef(i.handle) : {};
        const handle = ref.handle || i.handle || '';
        const r = await run(
          env,
          'INSERT INTO accounts (project_id, platform, handle, channel_id, name, url) VALUES (?, ?, ?, ?, ?, ?)',
          p.id, platform, handle, ref.id || '', i.name || handle, /^https?:/.test(i.handle || '') ? i.handle : '',
        );
        acc = await first(env, 'SELECT * FROM accounts WHERE id = ?', r.meta.last_row_id);
      } else {
        for (const f of ['platform', 'handle', 'name']) if (i[f] !== undefined) await run(env, `UPDATE accounts SET ${f} = ? WHERE id = ?`, String(i[f]), acc.id);
      }
      if (times !== undefined) await run(env, 'UPDATE accounts SET schedule_times = ? WHERE id = ?', times, acc.id);
      if (i.posting_days !== undefined) await run(env, 'UPDATE accounts SET schedule_days = ? WHERE id = ?', String(i.posting_days).toLowerCase() || 'daily', acc.id);
      if (i.notes !== undefined) await run(env, 'UPDATE accounts SET notes = ? WHERE id = ?', String(i.notes), acc.id);
      if (i.followers !== undefined) await run(env, 'UPDATE accounts SET followers = ? WHERE id = ?', Math.round(Number(i.followers) || 0), acc.id);
      if (i.views !== undefined) await run(env, 'UPDATE accounts SET views = ? WHERE id = ?', Math.round(Number(i.views) || 0), acc.id);
      let sync;
      acc = await first(env, 'SELECT * FROM accounts WHERE id = ?', acc.id);
      if (acc.platform === 'youtube' && env.YOUTUBE_API_KEY) {
        try {
          sync = await syncAccount(env, acc);
        } catch (e) {
          sync = { sync_error: e.message };
        }
      }
      return { saved: true, account_id: acc.id, handle: acc.handle, ...(sync || {}) };
    },
  },
  {
    name: 'remove_account',
    audience: 'all',
    description: 'Remove an account from a project. Its earnings entries stay in the project total.',
    input_schema: { type: 'object', properties: { account: str('Account id, handle, or name'), project: PROJECT }, required: ['account'] },
    run: async (env, i) => {
      const p = i.project ? await findProject(env, i.project) : null;
      const a = await findAccount(env, i.account, p?.id);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM posts WHERE account_id = ?').bind(a.id),
        env.DB.prepare('DELETE FROM snapshots WHERE account_id = ?').bind(a.id),
        env.DB.prepare('UPDATE earnings SET account_id = NULL WHERE account_id = ?').bind(a.id),
        env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(a.id),
      ]);
      return { removed: true, account: a.handle || a.name };
    },
  },
  {
    name: 'log_earning',
    audience: 'all',
    description: 'Record money earned (or a negative amount for a cost) on a project, optionally against one account.',
    input_schema: {
      type: 'object',
      properties: { project: PROJECT, amount: num('Amount in dollars; negative for costs'), account: str('Account id, handle, or name'), day: str('YYYY-MM-DD; defaults to today'), note: str('What it was for') },
      required: ['amount'],
    },
    run: async (env, i, ctx) => {
      const p = await findProject(env, i.project);
      const amount = Number(i.amount);
      if (!Number.isFinite(amount) || amount === 0) throw new Error('A non-zero amount is required.');
      const a = i.account ? await findAccount(env, i.account, p.id) : null;
      const day = /^\d{4}-\d{2}-\d{2}$/.test(i.day || '') ? i.day : localNow(env).day;
      await run(env, 'INSERT INTO earnings (project_id, account_id, amount, day, note, source) VALUES (?, ?, ?, ?, ?, ?)', p.id, a?.id ?? null, amount, day, i.note || '', ctx?.source || 'manual');
      const total = await first(env, 'SELECT COALESCE(SUM(amount), 0) AS t FROM earnings WHERE project_id = ?', p.id);
      return { logged: amount, project: p.name, project_total: Math.round(total.t * 100) / 100 };
    },
  },
  {
    name: 'set_profit_total',
    audience: 'all',
    description:
      'Set the all-time profit total for a project (or for one account) to match a figure read from the payout platform, e.g. the earnings page on Content Rewards. Brian records the difference from the current total as today\'s earnings.',
    input_schema: {
      type: 'object',
      properties: { project: PROJECT, total: num('The all-time total shown on the platform, in dollars'), account: str('Account id, handle, or name, if the total is for a single account'), note: str('Where the figure came from') },
      required: ['total'],
    },
    run: async (env, i, ctx) => {
      const p = await findProject(env, i.project);
      const target = Number(i.total);
      if (!Number.isFinite(target)) throw new Error('A numeric total is required.');
      const a = i.account ? await findAccount(env, i.account, p.id) : null;
      const cur = a
        ? await first(env, 'SELECT COALESCE(SUM(amount), 0) AS t FROM earnings WHERE project_id = ? AND account_id = ?', p.id, a.id)
        : await first(env, 'SELECT COALESCE(SUM(amount), 0) AS t FROM earnings WHERE project_id = ?', p.id);
      const delta = Math.round((target - cur.t) * 100) / 100;
      if (delta !== 0) {
        await run(env, 'INSERT INTO earnings (project_id, account_id, amount, day, note, source) VALUES (?, ?, ?, ?, ?, ?)', p.id, a?.id ?? null, delta, localNow(env).day, i.note || 'Synced to platform total', ctx?.source || 'manual');
      }
      return { project: p.name, account: a?.handle, previous_total: Math.round(cur.t * 100) / 100, new_total: target, change: delta };
    },
  },
  {
    name: 'delete_earning',
    audience: 'all',
    description: 'Delete one entry from the earnings log by its id.',
    input_schema: { type: 'object', properties: { id: num('Earnings entry id') }, required: ['id'] },
    run: async (env, i) => {
      await run(env, 'DELETE FROM earnings WHERE id = ?', Number(i.id));
      return { deleted: true };
    },
  },
  {
    name: 'set_stat',
    audience: 'all',
    description: 'Set a custom stat tile on a project dashboard (any label and value, e.g. "Clips this week" = "42"). An empty value removes the tile.',
    input_schema: { type: 'object', properties: { project: PROJECT, label: str('Tile label'), value: str('Tile value; empty string removes it') }, required: ['label', 'value'] },
    run: async (env, i) => {
      const p = await findProject(env, i.project);
      const label = String(i.label).trim();
      if (!label) throw new Error('A label is required.');
      if (String(i.value ?? '') === '') await run(env, 'DELETE FROM stats WHERE project_id = ? AND label = ?', p.id, label);
      else {
        await run(
          env,
          `INSERT INTO stats (project_id, label, value) VALUES (?, ?, ?)
           ON CONFLICT(project_id, label) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
          p.id, label, String(i.value),
        );
      }
      return { saved: true, project: p.name, label };
    },
  },
  {
    name: 'add_note',
    audience: 'all',
    description: 'Save a note, idea, or reminder against a project.',
    input_schema: { type: 'object', properties: { project: PROJECT, text: str('The note') }, required: ['text'] },
    run: async (env, i) => {
      const p = await findProject(env, i.project);
      if (!String(i.text || '').trim()) throw new Error('The note is empty.');
      await run(env, 'INSERT INTO notes (project_id, text) VALUES (?, ?)', p.id, String(i.text).trim());
      return { saved: true, project: p.name };
    },
  },
  {
    name: 'delete_note',
    audience: 'all',
    description: 'Delete a note by its id.',
    input_schema: { type: 'object', properties: { id: num('Note id') }, required: ['id'] },
    run: async (env, i) => {
      await run(env, 'DELETE FROM notes WHERE id = ?', Number(i.id));
      return { deleted: true };
    },
  },
  {
    name: 'refresh_youtube',
    audience: 'all',
    description: 'Pull the latest followers, views and recent posts from YouTube for all YouTube accounts now.',
    input_schema: { type: 'object', properties: { project: PROJECT } },
    run: async (env, i) => {
      const p = i.project ? await findProject(env, i.project) : null;
      return syncAll(env, p?.id);
    },
  },
  {
    name: 'ask_claude',
    audience: 'brian',
    description:
      'Queue a job for Claude on the owner\'s desktop computer. Claude there can use the owner\'s Chrome browser and logged-in sites (for example to read live earnings on Content Rewards) and the owner\'s Claude project. It is NOT instant: Claude picks jobs up when it next checks the queue, usually within minutes to an hour. Say so, and use notify to call or text the owner when the answer arrives.',
    input_schema: {
      type: 'object',
      properties: { request: str('Exactly what Claude should do and what to report back, written so it stands on its own'), project: PROJECT, notify: { type: 'string', enum: ['call', 'text', 'none'], description: 'How to tell the owner when the result comes back' } },
      required: ['request'],
    },
    run: async (env, i) => {
      const p = i.project ? await findProject(env, i.project).catch(() => null) : null;
      const r = await run(env, 'INSERT INTO tasks (project_id, request, notify) VALUES (?, ?, ?)', p?.id ?? null, String(i.request), i.notify || 'none');
      return { queued: true, task_id: r.meta.last_row_id, note: 'Claude will pick this up the next time it checks the queue.' };
    },
  },
  {
    name: 'cancel_claude_task',
    audience: 'all',
    description: 'Cancel a queued job for Claude by its task id.',
    input_schema: { type: 'object', properties: { task_id: num('Task id') }, required: ['task_id'] },
    run: async (env, i) => {
      await run(env, "DELETE FROM tasks WHERE id = ? AND status = 'pending'", Number(i.task_id));
      return { cancelled: true };
    },
  },
  {
    name: 'list_pending_tasks',
    audience: 'claude',
    description:
      'Jobs Brian (the owner\'s phone assistant) has queued for you. Call this at the start of every session and whenever asked to check in with Brian. Do each job, then report back with complete_task.',
    input_schema: { type: 'object', properties: {} },
    run: async (env) => ({
      tasks: await all(env, "SELECT t.id, t.request, t.created_at, p.name AS project FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.status = 'pending' ORDER BY t.id"),
    }),
  },
  {
    name: 'complete_task',
    audience: 'claude',
    description:
      'Report the result of a job from list_pending_tasks. Write the result as a short plain-English answer Brian can read aloud. If the job produced figures (e.g. profit), also save them with set_profit_total, log_earning or set_stat before completing.',
    input_schema: { type: 'object', properties: { task_id: num('Task id'), result: str('The answer, in plain English') }, required: ['task_id', 'result'] },
    run: async (env, i) => {
      const t = await first(env, 'SELECT * FROM tasks WHERE id = ?', Number(i.task_id));
      if (!t) throw new Error(`No task with id ${i.task_id}.`);
      await run(env, "UPDATE tasks SET status = 'done', result = ?, completed_at = datetime('now') WHERE id = ?", String(i.result), t.id);
      let notified = 'none';
      try {
        if (t.notify === 'call') {
          await callOwner(env, `I have an answer from Claude regarding your request: ${t.request}. ${i.result}`);
          notified = 'call';
        } else if (t.notify === 'text') {
          await textOwner(env, `Brian here, sir. ${i.result}`);
          notified = 'text';
        }
      } catch (e) {
        notified = `failed: ${e.message}`;
      }
      return { completed: true, owner_notified: notified };
    },
  },
  {
    name: 'contact_owner',
    audience: 'claude',
    description: 'Have Brian phone or text the owner with a message, e.g. when something needs their attention. Use sparingly; a call rings their mobile.',
    input_schema: { type: 'object', properties: { method: { type: 'string', enum: ['call', 'text'] }, message: str('What Brian should tell the owner') }, required: ['method', 'message'] },
    run: (env, i) => (i.method === 'call' ? callOwner(env, String(i.message)) : textOwner(env, `Brian here, sir. ${i.message}`)),
  },
  {
    name: 'send_text',
    audience: 'brian',
    description: 'Send the owner a text message (SMS) on their mobile, e.g. to pass along figures or a link they asked for.',
    input_schema: { type: 'object', properties: { message: str('The text to send') }, required: ['message'] },
    run: (env, i) => textOwner(env, String(i.message)),
  },
  {
    name: 'call_owner',
    audience: 'brian',
    description: 'Ring the owner\'s mobile now. Only use from text or chat when asked to call; never while already on a call.',
    input_schema: { type: 'object', properties: { opening: str('What to say when they pick up') } },
    run: (env, i, ctx) => {
      if (ctx?.channel === 'call') throw new Error('Already on a call with the owner.');
      return callOwner(env, i.opening || '');
    },
  },
  {
    name: 'end_call',
    audience: 'brian',
    description: 'Hang up the phone after your closing words. Use when the owner says goodbye or is clearly finished.',
    input_schema: { type: 'object', properties: {} },
    run: (env, i, ctx) => {
      if (ctx) ctx.hangup = true;
      return { ok: true };
    },
  },
];

export const toolsFor = (audience) => TOOLS.filter((t) => t.audience === 'all' || t.audience === audience);

export async function runTool(env, audience, name, input, ctx = {}) {
  const tool = toolsFor(audience).find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(env, input || {}, ctx);
}
