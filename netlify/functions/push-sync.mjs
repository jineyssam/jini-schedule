import { getStore } from '@netlify/blobs';
import { handleSync } from '../lib/push-core.mjs';
export default async (req) => {
  if (req.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 });
  let body; try { body = await req.json(); } catch (e) { return Response.json({ error: '잘못된 요청입니다.' }, { status: 400 }); }
  try {
    const r = await handleSync(getStore({ name: 'jini-push', consistency: 'strong' }), body, { subject: process.env.URL || 'https://jini-schedule.netlify.app' });
    return Response.json(r, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return Response.json({ error: e.message || '서버 오류' }, { status: e.status || 500 }); }
};
export const config = { path: '/api/push-sync' };
