// YouTube Data API v3 sync (free quota: 10,000 units/day; a full sync of one channel costs 3).
import { all, run, localNow } from './db.js';

const API = 'https://www.googleapis.com/youtube/v3';

async function yt(env, path, params) {
  const qs = new URLSearchParams({ ...params, key: env.YOUTUBE_API_KEY });
  const res = await fetch(`${API}/${path}?${qs}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || `YouTube API error ${res.status}`);
  return body;
}

// Accepts "@handle", a channel URL, or a UC... channel id.
export function parseChannelRef(input) {
  const s = String(input || '').trim();
  const id = s.match(/(UC[\w-]{22})/);
  if (id) return { id: id[1] };
  const handle = s.match(/@([\w.-]+)/);
  if (handle) return { handle: '@' + handle[1] };
  if (/^[\w.-]+$/.test(s)) return { handle: '@' + s };
  return {};
}

export async function syncAccount(env, account) {
  if (!env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not set.');
  const ref = account.channel_id ? { id: account.channel_id } : parseChannelRef(account.handle || account.url);
  if (!ref.id && !ref.handle) throw new Error(`Cannot work out the channel for "${account.handle || account.name}".`);
  const data = await yt(env, 'channels', {
    part: 'snippet,statistics,contentDetails',
    ...(ref.id ? { id: ref.id } : { forHandle: ref.handle }),
  });
  const ch = data.items?.[0];
  if (!ch) throw new Error(`YouTube channel not found for "${ref.id || ref.handle}".`);
  const st = ch.statistics || {};
  const handle = ch.snippet.customUrl || account.handle;
  await run(
    env,
    `UPDATE accounts SET channel_id = ?, name = ?, handle = ?, avatar = ?, url = ?, followers = ?, views = ?,
       video_count = ?, synced_at = datetime('now') WHERE id = ?`,
    ch.id, ch.snippet.title, handle, ch.snippet.thumbnails?.medium?.url || ch.snippet.thumbnails?.default?.url || '',
    `https://www.youtube.com/${handle || 'channel/' + ch.id}`,
    Number(st.subscriberCount || 0), Number(st.viewCount || 0), Number(st.videoCount || 0), account.id,
  );
  await run(
    env,
    `INSERT INTO snapshots (account_id, day, followers, views) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, day) DO UPDATE SET followers = excluded.followers, views = excluded.views`,
    account.id, localNow(env).day, Number(st.subscriberCount || 0), Number(st.viewCount || 0),
  );

  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  if (uploads) {
    const list = await yt(env, 'playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: 12 }).catch(() => null);
    const ids = (list?.items || []).map((i) => i.contentDetails.videoId);
    if (ids.length) {
      const vids = await yt(env, 'videos', { part: 'snippet,statistics', id: ids.join(',') });
      for (const v of vids.items || []) {
        await run(
          env,
          `INSERT INTO posts (account_id, video_id, title, published_at, views, likes, thumb) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(video_id) DO UPDATE SET title = excluded.title, views = excluded.views, likes = excluded.likes`,
          account.id, v.id, v.snippet.title, v.snippet.publishedAt, Number(v.statistics?.viewCount || 0),
          Number(v.statistics?.likeCount || 0), v.snippet.thumbnails?.medium?.url || '',
        );
      }
    }
  }
  return { name: ch.snippet.title, followers: Number(st.subscriberCount || 0), views: Number(st.viewCount || 0) };
}

export async function syncAll(env, projectId) {
  if (!env.YOUTUBE_API_KEY) return { synced: 0, errors: ['YOUTUBE_API_KEY is not set.'] };
  const accounts = await all(
    env,
    `SELECT * FROM accounts WHERE platform = 'youtube'${projectId ? ' AND project_id = ' + Number(projectId) : ''}`,
  );
  const errors = [];
  let synced = 0;
  for (const a of accounts) {
    try {
      await syncAccount(env, a);
      synced++;
    } catch (e) {
      errors.push(`${a.handle || a.name}: ${e.message}`);
    }
  }
  return { synced, errors };
}
