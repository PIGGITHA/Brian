// Twilio: outbound calls and texts, webhook signature checks, and TwiML helpers.
import { run, getSetting } from './db.js';

export const twilioReady = (env) =>
  Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_NUMBER && env.MY_PHONE);

const digits = (n) => String(n || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
export const isOwner = (env, number) => Boolean(number) && digits(number) === digits(env.MY_PHONE);

// Tolerate numbers saved as "(806) 662-2331" or without the +1.
const e164 = (n) => {
  const d = String(n || '').replace(/\D/g, '');
  return d.length === 10 ? '+1' + d : '+' + d;
};

export const xml = (s) =>
  String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export const twiml = (inner) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });

export const say = (env, text) => `<Say voice="${xml(env.BRIAN_VOICE || 'Polly.Brian-Neural')}">${xml(text)}</Say>`;

// Speak, then listen for the owner's reply.
export function listen(env, text) {
  return (
    `<Gather input="speech" action="/twilio/gather" method="POST" speechTimeout="auto" language="${xml(env.SPEECH_LANGUAGE || 'en-US')}">` +
    (text ? say(env, text) : '') +
    `</Gather><Redirect method="POST">/twilio/silence</Redirect>`
  );
}

// Validate X-Twilio-Signature (HMAC-SHA1 over the URL plus sorted POST params).
export async function verifyTwilio(env, request, params) {
  const given = request.headers.get('X-Twilio-Signature');
  if (!given || !env.TWILIO_AUTH_TOKEN) return false;
  let data = request.url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TWILIO_AUTH_TOKEN), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  const expected = btoa(String.fromCharCode(...sig));
  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function twilioApi(env, resource, form) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${String(env.TWILIO_ACCOUNT_SID).trim()}/${resource}.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${String(env.TWILIO_ACCOUNT_SID).trim()}:${String(env.TWILIO_AUTH_TOKEN).trim()}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const sid = String(env.TWILIO_ACCOUNT_SID).trim();
    const hint = !/^AC[0-9a-f]{32}$/i.test(sid) ? ' TWILIO_ACCOUNT_SID should be the 34-character Account SID starting with "AC".' : '';
    throw new Error(`Twilio said: ${body.message || 'no message'} (HTTP ${res.status}${body.code ? ', error ' + body.code : ''}).${hint}`);
  }
  return body;
}

export async function baseUrl(env) {
  const url = env.PUBLIC_URL || (await getSetting(env, 'base_url'));
  if (!url) throw new Error('Brian does not know his public address yet. Open the dashboard once, or set PUBLIC_URL.');
  return url.replace(/\/$/, '');
}

// Ring the owner. `message` is what Brian opens the call with.
export async function callOwner(env, message = '') {
  if (!twilioReady(env)) throw new Error('Twilio is not configured yet.');
  const id = crypto.randomUUID();
  await run(env, 'INSERT INTO intents (id, message) VALUES (?, ?)', id, message);
  const call = await twilioApi(env, 'Calls', {
    To: e164(env.MY_PHONE),
    From: e164(env.TWILIO_NUMBER),
    Url: `${await baseUrl(env)}/twilio/voice?intent=${id}`,
    Method: 'POST',
  });
  return { calling: true, sid: call.sid };
}

export async function textOwner(env, message) {
  if (!twilioReady(env)) throw new Error('Twilio is not configured yet.');
  const sms = await twilioApi(env, 'Messages', { To: e164(env.MY_PHONE), From: e164(env.TWILIO_NUMBER), Body: String(message).slice(0, 1500) });
  return { sent: true, sid: sms.sid };
}
