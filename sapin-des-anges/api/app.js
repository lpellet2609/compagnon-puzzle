'use strict';
// Le Sapin des Anges — API unique (POST /api/app, champ "action").
// Toute la confidentialité est appliquée ICI : le navigateur ne reçoit jamais
// les données qu'il n'a pas le droit de voir.
const crypto = require('crypto');

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const P = 'sapin:';
const REVEAL_AT = Date.parse(process.env.REVEAL_AT || '2026-12-24T18:00:00+01:00');
const SESSION_SECONDS = 60 * 86400;
const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;
const BAD_LINK = 'Ce lien n’est pas (ou plus) valable. Demande un nouveau lien à l’organisateur.';

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const rand = (n) => crypto.randomBytes(n).toString('base64url');

// ---------- Base de données (Upstash Redis, API REST) ----------
async function pipe(cmds) {
  if (!cmds.length) return [];
  if (!DB_URL) {
    if (global.__sapinMock) return global.__sapinMock(cmds);
    fail(503, 'La base de données n’est pas encore connectée au projet.');
  }
  const r = await fetch(DB_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds.map((c) => c.map(String))),
  });
  if (!r.ok) throw new Error('Upstash HTTP ' + r.status);
  const out = await r.json();
  return out.map((x) => { if (x.error) throw new Error('Upstash: ' + x.error); return x.result; });
}
const cmd = async (...c) => (await pipe([c]))[0];
function toObj(a) {
  const o = {};
  if (Array.isArray(a)) for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1];
  else if (a && typeof a === 'object') Object.assign(o, a);
  return o;
}
const nums = (o) => { for (const k in o) o[k] = Number(o[k]); return o; };
const sum = (o) => Object.values(o).reduce((t, v) => t + v, 0);

// ---------- Personnes, codes, sessions ----------
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString('hex');
function checkPinStrength(pin) {
  if (!/^\d{4}$/.test(pin || '')) fail(400, 'Le code doit faire exactement 4 chiffres.');
  const d = [...pin].map(Number);
  if (d.every((x) => x === d[0])) fail(400, 'Code trop facile : évite 4 chiffres identiques.');
  const asc = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const desc = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
  if (asc || desc) fail(400, 'Code trop facile : évite les suites comme 1234 ou 4321.');
}
async function getPerson(id) {
  if (typeof id !== 'string') return null;
  const s = await cmd('HGET', P + 'people', id);
  return s ? JSON.parse(s) : null;
}
const savePerson = (p) => cmd('HSET', P + 'people', p.id, JSON.stringify(p));
async function personByToken(t) {
  if (typeof t !== 'string' || !t || t.length > 64) fail(404, BAD_LINK);
  const id = await cmd('GET', P + 'token:' + t);
  const p = id && (await getPerson(id));
  if (!p) fail(404, BAD_LINK);
  return p;
}
function getCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(/;\s*/)) {
    const k = part.indexOf('=');
    if (k > 0 && part.slice(0, k) === name) return decodeURIComponent(part.slice(k + 1));
  }
  return null;
}
const setCookie = (res, val, maxAge) =>
  res.setHeader('Set-Cookie', `sapin_sid=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
async function openSession(res, pid) {
  const sid = rand(32);
  await pipe([['SET', P + 'session:' + sid, pid, 'EX', SESSION_SECONDS], ['SADD', P + 'sessions:' + pid, sid]]);
  setCookie(res, sid, SESSION_SECONDS);
}
async function currentPerson(req) {
  const sid = getCookie(req, 'sapin_sid');
  if (!sid) fail(401, 'Ouvre le lien personnel que tu as reçu.');
  const pid = await cmd('GET', P + 'session:' + sid);
  const p = pid && (await getPerson(pid));
  if (!p) fail(401, 'Ta session a expiré. Rouvre ton lien personnel.');
  return { p, sid };
}
async function killSessions(pid) {
  const sids = (await cmd('SMEMBERS', P + 'sessions:' + pid)) || [];
  await pipe([...sids.map((s) => ['DEL', P + 'session:' + s]), ['DEL', P + 'sessions:' + pid]]);
}

// ---------- Idées ----------
async function loadAll() {
  const [pp, ii, ff, bb] = await pipe([
    ['HGETALL', P + 'people'], ['HGETALL', P + 'ideas'], ['HGETALL', P + 'full'], ['HGETALL', P + 'buyer'],
  ]);
  const people = Object.values(toObj(pp)).map((s) => JSON.parse(s)).sort((a, b) => a.createdAt - b.createdAt);
  const ideas = Object.values(toObj(ii)).map((s) => JSON.parse(s)).sort((a, b) => a.createdAt - b.createdAt);
  const cr = await pipe(ideas.map((i) => ['HGETALL', P + 'contrib:' + i.id]));
  const contribs = {};
  ideas.forEach((i, k) => { contribs[i.id] = nums(toObj(cr[k])); });
  const op = await pipe(people.map((p) => ['SMEMBERS', P + 'opened:' + p.id]));
  const opened = {};
  people.forEach((p, k) => { opened[p.id] = (op[k] || []).map(Number).sort((a, b) => a - b); });
  return { people, ideas, full: toObj(ff), buyer: toObj(bb), contribs, opened };
}
async function getIdea(id) {
  const s = typeof id === 'string' && id.length < 40 && (await cmd('HGET', P + 'ideas', id));
  if (!s) fail(404, 'Cette idée n’existe plus.');
  return JSON.parse(s);
}
async function ideaState(id) {
  const [f, b, c] = await pipe([['HGET', P + 'full', id], ['HGET', P + 'buyer', id], ['HGETALL', P + 'contrib:' + id]]);
  return { fullBy: f || null, buyer: b || null, contrib: nums(toObj(c)) };
}
const deleteIdeaCmds = (id) => [
  ['HDEL', P + 'ideas', id], ['HDEL', P + 'full', id], ['HDEL', P + 'buyer', id], ['DEL', P + 'contrib:' + id],
];
async function cleanupIfOrphan(idea) {
  if (!idea.removed) return;
  const s = await ideaState(idea.id);
  if (!s.fullBy && !Object.keys(s.contrib).length) await pipe(deleteIdeaCmds(idea.id));
}

// Ce que la personne `me` a le droit de voir. C'est le cœur des règles de secret.
function viewFor(me, d) {
  const revealed = Date.now() >= REVEAL_AT;
  const ideas = [];
  for (const i of d.ideas) {
    const base = { id: i.id, forId: i.forId, byId: i.byId, title: i.title, price: i.price, link: i.link, prio: i.prio };
    if (i.forId === me) {
      // Pour moi : mes vœux seulement, sans aucune info de réservation. Les idées secrètes restent secrètes.
      if (i.removed) continue;
      if (i.byId === me) ideas.push(base);
      continue;
    }
    const c = d.contribs[i.id] || {};
    const fullBy = d.full[i.id] || null;
    const buyer = d.buyer[i.id] || null;
    if (i.removed && fullBy !== me && c[me] == null) continue;
    const o = { ...base, removed: !!i.removed, fullBy };
    const n = Object.keys(c).length;
    if (n) {
      const total = sum(c);
      o.pot = { total, remaining: i.price ? Math.max(0, i.price - total) : null, count: n, mine: c[me] ?? null, buyer };
      // Seul l'acheteur voit qui a mis combien (pour se faire rembourser).
      if (buyer === me) o.pot.detail = Object.entries(c).map(([by, amount]) => ({ by, amount }));
    }
    ideas.push(o);
  }
  return {
    me,
    people: d.people.map((p) => ({ id: p.id, name: p.name })),
    ideas,
    revealed,
    revealAt: REVEAL_AT,
    calDay: calendarDay(),
    opened: (d.opened && d.opened[me]) || [],
  };
}
// Jour du calendrier de l'Avent à Paris : 0 avant le 1er décembre, 1 à 24 en décembre, 25 ensuite.
function calendarDay() {
  if (process.env.CAL_DAY) return Math.max(0, Math.min(25, Number(process.env.CAL_DAY) || 0));
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).split('-').map(Number);
  if (y < 2026 || (y === 2026 && m < 12)) return 0;
  if (y === 2026 && m === 12) return Math.min(d, 25);
  return 25;
}

function cleanIdeaInput(b, forSelf) {
  const title = String(b.title || '').trim().slice(0, 140);
  if (!title) fail(400, 'Décris ton idée en quelques mots.');
  let price = null;
  if (b.price !== undefined && b.price !== null && b.price !== '') {
    price = Math.round(Number(b.price));
    if (!(price >= 1 && price <= 100000)) fail(400, 'Le prix doit être un nombre d’euros (ou rester vide).');
  }
  let link = String(b.link || '').trim().slice(0, 500);
  if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
  const prio = forSelf ? Math.min(3, Math.max(1, Math.round(Number(b.prio) || 2))) : 0;
  return { title, price, link, prio };
}

// ---------- Administration ----------
function checkAdmin(key) {
  const k = process.env.ADMIN_KEY;
  if (!k) fail(503, 'Clé d’administration non configurée.');
  const a = crypto.createHash('sha256').update(String(key || '')).digest();
  const b = crypto.createHash('sha256').update(k).digest();
  if (!crypto.timingSafeEqual(a, b)) fail(403, 'Clé d’administration incorrecte.');
}
const cleanName = (n) => {
  const s = String(n || '').trim().slice(0, 40);
  if (!s) fail(400, 'Indique un prénom.');
  return s;
};

// ---------- Codes et lien de groupe ----------
async function setPinFor(res, p, pin, takenMsg) {
  if (p.pinHash) fail(409, takenMsg);
  checkPinStrength(pin);
  p.pinSalt = rand(16);
  p.pinHash = hashPin(pin, p.pinSalt);
  p.pinSetAt = Date.now();
  await savePerson(p);
  await openSession(res, p.id);
  return { ok: true };
}
async function loginFor(res, p, pin) {
  if (!p.pinHash) fail(409, 'Choisis d’abord ton code.');
  const fails = Number(await cmd('GET', P + 'fail:' + p.id)) || 0;
  if (fails >= MAX_FAILS) fail(429, 'Trop d’essais. Réessaie dans 15 minutes.');
  const ok = typeof pin === 'string' && /^\d{4}$/.test(pin) &&
    crypto.timingSafeEqual(Buffer.from(hashPin(pin, p.pinSalt), 'hex'), Buffer.from(p.pinHash, 'hex'));
  if (!ok) {
    await pipe([['INCR', P + 'fail:' + p.id], ['EXPIRE', P + 'fail:' + p.id, LOCK_SECONDS]]);
    const left = MAX_FAILS - fails - 1;
    fail(403, left > 0 ? `Code incorrect. Encore ${left} essai${left > 1 ? 's' : ''}.` : 'Code incorrect. Accès bloqué 15 minutes.');
  }
  await cmd('DEL', P + 'fail:' + p.id);
  await openSession(res, p.id);
  return { ok: true };
}
async function checkInvite(code) {
  const real = await cmd('GET', P + 'invite');
  const a = crypto.createHash('sha256').update(String(code || '')).digest();
  const b = crypto.createHash('sha256').update(String(real || '')).digest();
  if (!real || !code || !crypto.timingSafeEqual(a, b)) fail(404, 'Ce lien de groupe n’est pas (ou plus) valable. Demande le nouveau lien à l’organisateur.');
}

// ---------- Rappel du soir (notifications) ----------
let webpush = null;
function push() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) fail(503, 'Les rappels ne sont pas encore configurés.');
  if (!webpush) {
    webpush = require('web-push');
    webpush.setVapidDetails('https://sapin-des-anges.vercel.app', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  }
  return webpush;
}
const subKey = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 24);
// Envoie une notification à tous les appareils d'une personne ; retire les abonnements expirés.
async function notifyPerson(pid, payload) {
  const subs = toObj(await cmd('HGETALL', P + 'push:' + pid));
  let sent = 0;
  for (const [k, raw] of Object.entries(subs)) {
    try { await push().sendNotification(JSON.parse(raw), JSON.stringify(payload), { TTL: 6 * 3600 }); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await cmd('HDEL', P + 'push:' + pid, k); else console.error('push', e.statusCode || e.message); }
  }
  return sent;
}
let DAYS_CACHE = null;
function dayTitle(n) {
  try { DAYS_CACHE = DAYS_CACHE || require('../avent/days.json'); const d = DAYS_CACHE.find((x) => x.day === n); return d ? d.title : ''; } catch { return ''; }
}
const reminderFor = (n) => ({ title: 'Toc toc toc !', body: `La fenêtre du ${n} décembre est prête${dayTitle(n) ? ' : ' + dayTitle(n) : '.'}`, url: `/?jour=${n}` });
// Appelé par les tâches programmées : prévient, vers 19 h chez eux, ceux qui n'ont pas ouvert la fenêtre du jour.
async function eveningReminders() {
  const day = calendarDay();
  if (day < 1 || day > 24) return { day, sent: 0, skipped: 'hors de l’Avent' };
  const people = Object.values(toObj(await cmd('HGETALL', P + 'people'))).map((x) => JSON.parse(x));
  let sent = 0; const detail = [];
  for (const p of people) {
    const [n, tz, opened] = await pipe([['HLEN', P + 'push:' + p.id], ['GET', P + 'tz:' + p.id], ['SISMEMBER', P + 'opened:' + p.id, day]]);
    if (!Number(n)) continue;
    let hour = 19;
    try { hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(new Date())); } catch {}
    if (hour < 19 || hour > 20) { detail.push([p.name, 'pas 19 h chez lui', hour]); continue; }
    if (Number(opened)) { detail.push([p.name, 'déjà ouverte']); continue; }
    const first = await cmd('SET', P + 'pushsent:' + p.id + ':' + day, '1', 'NX', 'EX', 172800);
    if (!first) { detail.push([p.name, 'déjà prévenu']); continue; }
    const k = await notifyPerson(p.id, reminderFor(day)); sent += k; detail.push([p.name, 'envoyé', k]);
  }
  return { day, sent, detail };
}

// ---------- Routeur ----------
async function route(req, res, b) {
  const a = b.action;

  // Accès par lien personnel + code
  if (a === 'hello') {
    const p = await personByToken(b.token);
    return { id: p.id, name: p.name, hasPin: !!p.pinHash };
  }
  if (a === 'setPin') {
    const p = await personByToken(b.token);
    return setPinFor(res, p, b.pin, 'Un code a déjà été choisi pour ce lien. Tape-le, ou demande une réinitialisation.');
  }
  if (a === 'login') return loginFor(res, await personByToken(b.token), b.pin);

  // Accès par le lien de groupe : on choisit son prénom, puis on choisit ou tape son code
  if (a === 'inviteInfo') {
    await checkInvite(b.invite);
    const d = await loadAll();
    return { people: d.people.map((p) => ({ id: p.id, name: p.name, hasPin: !!p.pinHash })) };
  }
  if (a === 'inviteSetPin') {
    await checkInvite(b.invite);
    const p = await getPerson(b.id);
    if (!p) fail(404, 'Ce prénom n’est plus sur le Betlehem.');
    return setPinFor(res, p, b.pin, `${p.name} a déjà choisi son code. Si ce n’est pas toi, préviens l’organisateur.`);
  }
  if (a === 'inviteLogin') {
    await checkInvite(b.invite);
    const p = await getPerson(b.id);
    if (!p) fail(404, 'Ce prénom n’est plus sur le Betlehem.');
    return loginFor(res, p, b.pin);
  }

  // Administration (clé secrète, aucune idée visible)
  if (a && a.startsWith('admin')) {
    checkAdmin(b.key);
    if (a === 'adminList') {
      const d = await loadAll();
      const invite = await cmd('GET', P + 'invite');
      const pc = await pipe(d.people.map((p) => ['HLEN', P + 'push:' + p.id]));
      return { invite, people: d.people.map((p, k) => ({ id: p.id, name: p.name, token: p.token, hasPin: !!p.pinHash, push: Number(pc[k]) || 0 })) };
    }
    if (a === 'adminInvite') {
      const invite = rand(12);
      await cmd('SET', P + 'invite', invite);
      return { invite };
    }
    if (a === 'adminAdd') {
      const p = { id: rand(6), name: cleanName(b.name), token: rand(18), createdAt: Date.now() };
      await pipe([['HSET', P + 'people', p.id, JSON.stringify(p)], ['SET', P + 'token:' + p.token, p.id]]);
      return { ok: true };
    }
    const p = await getPerson(b.id);
    if (!p) fail(404, 'Personne introuvable.');
    if (a === 'adminTestPush') {
      const n = Math.max(1, Math.min(24, calendarDay() || 1));
      const sent = await notifyPerson(p.id, { ...reminderFor(n), title: 'Toc toc toc ! (essai)' });
      if (!sent) fail(409, `${p.name} n’a pas encore activé le rappel du soir sur un appareil.`);
      return { ok: true, sent };
    }
    if (a === 'adminRename') { p.name = cleanName(b.name); await savePerson(p); return { ok: true }; }
    if (a === 'adminReset') {
      await cmd('DEL', P + 'token:' + p.token);
      p.token = rand(18);
      delete p.pinHash; delete p.pinSalt; delete p.pinSetAt;
      await pipe([['HSET', P + 'people', p.id, JSON.stringify(p)], ['SET', P + 'token:' + p.token, p.id], ['DEL', P + 'fail:' + p.id]]);
      await killSessions(p.id);
      return { ok: true };
    }
    if (a === 'adminDelete') {
      const d = await loadAll();
      const cmds = [];
      for (const i of d.ideas) {
        if (i.forId === p.id) { cmds.push(...deleteIdeaCmds(i.id)); continue; }
        if (d.full[i.id] === p.id) cmds.push(['HDEL', P + 'full', i.id]);
        const c = d.contribs[i.id];
        if (c[p.id] != null) {
          cmds.push(['HDEL', P + 'contrib:' + i.id, p.id]);
          if (d.buyer[i.id] === p.id) {
            const next = Object.keys(c).find((k) => k !== p.id);
            cmds.push(next ? ['HSET', P + 'buyer', i.id, next] : ['HDEL', P + 'buyer', i.id]);
          }
        }
      }
      cmds.push(['HDEL', P + 'people', p.id], ['DEL', P + 'token:' + p.token], ['DEL', P + 'fail:' + p.id], ['DEL', P + 'opened:' + p.id], ['DEL', P + 'push:' + p.id], ['DEL', P + 'tz:' + p.id]);
      await pipe(cmds);
      await killSessions(p.id);
      return { ok: true };
    }
    fail(400, 'Action inconnue.');
  }

  // À partir d'ici : il faut être connecté
  const { p: me, sid } = await currentPerson(req);
  const mine = me.id;

  if (a === 'state') return viewFor(mine, await loadAll());
  if (a === 'logout') {
    await pipe([['DEL', P + 'session:' + sid], ['SREM', P + 'sessions:' + mine, sid]]);
    setCookie(res, '', 0);
    return { ok: true };
  }
  if (a === 'pushConfig') return { publicKey: process.env.VAPID_PUBLIC_KEY || null };
  if (a === 'pushSubscribe') {
    const sub = b.sub || {};
    if (typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000 || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') fail(400, 'Abonnement invalide.');
    const clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) } };
    let tz = String(b.tz || '').slice(0, 64);
    try { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); } catch { tz = 'Europe/Paris'; }
    await pipe([['HSET', P + 'push:' + mine, subKey(clean.endpoint), JSON.stringify(clean)], ['SET', P + 'tz:' + mine, tz || 'Europe/Paris']]);
    return { ok: true };
  }
  if (a === 'pushUnsubscribe') {
    if (typeof b.endpoint === 'string') await cmd('HDEL', P + 'push:' + mine, subKey(b.endpoint));
    return { ok: true };
  }
  if (a === 'openDay') {
    const n = Math.round(Number(b.day));
    if (!(n >= 1 && n <= 24)) fail(400, 'Jour inconnu.');
    if (n > calendarDay()) fail(403, `Cette fenêtre s’ouvrira le ${n} décembre.`);
    await cmd('SADD', P + 'opened:' + mine, n);
    return { ok: true };
  }
  if (a === 'addIdea') {
    const target = await getPerson(b.forId);
    if (!target) fail(404, 'Cette personne n’est plus sur le sapin.');
    const fields = cleanIdeaInput(b, target.id === mine);
    const idea = { id: rand(8), forId: target.id, byId: mine, ...fields, createdAt: Date.now() };
    await cmd('HSET', P + 'ideas', idea.id, JSON.stringify(idea));
    return { ok: true };
  }

  const i = await getIdea(b.id);
  if (a === 'removeIdea') {
    if (i.byId !== mine) fail(403, 'Tu ne peux retirer que les idées que tu as proposées.');
    const s = await ideaState(i.id);
    if (s.fullBy || Object.keys(s.contrib).length) {
      i.removed = true; // les personnes engagées seront prévenues
      await cmd('HSET', P + 'ideas', i.id, JSON.stringify(i));
    } else {
      await pipe(deleteIdeaCmds(i.id));
    }
    return { ok: true };
  }
  if (i.forId === mine) fail(403, 'Pas de triche : tu ne peux pas réserver tes propres cadeaux !');
  const s = await ideaState(i.id);

  if (a === 'offer') {
    if (i.removed) fail(409, 'Cette idée a été retirée.');
    if (Object.keys(s.contrib).length) fail(409, 'Une cagnotte est déjà lancée sur ce cadeau : participe plutôt.');
    const got = await cmd('HSETNX', P + 'full', i.id, mine);
    if (Number(got) !== 1) fail(409, 'Quelqu’un vient déjà de le réserver.');
    return { ok: true };
  }
  if (a === 'cancelOffer') {
    if (s.fullBy !== mine) fail(409, 'Tu n’as pas réservé ce cadeau.');
    await cmd('HDEL', P + 'full', i.id);
    await cleanupIfOrphan(i);
    return { ok: true };
  }
  if (a === 'contribute') {
    if (i.removed) fail(409, 'Cette idée a été retirée.');
    if (!i.price) fail(400, 'Il faut un prix pour lancer un cadeau commun.');
    if (s.fullBy) fail(409, 'Quelqu’un offre déjà ce cadeau en entier.');
    const others = Object.entries(s.contrib).filter(([k]) => k !== mine).reduce((t, [, v]) => t + v, 0);
    const remaining = i.price - others;
    if (remaining <= 0) fail(409, 'Ce cadeau est déjà entièrement financé.');
    let amount = Math.round(Number(b.amount));
    if (!(amount >= 1)) fail(400, 'Indique un montant d’au moins 1 €.');
    amount = Math.min(amount, remaining);
    await pipe([['HSET', P + 'contrib:' + i.id, mine, amount], ['HSETNX', P + 'buyer', i.id, mine]]);
    return { ok: true, amount };
  }
  if (a === 'leave') {
    if (s.contrib[mine] == null) fail(409, 'Tu ne participes pas à ce cadeau.');
    const cmds = [['HDEL', P + 'contrib:' + i.id, mine]];
    if (s.buyer === mine) {
      const next = Object.keys(s.contrib).find((k) => k !== mine);
      cmds.push(next ? ['HSET', P + 'buyer', i.id, next] : ['HDEL', P + 'buyer', i.id]);
    }
    await pipe(cmds);
    await cleanupIfOrphan(i);
    return { ok: true };
  }
  if (a === 'takeBuyer') {
    if (s.contrib[mine] == null) fail(409, 'Participe d’abord à la cagnotte.');
    await cmd('HSET', P + 'buyer', i.id, mine);
    return { ok: true };
  }
  fail(400, 'Action inconnue.');
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'Méthode non autorisée.' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  try {
    const out = await route(req, res, body || {});
    send(res, 200, out || { ok: true });
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Petit souci technique. Réessaie dans un instant.' });
  }
};
module.exports.viewFor = viewFor;
module.exports.eveningReminders = eveningReminders;
