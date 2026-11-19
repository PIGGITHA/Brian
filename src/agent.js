// Brian's brain: Claude with tools over the project data.
import Anthropic from '@anthropic-ai/sdk';
import { all, run } from './db.js';
import { toolsFor, runTool, overview } from './tools.js';

const PERSONA = `You are Brian, a personal assistant. You are English, calm, composed and quietly capable, in the manner of a seasoned butler who is also very good with numbers. You address the person you work for as "sir". You are warm but never gushing, dry rather than jokey, and you never mention being an AI model unless asked.

You look after sir's projects. Each project has accounts, posting schedules, followers, views, profit, custom stats and notes, all held in your records and shown on his dashboard. The current records are included below, so answer straight from them when you can and only call a tool when you need more detail or need to change something. When sir tells you something worth keeping (a new account, money earned, a schedule change, an idea), save it with the right tool and confirm briefly.

Be accurate with figures: report what the records say, state how fresh they are if that matters, and say plainly when you do not have something rather than guessing.

Sir also works with Claude on his desktop computer, which can open his browser and logged-in sites such as Content Rewards. You cannot see those sites yourself. When sir wants something only the desktop can see (live payout figures, for example), give him the latest figure you hold, then queue the job with ask_claude and offer to ring or text him when the answer comes back. Never pretend that check is instant.`;

const CHANNEL = {
  call: `You are on a live phone call with sir. Everything you write is spoken aloud by a text-to-speech voice, so write only words to be spoken: no markdown, lists, symbols, emoji or stage directions. Keep replies short, usually one to three sentences, and let him steer. Say numbers the way a person would ("about twelve thousand four hundred views", "forty-two dollars fifty"). Speech recognition may garble names; infer the sensible meaning from his projects, and ask if truly unclear. When he says goodbye or is plainly done, give a brief sign-off and call end_call.`,
  sms: `You are replying by text message. Keep it to a few short sentences of plain text, no markdown.`,
  chat: `You are chatting in the dashboard. Be concise. Plain text with short paragraphs; no headings.`,
  briefing: `Write the opening words of a phone call you are placing to sir: a greeting suited to the time of day, then a brief spoken summary of how his projects stand (profit, notable view or follower changes, what is due to be posted next, anything waiting on Claude). Spoken words only, under about seventy words, no markdown. End by asking if there is anything he would like done.`,
};

function client(env) {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}), maxRetries: 1 });
}

const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();

// Run one turn. `history` is prior [{role, content}] text messages; returns { reply, hangup }.
export async function think(env, { channel, history = [], message }) {
  if (!env.ANTHROPIC_API_KEY) {
    return { reply: 'I am afraid my Claude API key has not been set yet, sir, so I cannot think just now.', hangup: false };
  }
  const model = env.BRIAN_MODEL || 'claude-opus-5-5';
  const records = await overview(env);
  const instructions = (await all(env, "SELECT name, instructions FROM projects WHERE instructions != ''"))
    .map((p) => `Standing instructions for ${p.name}:\n${p.instructions}`)
    .join('\n\n');
  const system = [
    PERSONA,
    CHANNEL[channel] || CHANNEL.chat,
    instructions,
    `It is ${records.now.weekday} ${records.now.day}, ${records.now.time} (sir's local time).\n\nCurrent records:\n${JSON.stringify(records)}`,
  ].filter(Boolean).join('\n\n');

  const tools = toolsFor('brian')
    .filter((t) => channel === 'call' || t.name !== 'end_call')
    .map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  const messages = [...history, { role: 'user', content: message }];
  const ctx = { channel, hangup: false, source: 'brian' };
  const withFallback = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);

  try {
    for (let step = 0; step < 6; step++) {
      const res = await client(env).beta.messages.create({
        model,
        max_tokens: 8000,
        system,
        tools,
        messages,
        output_config: { effort: channel === 'call' || channel === 'sms' ? 'low' : 'medium' },
        ...(withFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      });
      if (res.stop_reason === 'refusal') return { reply: 'I am afraid that is not something I can help with, sir.', hangup: false };
      if (res.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: res.content });
        continue;
      }
      if (res.stop_reason !== 'tool_use') {
        return { reply: textOf(res.content) || 'Very good, sir.', hangup: ctx.hangup };
      }
      messages.push({ role: 'assistant', content: res.content });
      const results = await Promise.all(
        res.content.filter((b) => b.type === 'tool_use').map(async (b) => {
          try {
            return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(await runTool(env, 'brian', b.name, b.input, ctx)) };
          } catch (e) {
            return { type: 'tool_result', tool_use_id: b.id, content: String(e.message || e), is_error: true };
          }
        }),
      );
      messages.push({ role: 'user', content: results });
    }
    return { reply: 'That took more steps than I expected, sir. Might I ask you to put it to me again?', hangup: false };
  } catch (e) {
    console.error('Brian error:', e);
    if (e instanceof Anthropic.AuthenticationError) return { reply: 'My Claude API key appears to be invalid, sir.', hangup: false };
    if (e instanceof Anthropic.RateLimitError) return { reply: 'Claude is rate limiting me at the moment, sir. Do try again shortly.', hangup: false };
    return { reply: 'I do apologise, sir, something went wrong on my end. Please try me again.', hangup: false };
  }
}

// Conversation memory per channel (a call uses its own id as the channel).
export async function converse(env, channel, key, message) {
  const rows = await all(env, 'SELECT role, content FROM messages WHERE channel = ? ORDER BY id DESC LIMIT 24', key);
  const history = rows.reverse();
  while (history.length && history[0].role !== 'user') history.shift();
  const out = await think(env, { channel, history, message });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO messages (channel, role, content) VALUES (?, ?, ?)').bind(key, 'user', message),
    env.DB.prepare('INSERT INTO messages (channel, role, content) VALUES (?, ?, ?)').bind(key, 'assistant', out.reply),
  ]);
  return out;
}

export async function briefing(env) {
  const out = await think(env, { channel: 'briefing', message: 'Place the daily briefing call now.' });
  return out.reply;
}

export const forgetOldCalls = (env) =>
  run(env, "DELETE FROM messages WHERE channel LIKE 'call:%' AND created_at < datetime('now', '-2 days')");
