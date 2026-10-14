/* قعدة محبة · سيرفر الجلسات
   - يقدّم ملفات الصفحة من public/
   - WebSocket على /ws: الغرف بكود 5 أحرف، وهاتف صاحب الجلسة هو صاحب الحالة، والسيرفر يمرّر الرسائل
   - يحتفظ بنسخة من الحالة (snap) حتى يستلم الجلسة شخص آخر إذا غاب صاحبها
   - إحصائيات بلا أسماء على /stats?key=STATS_KEY
   إعداد م. إياد حلوبي */
'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const STATS_KEY = process.env.STATS_KEY || 'qa3da';
const GRACE = +process.env.GRACE_MS || 45000;      // مهلة رجوع صاحب الجلسة قبل أن يستلمها غيره
const ROOM_TTL = 12 * 3600 * 1000;                  // الغرفة تُحذف بعد 12 ساعة بلا نشاط
const MAX_PEERS = 24;

/* ================= الإحصائيات ================= */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const blank = () => ({ since: new Date().toISOString(), sessions: 0, groupsStarted: 0, groupPlayers: 0, groupResults: 0, groupPeopleResults: 0, solos: 0, kicks: 0, takeovers: 0, langs: { w: 0, t: 0, g: 0, s: 0, p: 0 }, soloLangs: { w: 0, t: 0, g: 0, s: 0, p: 0 }, days: {} });
let STATS = blank();
let pg = null;
async function loadStats() {
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      pg = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false } });
      await pg.query('CREATE TABLE IF NOT EXISTS qa3da_kv (id TEXT PRIMARY KEY, data JSONB NOT NULL)');
      const r = await pg.query("SELECT data FROM qa3da_kv WHERE id='mahabba-stats'");
      if (r.rows[0]) STATS = { ...blank(), ...r.rows[0].data };
      console.log('stats: postgres');
      return;
    } catch (e) { console.error('pg failed, using file', e.message); pg = null; }
  }
  try { STATS = { ...blank(), ...JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) }; } catch (e) {}
}
let saveT = null;
function saveStats() {
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    if (pg) { try { await pg.query("INSERT INTO qa3da_kv(id,data) VALUES('mahabba-stats',$1) ON CONFLICT(id) DO UPDATE SET data=$1", [STATS]); } catch (e) { console.error(e.message); } return; }
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATS_FILE, JSON.stringify(STATS)); } catch (e) {}
  }, 1500);
}
const LK = ['w', 't', 'g', 's', 'p'];
function stat(ev, d) {
  d = d || {};
  const day = new Date().toISOString().slice(0, 10);
  const D = STATS.days[day] || (STATS.days[day] = { sessions: 0, groups: 0, solos: 0 });
  if (ev === 'open') { STATS.sessions++; D.sessions++; }
  else if (ev === 'start') { STATS.groupsStarted++; STATS.groupPlayers += Math.max(0, Math.min(MAX_PEERS, +d.n || 0)); D.groups++; }
  else if (ev === 'result') {
    STATS.groupResults++;
    (Array.isArray(d.tops) ? d.tops : []).slice(0, MAX_PEERS).forEach(k => { if (LK.includes(k)) { STATS.langs[k]++; STATS.groupPeopleResults++; } });
  }
  else if (ev === 'solo') { STATS.solos++; D.solos++; if (LK.includes(d.top)) STATS.soloLangs[d.top]++; }
  else if (ev === 'kick') STATS.kicks++;
  else if (ev === 'takeover') STATS.takeovers++;
  else return;
  saveStats();
}

/* ================= HTTP ================= */
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, p) {
    if (/\.(html|webmanifest)$/.test(p) || p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=604800');
  }
}));
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.post('/api/stat', express.text({ type: '*/*', limit: '4kb' }), (req, res) => {
  try { const d = JSON.parse(req.body || '{}'); if (d.ev === 'solo') stat('solo', d); } catch (e) {}
  res.status(204).end();
});
const LN = { w: 'كلمات التقدير', t: 'الوقت النوعي', g: 'الهدايا', s: 'الأفعال والخدمات', p: 'اللمسة' };
app.get('/stats', (req, res) => {
  if (req.query.key !== STATS_KEY) return res.status(403).type('text').send('غير مسموح');
  const S = STATS, live = [...rooms.values()].filter(r => r.host || r.peers.size).length;
  const totL = LK.reduce((a, k) => a + S.langs[k] + S.soloLangs[k], 0) || 1;
  const rowsL = LK.map(k => ({ k, n: S.langs[k] + S.soloLangs[k] })).sort((a, b) => b.n - a.n)
    .map(x => `<tr><td>${LN[x.k]}</td><td>${S.langs[x.k]}</td><td>${S.soloLangs[x.k]}</td><td><div class="b"><i style="width:${Math.round(100 * x.n / totL)}%"></i></div></td><td>${Math.round(100 * x.n / totL)}%</td></tr>`).join('');
  const days = Object.entries(S.days).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 30)
    .map(([d, v]) => `<tr><td>${d}</td><td>${v.sessions}</td><td>${v.groups}</td><td>${v.solos}</td></tr>`).join('');
  const avg = S.groupsStarted ? (S.groupPlayers / S.groupsStarted).toFixed(1) : '0';
  res.type('html').send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>إحصائيات قعدة محبة</title>
<style>body{font-family:system-ui,sans-serif;background:#F4F2EE;color:#1E2024;margin:0;padding:24px 16px;line-height:1.7}main{max-width:760px;margin:auto}h1{margin:0 0 4px}p{color:#74767C;margin:0 0 20px}
.k{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:24px}.k div{background:#fff;border:1px solid #E3DFD8;border-radius:14px;padding:14px}.k b{display:block;font-size:28px}.k span{color:#74767C;font-size:13px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #E3DFD8;border-radius:14px;overflow:hidden;margin-bottom:24px}th,td{padding:8px 12px;text-align:right;border-bottom:1px solid #EEE9E1;font-variant-numeric:tabular-nums}th{font-size:13px;color:#74767C}
.b{height:8px;background:#EEE9E1;border-radius:4px;overflow:hidden;min-width:80px}.b i{display:block;height:100%;background:#1E2024}</style></head><body><main>
<h1>إحصائيات قعدة محبة</h1><p>منذ ${S.since.slice(0, 10)} · الأرقام دون أسماء أو صور</p>
<div class="k"><div><b>${S.sessions}</b><span>جلسات فُتحت</span></div><div><b>${S.groupsStarted}</b><span>جلسات بدأت</span></div><div><b>${avg}</b><span>متوسط المشاركين في الجلسة</span></div>
<div><b>${S.groupResults}</b><span>جلسات عرضت نتائجها</span></div><div><b>${S.groupPeopleResults}</b><span>نتائج أشخاص في الجلسات</span></div><div><b>${S.solos}</b><span>تجارب فردية مكتملة</span></div>
<div><b>${live}</b><span>جلسات نشطة الآن</span></div><div><b>${S.kicks}</b><span>عمليات إخراج</span></div><div><b>${S.takeovers}</b><span>استلام جلسة بعد غياب صاحبها</span></div></div>
<table><tr><th>اللغة الأولى</th><th>في الجلسات</th><th>فردي</th><th colspan="2">النسبة من المجموع</th></tr>${rowsL}</table>
<table><tr><th>اليوم</th><th>جلسات فُتحت</th><th>جلسات بدأت</th><th>تجارب فردية</th></tr>${days || '<tr><td colspan="4">لا توجد بيانات بعد</td></tr>'}</table>
</main></body></html>`);
});
app.use((req, res) => res.redirect('/'));

/* ================= الغرف ================= */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });
const rooms = new Map();
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { let c; do { c = Array.from(crypto.randomBytes(5), b => ALPHA[b % ALPHA.length]).join(''); } while (rooms.has(c)); return c; };
const newSecret = () => crypto.randomBytes(18).toString('base64url');
const send = (ws, o) => { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch (e) {} } };
const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
const cleanId = c => String(c || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

function mkRoom(code, secret) {
  const r = { code, secret, host: null, hostCid: null, peers: new Map(), kicked: new Set(), snap: null, last: Date.now(), downAt: 0, vacT: null };
  rooms.set(code, r);
  return r;
}
function setHost(r, ws, cid) {
  if (r.host && r.host !== ws) { send(r.host, { t: 'denied' }); try { r.host.close(); } catch (e) {} }
  clearTimeout(r.vacT);
  r.host = ws; r.hostCid = cid || r.hostCid; r.downAt = 0;
  ws.room = r.code; ws.role = 'host'; ws.cid = r.hostCid;
  if (r.hostCid) r.peers.delete(r.hostCid);
  r.peers.forEach(p => send(p, { t: 'host-up' }));
}
function hostGone(r) {
  r.host = null; r.downAt = Date.now();
  r.peers.forEach(p => send(p, { t: 'host-down', grace: GRACE }));
  clearTimeout(r.vacT);
  r.vacT = setTimeout(() => { if (!r.host) r.peers.forEach(p => send(p, { t: 'host-vacant' })); }, GRACE);
}

wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const r = ws.room ? rooms.get(ws.room) : null;
    if (r) r.last = Date.now();
    switch (m.t) {
      case 'ping': send(ws, { t: 'pong' }); break;

      case 'create': {
        const code = newCode(), secret = newSecret();
        const room = mkRoom(code, secret);
        setHost(room, ws, cleanId(m.cid));
        send(ws, { t: 'created', code, secret });
        stat('open');
        break;
      }
      case 'resume': {
        const code = cleanCode(m.code);
        let room = rooms.get(code);
        if (!room) room = mkRoom(code, String(m.secret || ''));   // السيرفر أعاد التشغيل: نعيد بناء الغرفة
        if (room.secret !== m.secret) { send(ws, { t: 'denied' }); break; }
        setHost(room, ws, cleanId(m.cid));
        send(ws, { t: 'resumed', peers: [...room.peers.keys()] });
        break;
      }
      case 'join': {
        const code = cleanCode(m.code), cid = cleanId(m.cid);
        const room = rooms.get(code);
        if (!room || !cid) { send(ws, { t: 'no-room' }); break; }
        if (room.kicked.has(cid)) { send(ws, { t: 'kicked' }); break; }
        if (!room.peers.has(cid) && room.peers.size >= MAX_PEERS) { send(ws, { t: 'full' }); break; }
        const old = room.peers.get(cid);
        if (old && old !== ws) { old.replaced = true; try { old.close(); } catch (e) {} }
        room.peers.set(cid, ws);
        ws.room = code; ws.role = 'peer'; ws.cid = cid; room.last = Date.now();
        const left = room.host ? 0 : Math.max(0, GRACE - (Date.now() - room.downAt));
        send(ws, { t: 'joined', host: !!room.host, grace: left, vacant: !room.host && left === 0 });
        send(room.host, { t: 'peer', cid, on: true });
        break;
      }
      case 'up':
        if (r && ws.role === 'peer') send(r.host, { t: 'from', cid: ws.cid, msg: m.msg });
        break;
      case 'all':
        if (r && ws.role === 'host') { const s = JSON.stringify({ t: 'msg', msg: m.msg }); r.peers.forEach(p => { if (p.readyState === 1) p.send(s); }); }
        break;
      case 'to':
        if (r && ws.role === 'host') send(r.peers.get(cleanId(m.cid)), { t: 'msg', msg: m.msg });
        break;
      case 'kick':
        if (r && ws.role === 'host') {
          const cid = cleanId(m.cid); r.kicked.add(cid);
          const p = r.peers.get(cid);
          if (p) { send(p, { t: 'kicked' }); p.replaced = true; try { p.close(); } catch (e) {} r.peers.delete(cid); }
          stat('kick');
        }
        break;
      case 'snap':
        if (r && ws.role === 'host' && m.snap) r.snap = m.snap;
        break;
      case 'claim':
        if (r && ws.role === 'peer') {
          if (r.host || Date.now() - r.downAt < GRACE) { send(ws, { t: 'claim-no' }); break; }
          r.secret = newSecret();
          const cid = ws.cid;
          setHost(r, ws, cid);
          send(ws, { t: 'promoted', code: r.code, secret: r.secret, snap: r.snap, peers: [...r.peers.keys()] });
          stat('takeover');
        }
        break;
      case 'stat':
        if (r && ws.role === 'host' && (m.ev === 'start' || m.ev === 'result')) stat(m.ev, m);
        break;
    }
  });
  ws.on('close', () => {
    if (ws.replaced) return;
    const r = ws.room ? rooms.get(ws.room) : null;
    if (!r) return;
    if (ws.role === 'host' && r.host === ws) hostGone(r);
    else if (ws.role === 'peer' && r.peers.get(ws.cid) === ws) { r.peers.delete(ws.cid); send(r.host, { t: 'peer', cid: ws.cid, on: false }); }
  });
});

/* نبض لكشف الاتصالات الميتة، وتنظيف الغرف القديمة */
setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.alive) { try { ws.terminate(); } catch (e) {} return; } ws.alive = false; try { ws.ping(); } catch (e) {} });
}, 25000);
setInterval(() => {
  const now = Date.now();
  rooms.forEach((r, c) => { if (!r.host && !r.peers.size && now - r.last > ROOM_TTL) rooms.delete(c); });
}, 10 * 60 * 1000);

loadStats().then(() => server.listen(PORT, () => console.log('قعدة محبة على المنفذ ' + PORT)));
