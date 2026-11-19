// Brian: router for the dashboard API, the Twilio phone line, and the Claude connector.
import { ensureSchema, snapshot, first, run, getSetting, setSetting, localNow, timezone } from './db.js';
import { runTool } from './tools.js';
import { converse, briefing, forgetOldCalls } from './agent.js';
import { mcp } from './mcp.js';
import { syncAll } from './youtube.js';
import { twilioReady, isOwner, verifyTwilio, twiml, say, listen, callOwner, textOwner } from './twilio.js';

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const sessionToken = (env) => hmacHex(env.DASHBOARD_PASSWORD, 'brian-session-v1');
async function signedIn(env, request) {
  if (!env.DASHBOARD_PASSWORD) return false;
  const cookie = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)brian=([a-f0-9]+)/);
  return Boolean(cookie) && safeEqual(cookie[1], await sessionToken(env));
}

// ---------- Dashboard API ----------
async function api(env, request, url, ctx) {
  const path = url.pathname;
  if (path === '/api/login' && request.method === 'POST') {
    if (!env.DASHBOARD_PASSWORD) return json({ error: 'Set the DASHBOARD_PASSWORD secret first.' }, 503);
    const { password } = await request.json().catch(() => ({}));
    if (!safeEqual(await hmacHex(env.DASHBOARD_PASSWORD, String(password ?? '')), await hmacHex(env.DASHBOARD_PASSWORD, env.DASHBOARD_PASSWORD))) {
      return json({ error: 'That is not the password, sir.' }, 401);
    }
    const secure = url.protocol === 'https:' ? ' Secure;' : '';
    return json({ ok: true }, 200, { 'Set-Cookie': `brian=${await sessionToken(env)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=31536000` });
  }
  if (path === '/api/logout') return json({ ok: true }, 200, { 'Set-Cookie': 'brian=; Path=/; HttpOnly; Max-Age=0' });
  if (!(await signedIn(env, request))) return json({ error: 'unauthorized', setup: !env.DASHBOARD_PASSWORD }, 401);

  // Remember the public address so scheduled calls know where Twilio should reach us.
  if (!env.PUBLIC_URL && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    if ((await getSetting(env, 'base_url')) !== url.origin) await setSetting(env, 'base_url', url.origin);
  }

  if (path === '/api/state') {
    const state = await snapshot(env);
    return json({
      ...state,
      settings: { briefing_time: await getSetting(env, 'briefing_time'), timezone: timezone(env) },
      config: {
        claude: Boolean(env.ANTHROPIC_API_KEY),
        twilio: twilioReady(env),
        youtube: Boolean(env.YOUTUBE_API_KEY),
        phone_number: env.TWILIO_NUMBER || '',
        model: env.BRIAN_MODEL || 'claude-opus-5-5',
        connector_url: env.CONNECTOR_TOKEN ? `${url.origin}/mcp/${env.CONNECTOR_TOKEN}` : '',
      },
    });
  }
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const body = await request.json().catch(() => ({}));
  try {
    if (path === '/api/tool') return json({ result: await runTool(env, 'brian', body.name, body.input, { source: 'manual', channel: 'dashboard' }) });
    if (path === '/api/chat') {
      const message = String(body.message || '').trim();
      if (!message) return json({ error: 'Say something first, sir.' }, 400);
      return json(await converse(env, 'chat', 'chat', message));
    }
    if (path === '/api/call') return json(await callOwner(env, body.message || ''));
    if (path === '/api/settings') {
      if (body.briefing_time !== undefined) {
        const t = String(body.briefing_time);
        if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return json({ error: 'Use HH:MM, e.g. 09:00.' }, 400);
        await setSetting(env, 'briefing_time', t);
      }
      return json({ ok: true });
    }
  } catch (e) {
    return json({ error: String(e.message || e) }, 400);
  }
  return json({ error: 'not found' }, 404);
}

// ---------- Twilio phone line ----------
const newId = () => crypto.randomUUID();

function speak(env, out) {
  return out.hangup ? twiml(say(env, out.reply) + '<Hangup/>') : twiml(listen(env, out.reply));
}

async function twilio(env, request, url, ctx) {
  if (!twilioReady(env)) return new Response('Twilio is not configured', { status: 503 });
  const params = Object.fromEntries(new URLSearchParams(await request.text()));
  if (!(await verifyTwilio(env, request, params))) return new Response('Bad signature', { status: 403 });
  const path = url.pathname;
  const sid = params.CallSid;

  if (path === '/twilio/sms') {
    if (!isOwner(env, params.From)) return twiml('');
    const work = converse(env, 'sms', 'sms', String(params.Body || '').trim() || 'Hello');
    const quick = await Promise.race([work, new Promise((r) => setTimeout(() => r(null), 11000))]);
    if (quick) return twiml(`<Message>${quick.reply.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</Message>`);
    ctx.waitUntil(work.then((o) => textOwner(env, o.reply)).catch((e) => console.error(e)));
    return twiml('');
  }

  // Only ever talk to the owner: the far end of the call must be their mobile.
  const other = params.Direction === 'inbound' ? params.From : params.To;
  if (!isOwner(env, other)) return twiml('<Reject/>');

  if (path === '/twilio/voice') {
    const hour = localNow(env).hour;
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    let opening = `${greeting}, sir. Brian here. How may I help?`;
    const intentId = url.searchParams.get('intent');
    if (intentId) {
      const intent = await first(env, 'SELECT message FROM intents WHERE id = ?', intentId);
      if (intent?.message) opening = /^good (morning|afternoon|evening)/i.test(intent.message) ? intent.message : `${greeting}, sir. Brian here. ${intent.message}`;
      else opening = `${greeting}, sir. Brian here. You asked me to ring. What can I do for you?`;
      await run(env, 'DELETE FROM intents WHERE id = ?', intentId);
    }
    await run(env, 'INSERT INTO messages (channel, role, content) VALUES (?, ?, ?), (?, ?, ?)', `call:${sid}`, 'user', '(The call has connected.)', `call:${sid}`, 'assistant', opening);
    return twiml(listen(env, opening));
  }

  if (path === '/twilio/silence') {
    const n = Number(url.searchParams.get('n') || 0);
    if (n >= 1) return twiml(say(env, 'I shall leave you to it, sir. Goodbye.') + '<Hangup/>');
    return twiml(
      `<Gather input="speech" action="/twilio/gather" method="POST" speechTimeout="auto" language="${env.SPEECH_LANGUAGE || 'en-US'}">${say(env, 'Are you still there, sir?')}</Gather><Redirect method="POST">/twilio/silence?n=1</Redirect>`,
    );
  }

  if (path === '/twilio/gather') {
    const heard = String(params.SpeechResult || '').trim();
    if (!heard) return twiml(listen(env, 'I am sorry, sir, I did not catch that.'));
    const work = converse(env, 'call', `call:${sid}`, heard);
    const quick = await Promise.race([work, new Promise((r) => setTimeout(() => r(null), 8000))]);
    if (quick) return speak(env, quick);
    // Still thinking: park the answer and keep the line alive.
    const turn = newId();
    await run(env, 'INSERT INTO turns (id, sid) VALUES (?, ?)', turn, sid);
    ctx.waitUntil(
      work
        .catch(() => ({ reply: 'I do apologise, sir, I lost my train of thought. Could you repeat that?', hangup: false }))
        .then((o) => run(env, "UPDATE turns SET status = 'done', reply = ?, hangup = ? WHERE id = ?", o.reply, o.hangup ? 1 : 0, turn)),
    );
    return twiml(say(env, 'One moment, sir.') + `<Redirect method="POST">/twilio/wait?turn=${turn}&amp;n=0</Redirect>`);
  }

  if (path === '/twilio/wait') {
    const turn = url.searchParams.get('turn');
    const n = Number(url.searchParams.get('n') || 0);
    for (let i = 0; i < 16; i++) {
      const t = await first(env, 'SELECT * FROM turns WHERE id = ?', turn);
      if (t?.status === 'done') {
        await run(env, 'DELETE FROM turns WHERE id = ?', turn);
        return speak(env, { reply: t.reply, hangup: Boolean(t.hangup) });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (n >= 3) return twiml(listen(env, 'I am sorry, sir, that is taking longer than it should. Shall we try again?'));
    return twiml((n === 1 ? say(env, 'Still with you, sir.') : '') + `<Redirect method="POST">/twilio/wait?turn=${turn}&amp;n=${n + 1}</Redirect>`);
  }
  return new Response('Not found', { status: 404 });
}

// ---------- Scheduled work ----------
async function scheduled(env) {
  await ensureSchema(env);
  const now = localNow(env);
  const minute = Number(now.time.slice(3));
  if (minute < 15) {
    await syncAll(env).catch((e) => console.error('YouTube sync failed', e));
    await forgetOldCalls(env);
    await run(env, "DELETE FROM turns WHERE created_at < datetime('now', '-1 day')");
    await run(env, "DELETE FROM intents WHERE created_at < datetime('now', '-1 day')");
  }
  // Daily briefing call, once per day, in the 15-minute slot containing the chosen time.
  const at = await getSetting(env, 'briefing_time');
  if (at && twilioReady(env) && (await getSetting(env, 'briefing_done')) !== now.day) {
    const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const late = mins(now.time) - mins(at);
    if (late >= 0 && late < 15) {
      await setSetting(env, 'briefing_done', now.day);
      await callOwner(env, await briefing(env));
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      await ensureSchema(env);
      if (url.pathname.startsWith('/api/')) return await api(env, request, url, ctx);
      if (url.pathname.startsWith('/twilio/')) return request.method === 'POST' ? await twilio(env, request, url, ctx) : new Response('Not found', { status: 404 });
      if (url.pathname.startsWith('/mcp/')) {
        const token = url.pathname.slice(5).replace(/\/$/, '');
        if (!env.CONNECTOR_TOKEN || !safeEqual(token, env.CONNECTOR_TOKEN)) return new Response('Not found', { status: 404 });
        return await mcp(env, request);
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      return json({ error: 'Something went wrong.' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(env));
  },
};
