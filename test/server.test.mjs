/* 실제 web-push 암호화로 가짜 푸시 서버에 보내고, 구독자 비밀키로 복호화해 내용 확인 */
import https from 'node:https'; import crypto from 'node:crypto'; import { execSync } from 'node:child_process'; import fs from 'node:fs';
import ece from 'http_ece';
import { handleSync, runCron, getVapid } from '../netlify/lib/push-core.mjs';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
let pass = 0, fail = 0; const T = (n, c, info) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + JSON.stringify(info))); };
// 메모리 저장소(Netlify Blobs와 같은 인터페이스)
const mem = new Map();
const store = { async get(k) { return mem.has(k) ? JSON.parse(mem.get(k)) : null; }, async setJSON(k, v) { mem.set(k, JSON.stringify(v)); }, async list({ prefix }) { return { blobs: [...mem.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) }; } };
// 가짜 푸시 서비스(https)
execSync('openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/k.pem -out /tmp/c.pem -days 1 -subj /CN=localhost 2>/dev/null');
const got = []; let respond = 201;
const srv = https.createServer({ key: fs.readFileSync('/tmp/k.pem'), cert: fs.readFileSync('/tmp/c.pem') }, (req, res) => { const ch = []; req.on('data', c => ch.push(c)); req.on('end', () => { got.push({ url: req.url, headers: req.headers, body: Buffer.concat(ch) }); res.writeHead(req.url.includes('gone') ? 410 : respond); res.end(); }); });
await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
// 구독자(브라우저) 키
const mkSub = name => { const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); const auth = crypto.randomBytes(16);
  return { ecdh, auth, sub: { endpoint: `https://localhost:${port}/push/${name}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } }; };
const decrypt = (d, m) => JSON.parse(ece.decrypt(m.body, { version: 'aes128gcm', privateKey: d.ecdh, authSecret: d.auth.toString('base64url') }).toString());
const iphone = mkSub('iphone'), laptop = mkSub('laptop'), gone = mkSub('gone');
const verifier = async (tok, pid) => { if (tok === 'tok-jini' && pid === 'jini-schedule-3f3c1') return 'uidJINI'; if (tok === 'tok-other' && pid === 'jini-schedule-3f3c1') return 'uidOTHER'; throw new Error('bad'); };
const base = { idToken: 'tok-jini', projectId: 'jini-schedule-3f3c1' };
const NOW = Date.UTC(2026, 10, 9, 1, 0); // 2026-11-09 10:00 KST
const q = [
  { at: NOW - 30 * 60000, title: '지난 알림(30분 전)', body: 'x', tag: 'old' },
  { at: NOW - 2 * 60000, title: '⏰ 30분 후 · 교과협의회', body: '11/9(월) 10:28', tag: 'e1|2026-11-09|30' },
  { at: NOW + 3 * 60000, title: '⏰ 30분 후 · 학운위', body: '11/9(월) 10:33', tag: 'e2|2026-11-09|30' },
  { at: NOW + 21 * 3600e3, title: '☀️ 오늘 11/10(화) 일정 2건', body: '· 종일 동아리\n· 15:00 회의', tag: 'am|2026-11-10' }];
// 1) 키 자동 생성 + 동일 키 재사용
const v1 = await getVapid(store), v2 = await getVapid(store);
T('VAPID 키 자동 생성·재사용', v1.publicKey && v1.publicKey === v2.publicKey && v1.publicKey.length === 87);
// 2) 인증
let err = null; try { await handleSync(store, { idToken: 'bad', projectId: 'jini-schedule-3f3c1' }, { verifier, now: NOW }); } catch (e) { err = e; }
T('잘못된 토큰 거부(401)', err && err.status === 401, err && err.message);
await handleSync(store, { ...base, action: 'subscribe', subscription: iphone.sub, device: '아이폰', queue: q }, { verifier, now: NOW, subject: 'https://jini-schedule.netlify.app' });
err = null; try { await handleSync(store, { idToken: 'tok-jini', projectId: 'someone-else' }, { verifier, now: NOW }); } catch (e) { err = e; }
T('다른 Firebase 프로젝트 거부(403)', err && err.status === 403, err && err.message);
await handleSync(store, { ...base, action: 'subscribe', subscription: laptop.sub, device: 'PC' }, { verifier, now: NOW });
await handleSync(store, { ...base, action: 'subscribe', subscription: gone.sub, device: '옛 기기' }, { verifier, now: NOW });
let rec = await store.get('user/uidJINI');
T('구독 3대 저장 + 지난 알림 제외한 큐 3건', Object.keys(rec.subs).length === 3 && rec.queue.length === 3 && rec.queue[0].tag === 'e1|2026-11-09|30', { subs: Object.keys(rec.subs).length, q: rec.queue.map(a => a.tag) });
// 3) 테스트 알림 — 실제 암호화 → 복호화
got.length = 0;
const tr = await handleSync(store, { ...base, action: 'test' }, { verifier, now: NOW, subject: 'https://jini-schedule.netlify.app' });
const gi = got.find(g => g.url.endsWith('iphone'));
const dec = gi && decrypt(iphone, gi);
T('테스트 알림: 2대 도착·복호화 성공·만료 기기 자동 삭제', tr.sent === 2 && dec && dec.title.includes('테스트') && Object.keys((await store.get('user/uidJINI')).subs).length === 2, { tr, dec });
T('VAPID 서명 헤더(Authorization: vapid t=…, k=…)·aes128gcm', gi && /^vapid t=.+, k=.+/.test(gi.headers.authorization) && gi.headers['content-encoding'] === 'aes128gcm' && gi.headers.urgency === 'high', gi && gi.headers);
// 4) 예약 발송: 시각이 된 것(2분 전)만, 미래(3분 후)는 아직
got.length = 0;
let r = await runCron(store, { now: NOW, subject: 'https://jini-schedule.netlify.app' });
const titles = got.map(g => decrypt(g.url.endsWith('iphone') ? iphone : laptop, g).title);
T('예약 발송: 시각 된 1건만 2대로 발송', r.sent === 2 && titles.every(t => t.includes('교과협의회')), { r, titles });
got.length = 0; r = await runCron(store, { now: NOW + 60000 });
T('같은 알림 중복 발송 안 함', r.sent === 0 && got.length === 0, r);
// 5) 앱이 새 목록을 올려도(같은 알림 포함) 중복 없음 + 5분 뒤 다음 알림
await handleSync(store, { ...base, action: 'queue', queue: q }, { verifier, now: NOW + 2 * 60000 });
got.length = 0; r = await runCron(store, { now: NOW + 5 * 60000 });
const t2 = got.map(g => decrypt(g.url.endsWith('iphone') ? iphone : laptop, g).title);
T('새 목록 업로드 후에도 중복 없음, 다음 알림(학운위)만 발송', r.sent === 2 && t2.every(t => t.includes('학운위')), { r, t2 });
// 6) 서버가 늦게 돌아도 20분까지 따라잡기 / 그 이상 지난 건 버림
got.length = 0; r = await runCron(store, { now: NOW + 21 * 3600e3 + 19 * 60000 });
T('19분 늦은 아침 요약도 발송', r.sent === 2, r);
const amDec = decrypt(iphone, got.find(g => g.url.endsWith('iphone')));
T('여러 줄 본문·한글·이모지 보존', amDec.body === '· 종일 동아리\n· 15:00 회의' && amDec.title.startsWith('☀️'), amDec);
// 7) 다른 사용자 분리
await handleSync(store, { idToken: 'tok-other', projectId: 'jini-schedule-3f3c1', action: 'subscribe', subscription: mkSub('other').sub, queue: [{ at: NOW + 22 * 3600e3, title: '남의 알림', tag: 'o' }] }, { verifier, now: NOW });
got.length = 0; r = await runCron(store, { now: NOW + 22 * 3600e3 + 60000 });
T('사용자별 분리 발송', got.length === 1 && got[0].url.endsWith('other'), got.map(g => g.url));
// 8) 구독 해제
await handleSync(store, { ...base, action: 'unsubscribe', endpoint: laptop.sub.endpoint }, { verifier, now: NOW });
T('구독 해제', Object.keys((await store.get('user/uidJINI')).subs).length === 1);
// 9) 푸시 서비스 일시 장애 → 표시 안 하고 다음 실행에 재시도
await handleSync(store, { ...base, action: 'queue', queue: [{ at: NOW + 23 * 3600e3, title: '재시도 알림', tag: 'retry' }] }, { verifier, now: NOW });
respond = 503; got.length = 0; r = await runCron(store, { now: NOW + 23 * 3600e3 + 60000 });
respond = 201; const r2 = await runCron(store, { now: NOW + 23 * 3600e3 + 6 * 60000 });
T('일시 장애 시 5분 뒤 재발송', r.sent === 0 && r2.sent === 1, { r, r2 });
// 10) 잘못된 입력
err = null; try { await handleSync(store, { ...base, action: 'subscribe', subscription: { endpoint: 'http://evil' } }, { verifier, now: NOW }); } catch (e) { err = e; }
T('잘못된 구독 정보 거부', err && err.status === 400);
srv.close();
console.log(`\n${pass}/${pass + fail} PASS`); process.exit(fail ? 1 : 0);
