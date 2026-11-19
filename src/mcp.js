// Minimal MCP server (Streamable HTTP, stateless) so a Claude project can read and update Brian's records.
import { toolsFor, runTool } from './tools.js';

const INSTRUCTIONS = `This connector is Brian, the owner's phone assistant and project dashboard. Brian holds the owner's projects: accounts, posting schedules, followers, views, profit, stats and notes.

- Call list_pending_tasks at the start of a session and whenever asked to "check in with Brian". Each task is a request from the owner, relayed by Brian (for example: open Content Rewards in the browser and read the current earnings). Do the task, save any figures with set_profit_total / log_earning / set_stat / save_account, then call complete_task with a short plain-English answer Brian can read aloud.
- Whenever project facts change during your work (a new account, a schedule change, money earned), update Brian so the dashboard stays current.
- Use get_overview to see what Brian currently holds.`;

const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(env, msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // notification
  switch (method) {
    case 'initialize':
      return rpc(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'brian', title: 'Brian', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return rpc(id, {});
    case 'tools/list':
      return rpc(id, { tools: toolsFor('claude').map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
    case 'tools/call':
      try {
        const result = await runTool(env, 'claude', params?.name, params?.arguments, { source: 'claude', channel: 'connector' });
        return rpc(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] });
      } catch (e) {
        return rpc(id, { content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      }
    case 'resources/list':
      return rpc(id, { resources: [] });
    case 'prompts/list':
      return rpc(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function mcp(env, request) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 });
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(env, m)))).filter(Boolean);
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const out = await handle(env, body);
  return out ? Response.json(out) : new Response(null, { status: 202 });
}
