/* 지니 스케줄 푸시 서버 핵심 로직 — 저장소(store)와 발송 함수(send)를 주입받아 테스트할 수 있게 분리 */
import webpush from 'web-push';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const MAX_QUEUE = 600, WINDOW_MS = 20 * 60 * 1000, KEEP_SENT_MS = 3 * 24 * 3600 * 1000;
let jwks = null;

/* VAPID 키: 처음 한 번 자동 생성해 저장 */
export async function getVapid(store) {
  let v = await store.get('vapid', { type: 'json' });
  if (!v || !v.publicKey) { v = webpush.generateVAPIDKeys(); await store.setJSON('vapid', v); }
  return v;
}

/* Firebase 로그인 토큰 검증 → uid. 처음 쓰인 Firebase 프로젝트로 고정(다른 프로젝트 토큰 거부) */
export async function verifyUser(store, idToken, projectId, verifier) {
  if (!idToken || !projectId || !/^[a-z0-9-]{4,40}$/.test(projectId)) throw httpErr(400, '로그인 정보가 없습니다.');
  let cfg = await store.get('config', { type: 'json' });
  if (!cfg) { cfg = { projectId }; await store.setJSON('config', cfg); }
  if (cfg.projectId !== projectId) throw httpErr(403, '등록된 Firebase 프로젝트와 다릅니다.');
  const verify = verifier || (async (tok, pid) => {
    jwks = jwks || createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));
    const { payload } = await jwtVerify(tok, jwks, { issuer: `https://securetoken.google.com/${pid}`, audience: pid });
    return payload.sub;
  });
  try { const uid = await verify(idToken, cfg.projectId); if (!uid) throw new Error(); return uid; }
  catch (e) { throw httpErr(401, '로그인이 만료되었습니다. 앱을 다시 열어 주세요.'); }
}
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

const str = (v, n) => String(v ?? '').slice(0, n);
export function cleanQueue(q, now) {
  if (!Array.isArray(q)) return [];
  return q.filter(a => a && Number.isFinite(+a.at) && +a.at > now - WINDOW_MS && a.title)
    .slice(0, MAX_QUEUE).map(a => ({ at: Math.round(+a.at), title: str(a.title, 120), body: str(a.body, 400), tag: str(a.tag, 200) }))
    .sort((a, b) => a.at - b.at);
}
function cleanSub(s) {
  if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) throw httpErr(400, '구독 정보가 올바르지 않습니다.');
  return { endpoint: s.endpoint.slice(0, 1000), keys: { p256dh: str(s.keys.p256dh, 200), auth: str(s.keys.auth, 100) } };
}
const subKey = ep => { let h = 0; for (let i = 0; i < ep.length; i++) h = (h * 31 + ep.charCodeAt(i)) | 0; return 's' + (h >>> 0).toString(36) + ep.length; };

const DEFAULT_SUBJECT = 'https://jini-schedule.netlify.app';
async function sendTo(store, rec, payload, send, opts) {
  const v = await getVapid(store); let ok = 0, fail = 0; const dead = [];
  const subject = /^(https:|mailto:)/.test(opts.subject || '') ? opts.subject : DEFAULT_SUBJECT;
  for (const [k, sub] of Object.entries(rec.subs || {})) {
    try { await send(sub, JSON.stringify(payload), { vapidDetails: { subject, publicKey: v.publicKey, privateKey: v.privateKey }, TTL: opts.ttl || 3600, urgency: 'high', topic: undefined }); ok++; }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(k); else { fail++; console.error('push fail', k, e && (e.statusCode || e.message)); } }
  }
  return { ok, fail, dead };
}

/* 앱 → 서버: subscribe | unsubscribe | queue | test */
export async function handleSync(store, body, { verifier, send = webpush.sendNotification, now = Date.now(), subject } = {}) {
  const uid = await verifyUser(store, body.idToken, body.projectId, verifier);
  const key = 'user/' + uid;
  const rec = (await store.get(key, { type: 'json' })) || { subs: {}, queue: [], sent: {} };
  rec.subs = rec.subs || {}; rec.sent = rec.sent || {};
  const action = body.action || 'queue';
  if (action === 'subscribe') { const s = cleanSub(body.subscription); rec.subs[subKey(s.endpoint)] = { ...s, device: str(body.device, 60), at: now }; }
  if (action === 'unsubscribe' && body.endpoint) delete rec.subs[subKey(String(body.endpoint))];
  if (Array.isArray(body.queue)) rec.queue = cleanQueue(body.queue, now);
  let result = { ok: true, subs: Object.keys(rec.subs).length, queue: rec.queue.length };
  if (action === 'test') {
    const r = await sendTo(store, rec, { title: '🔔 지니 스케줄 테스트 알림', body: '알림이 잘 도착했어요! 일정 알림도 이렇게 옵니다.', tag: 'test|' + now }, send, { subject, ttl: 300 });
    r.dead.forEach(k => delete rec.subs[k]); result.sent = r.ok;
  }
  rec.updatedAt = now;
  await store.setJSON(key, rec);
  return result;
}

/* 5분마다: 시각이 된 알림 발송(최대 20분 늦은 것까지 따라잡기, 중복 발송 방지) */
export async function runCron(store, { send = webpush.sendNotification, now = Date.now(), subject } = {}) {
  const { blobs } = await store.list({ prefix: 'user/' });
  let sent = 0;
  for (const { key } of blobs) {
    const rec = await store.get(key, { type: 'json' }); if (!rec) continue;
    rec.sent = rec.sent || {};
    const due = (rec.queue || []).filter(a => a.at <= now && a.at > now - WINDOW_MS && !rec.sent[a.tag + '@' + a.at]);
    const dead = new Set();
    for (const a of due) {
      if (!Object.keys(rec.subs || {}).length) break;
      const r = await sendTo(store, rec, { title: a.title, body: a.body, tag: a.tag }, send, { subject, ttl: 1800 });
      r.dead.forEach(k => { dead.add(k); delete rec.subs[k]; });
      if (r.ok || !r.fail) rec.sent[a.tag + '@' + a.at] = now; // 일시 오류로 한 대도 못 받았으면 다음 실행 때 다시 시도
      sent += r.ok;
    }
    const before = JSON.stringify([rec.queue.length, Object.keys(rec.sent).length]);
    rec.queue = (rec.queue || []).filter(a => a.at > now - WINDOW_MS);
    for (const [k, t] of Object.entries(rec.sent)) if (t < now - KEEP_SENT_MS) delete rec.sent[k];
    if (due.length || dead.size || before !== JSON.stringify([rec.queue.length, Object.keys(rec.sent).length])) {
      // 그 사이 앱이 새 목록을 올렸을 수 있으므로 최신본에 발송 기록만 합친다
      const latest = (await store.get(key, { type: 'json' })) || rec;
      latest.sent = { ...(latest.sent || {}), ...rec.sent };
      for (const [k, t] of Object.entries(latest.sent)) if (t < now - KEEP_SENT_MS) delete latest.sent[k];
      latest.queue = (latest.queue || []).filter(a => a.at > now - WINDOW_MS);
      dead.forEach(k => { if (latest.subs) delete latest.subs[k]; });
      await store.setJSON(key, latest);
    }
  }
  return { users: blobs.length, sent };
}
