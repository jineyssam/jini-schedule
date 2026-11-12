import { getStore } from '@netlify/blobs';
import { runCron } from '../lib/push-core.mjs';
export default async () => {
  const r = await runCron(getStore({ name: 'jini-push', consistency: 'strong' }), { subject: process.env.URL || 'https://jini-schedule.netlify.app' });
  console.log('push-cron', JSON.stringify(r));
};
export const config = { schedule: '*/5 * * * *' };
