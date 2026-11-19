// Database helpers and schema. The schema is created automatically on first use.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS projects (
     id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, name TEXT NOT NULL,
     kind TEXT DEFAULT 'general', description TEXT DEFAULT '', instructions TEXT DEFAULT '',
     cover TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS accounts (
     id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, platform TEXT DEFAULT 'youtube',
     handle TEXT DEFAULT '', channel_id TEXT DEFAULT '', name TEXT DEFAULT '', avatar TEXT DEFAULT '',
     url TEXT DEFAULT '', followers INTEGER DEFAULT 0, views INTEGER DEFAULT 0, video_count INTEGER DEFAULT 0,
     schedule_times TEXT DEFAULT '', schedule_days TEXT DEFAULT 'daily', notes TEXT DEFAULT '',
     synced_at TEXT, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS posts (
     id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, video_id TEXT UNIQUE,
     title TEXT, published_at TEXT, views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0, thumb TEXT DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS snapshots (
     account_id INTEGER NOT NULL, day TEXT NOT NULL, followers INTEGER, views INTEGER,
     PRIMARY KEY (account_id, day))`,
  `CREATE TABLE IF NOT EXISTS earnings (
     id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, account_id INTEGER,
     amount REAL NOT NULL, day TEXT NOT NULL, note TEXT DEFAULT '', source TEXT DEFAULT 'manual',
     created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS stats (
     project_id INTEGER NOT NULL, label TEXT NOT NULL, value TEXT, updated_at TEXT DEFAULT (datetime('now')),
     PRIMARY KEY (project_id, label))`,
  `CREATE TABLE IF NOT EXISTS notes (
     id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, text TEXT NOT NULL,
     created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS tasks (
     id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, request TEXT NOT NULL,
     status TEXT DEFAULT 'pending', result TEXT DEFAULT '', notify TEXT DEFAULT 'none',
     created_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, role TEXT NOT NULL,
     content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS turns (
     id TEXT PRIMARY KEY, sid TEXT, status TEXT DEFAULT 'working', reply TEXT DEFAULT '',
     hangup INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS intents (
     id TEXT PRIMARY KEY, message TEXT, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
];

let ready = null;
export function ensureSchema(env) {
  if (!ready) {
    ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

export const all = async (env, sql, ...p) => (await env.DB.prepare(sql).bind(...p).all()).results || [];
export const first = (env, sql, ...p) => env.DB.prepare(sql).bind(...p).first();
export const run = (env, sql, ...p) => env.DB.prepare(sql).bind(...p).run();

export async function getSetting(env, key, fallback = '') {
  const r = await first(env, 'SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : fallback;
}
export const setSetting = (env, key, value) =>
  run(env, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));

export function timezone(env) {
  return env.TIMEZONE || 'America/New_York';
}

// Local date/time parts in the owner's timezone.
export function localNow(env, date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone(env), year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'long',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}`, weekday: parts.weekday, hour: Number(hour) };
}

export function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

// Find a project by id, slug, or (partial) name.
export async function findProject(env, ref) {
  if (ref === undefined || ref === null || ref === '') {
    const rows = await all(env, 'SELECT * FROM projects ORDER BY id');
    if (rows.length === 1) return rows[0];
    throw new Error(rows.length ? `Which project? Options: ${rows.map((r) => r.name).join(', ')}` : 'There are no projects yet.');
  }
  const s = String(ref).trim();
  let p = /^\d+$/.test(s) ? await first(env, 'SELECT * FROM projects WHERE id = ?', Number(s)) : null;
  p = p || (await first(env, 'SELECT * FROM projects WHERE slug = ? OR lower(name) = lower(?)', slugify(s), s));
  p = p || (await first(env, "SELECT * FROM projects WHERE lower(name) LIKE '%' || lower(?) || '%' ORDER BY id LIMIT 1", s));
  if (!p) throw new Error(`No project matches "${s}".`);
  return p;
}

export async function findAccount(env, ref, projectId) {
  const s = String(ref ?? '').trim();
  if (!s) throw new Error('An account is required.');
  let a = /^\d+$/.test(s) ? await first(env, 'SELECT * FROM accounts WHERE id = ?', Number(s)) : null;
  const scope = projectId ? ' AND project_id = ' + Number(projectId) : '';
  const bare = s.replace(/^@/, '');
  a = a || (await first(env, `SELECT * FROM accounts WHERE (lower(replace(handle,'@','')) = lower(?) OR lower(name) = lower(?))${scope}`, bare, s));
  a = a || (await first(env, `SELECT * FROM accounts WHERE (lower(handle) LIKE '%' || lower(?) || '%' OR lower(name) LIKE '%' || lower(?) || '%')${scope} ORDER BY id LIMIT 1`, bare, s));
  if (!a) throw new Error(`No account matches "${s}".`);
  return a;
}

// Everything the dashboard and Brian need, in one object.
export async function snapshot(env) {
  const now = localNow(env);
  const weekAgo = localNow(env, new Date(Date.now() - 6 * 864e5)).day;
  const yesterday = localNow(env, new Date(Date.now() - 864e5)).day;
  const [projects, accounts, posts, earnings, stats, notes, tasks, snaps] = await Promise.all([
    all(env, 'SELECT * FROM projects ORDER BY id'),
    all(env, 'SELECT * FROM accounts ORDER BY id'),
    all(env, 'SELECT * FROM posts ORDER BY published_at DESC LIMIT 400'),
    all(env, 'SELECT * FROM earnings ORDER BY day DESC, id DESC'),
    all(env, 'SELECT * FROM stats ORDER BY label'),
    all(env, 'SELECT * FROM notes ORDER BY id DESC LIMIT 200'),
    all(env, "SELECT * FROM tasks ORDER BY (status = 'pending') DESC, id DESC LIMIT 40"),
    all(env, 'SELECT * FROM snapshots WHERE day = ?', yesterday),
  ]);
  const prev = Object.fromEntries(snaps.map((s) => [s.account_id, s]));
  const sum = (rows) => Math.round(rows.reduce((t, r) => t + r.amount, 0) * 100) / 100;

  const out = projects.map((p) => {
    const pe = earnings.filter((e) => e.project_id === p.id);
    const pa = accounts.filter((a) => a.project_id === p.id).map((a) => {
      const ae = pe.filter((e) => e.account_id === a.id);
      return {
        ...a,
        profit: sum(ae),
        views_today: prev[a.id] ? Math.max(0, a.views - prev[a.id].views) : null,
        followers_today: prev[a.id] ? a.followers - prev[a.id].followers : null,
        posts: posts.filter((x) => x.account_id === a.id).slice(0, 6),
      };
    });
    const byDay = {};
    for (const e of pe) byDay[e.day] = Math.round(((byDay[e.day] || 0) + e.amount) * 100) / 100;
    return {
      ...p,
      accounts: pa,
      stats: stats.filter((s) => s.project_id === p.id),
      notes: notes.filter((n) => n.project_id === p.id).slice(0, 30),
      earnings: pe.slice(0, 40),
      earnings_by_day: byDay,
      totals: {
        profit: sum(pe),
        profit_today: sum(pe.filter((e) => e.day === now.day)),
        profit_7d: sum(pe.filter((e) => e.day >= weekAgo)),
        views: pa.reduce((t, a) => t + (a.views || 0), 0),
        followers: pa.reduce((t, a) => t + (a.followers || 0), 0),
        accounts: pa.length,
      },
    };
  });
  return { now, projects: out, tasks };
}
