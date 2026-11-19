# Brian

A personal assistant with a phone line and a glass dashboard.

- **Phone**: Brian rings your mobile (or you ring him) and you talk. He also answers texts. Calm English voice, calls you "sir".
- **Dashboard**: one tab per project. A clipping project shows each account with followers, views, posting schedule, recent posts and profit. Create a project and a new tab appears.
- **Claude connector**: your existing Claude project can read and update Brian's records, and Brian can queue jobs for Claude on your desktop (e.g. "open Content Rewards and read my earnings").

Runs on Cloudflare's free tier (Worker + D1 database). The only running costs are Claude API tokens and Twilio.

## Setup

### 1. Deploy (free)

Create a free Cloudflare account, then either connect this GitHub repo under **Workers & Pages > Create > Import a repository**, or from a computer:

```
npm install
npx wrangler login
npx wrangler deploy
```

The database is created automatically. If your Wrangler version asks for a database id instead, run `npx wrangler d1 create brian` and paste the id into `wrangler.jsonc`.

You get an address like `https://brian.<you>.workers.dev`.

### 2. Secrets

Set these in the Cloudflare dashboard (Worker > Settings > Variables and Secrets) or with `npx wrangler secret put NAME`:

| Secret | What it is |
|---|---|
| `DASHBOARD_PASSWORD` | Password for the dashboard |
| `ANTHROPIC_API_KEY` | Your Claude API key |
| `CONNECTOR_TOKEN` | Any long random string; it forms the private connector URL |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | From the Twilio console |
| `TWILIO_NUMBER` | Brian's phone number, e.g. `+15551234567` |
| `MY_PHONE` | Your mobile. Brian only ever talks to this number |
| `YOUTUBE_API_KEY` | Optional, free. Google Cloud console > enable "YouTube Data API v3" > create an API key |

Plain settings live in `wrangler.jsonc`: `TIMEZONE`, `BRIAN_MODEL`, `BRIAN_VOICE`, `SPEECH_LANGUAGE`.

### 3. Twilio

1. Buy a voice + SMS number (trial credit covers it at first; trial accounts can only call numbers you have verified, and play a short trial notice).
2. On the number, set **A call comes in** to `POST https://<your-address>/twilio/voice` and **A message comes in** to `POST https://<your-address>/twilio/sms`.
3. Open the dashboard once so Brian learns his own address, then press **Call me**.

US carriers require A2P 10DLC registration before a number can send texts; calls work without it.

### 4. Connect your Claude project

1. Open the dashboard. Under **Brian's connections**, copy the connector URL.
2. In Claude: Settings > Connectors > Add custom connector, paste the URL.
3. Add a line to your Claude project instructions: *"At the start of each session, call Brian's `list_pending_tasks` and complete any tasks. Keep Brian updated when accounts, schedules or earnings change."*

Brian cannot wake Claude up. Jobs he queues wait until Claude next checks in: when you open the project, or on a schedule if you set up a recurring task in Claude that says "check in with Brian" on a computer with Chrome signed in to Content Rewards. Brian tells you the last figure he holds, and can call or text when the fresh answer arrives.

## Local development

Create `.dev.vars` with the secrets above, then `npm run dev`.

## Layout

- `src/index.js` routes: dashboard API, Twilio webhooks, connector, scheduled jobs
- `src/agent.js` Brian's persona and Claude tool loop
- `src/tools.js` every action Brian, the dashboard and Claude can take
- `src/twilio.js`, `src/youtube.js`, `src/mcp.js`, `src/db.js`
- `public/` the dashboard

Background photographs are from Unsplash (Unsplash License).
