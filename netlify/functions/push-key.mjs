import { getStore } from '@netlify/blobs';
import { getVapid } from '../lib/push-core.mjs';
export default async () => {
  const v = await getVapid(getStore({ name: 'jini-push', consistency: 'strong' }));
  return Response.json({ publicKey: v.publicKey }, { headers: { 'Cache-Control': 'no-store' } });
};
export const config = { path: '/api/push-key' };
