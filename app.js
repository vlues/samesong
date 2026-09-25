import { joinRoom, selfId } from 'https://esm.run/trystero@0.25/nostr';

// Put your Spotify app's Client ID here (developer.spotify.com → Create app,
// redirect URI = this page's URL). Leave blank and the Spotify button explains.
const SPOTIFY_CLIENT_ID = '';
const APP_ID = 'same-second-v1';
const SYNC_WINDOW = 6000;   // ms apart and you're still "at the same second"
const HARMONY_WINDOW = 180; // ms between taps from different people = harmony

const $ = s => document.querySelector(s);
const show = id => document.querySelectorAll('.screen').forEach(s => s.classList.toggle('hidden', s.id !== id));
const fmt = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const hue = id => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const myHue = hue(selfId);

// Same song across Spotify / Apple / SoundCloud = same normalized title + artist.
const norm = s => s.toLowerCase().replace(/\(.*?\)|\[.*?\]|feat\..*|ft\..*| - .*remaster.*/g, '').replace(/[^a-z0-9]/g, '');
async function roomKey(title, artist) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm(title) + '|' + norm(artist.split(/,|&/)[0])));
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- state ----------
let track = null;       // {title, artist, art, duration}
let startedAt = 0;      // epoch ms when the song was at 0:00 for me
let room = null, send = {};
let peers = {};         // id -> {startedAt, hue, seen}
let stats = {};
const pos = () => Date.now() - startedAt;

// ---------- song search (iTunes catalog covers basically everything) ----------
let qTimer;
$('#q').addEventListener('input', e => {
  clearTimeout(qTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { $('#results').innerHTML = ''; return; }
  qTimer = setTimeout(async () => {
    const r = await fetch(`https://itunes.apple.com/search?entity=song&limit=8&term=${encodeURIComponent(q)}`).then(r => r.json()).catch(() => ({ results: [] }));
    $('#results').innerHTML = '';
    for (const s of r.results) {
      const li = document.createElement('li');
      li.innerHTML = `<img src="${s.artworkUrl100}" alt=""><div><div></div><small></small></div>`;
      li.querySelector('div div').textContent = s.trackName;
      li.querySelector('small').textContent = s.artistName;
      li.onclick = () => pickSong({ title: s.trackName, artist: s.artistName, art: s.artworkUrl100.replace('100x100', '600x600'), duration: s.trackTimeMillis });
      $('#results').append(li);
    }
  }, 250);
});

function pickSong(t) {
  track = t;
  $('#syncArt').src = t.art; $('#syncTitle').textContent = `${t.title} — ${t.artist}`;
  $('#scrub').max = t.duration; $('#scrub').value = 0; $('#scrubVal').textContent = '0:00';
  show('sync');
}
$('#scrub').oninput = e => $('#scrubVal').textContent = fmt(+e.target.value);
$('#startBtn').onclick = () => { startedAt = Date.now() - +$('#scrub').value; enter(); };
$('#fromTop').onclick = () => { startedAt = Date.now(); enter(); };
document.querySelectorAll('.back').forEach(b => b.onclick = () => show('pick'));

// ---------- the room ----------
async function enter() {
  leaveRoom();
  lastTick = Date.now(); peers = {}; stats = { shared: 0, peak: 0, harmonies: 0, whispers: 0, met: new Set() };
  $('#art').src = track.art; $('#title').textContent = track.title; $('#artist').textContent = track.artist;
  show('room');
  room = joinRoom({ appId: APP_ID }, await roomKey(track.title, track.artist));
  const [sHello, gHello] = room.makeAction('hello');
  const [sTap, gTap] = room.makeAction('tap');
  const [sSay, gSay] = room.makeAction('say');
  send = { hello: sHello, tap: sTap, say: sSay };
  gHello((d, id) => {
    const isNew = !peers[id];
    peers[id] = { startedAt: d.startedAt, hue: d.hue, seen: Date.now() };
    if (isNew && inSync(id)) toast('someone just arrived at the same second');
  });
  room.onPeerJoin(() => hello());
  room.onPeerLeave(id => delete peers[id]);
  gTap((d, id) => { if (inSync(id)) onTap(peers[id].hue, id); });
  gSay((d, id) => { if (inSync(id) && typeof d.text === 'string') floatMsg(d.text.slice(0, 60), peers[id].hue); });
}
const hello = () => send.hello?.({ startedAt, hue: myHue });
const inSync = id => peers[id] && Math.abs(peers[id].startedAt - startedAt) < SYNC_WINDOW;
const syncedIds = () => Object.keys(peers).filter(inSync);

function leaveRoom() { room?.leave(); room = null; send = {}; }
$('#leave').onclick = () => { leaveRoom(); show('pick'); };

// taps: everyone in sync sees ripples; taps landing together = harmony
let recentTaps = [];
$('#stage').addEventListener('pointerdown', () => { send.tap?.({}); onTap(myHue, selfId); });
document.addEventListener('keydown', e => { if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT' && room) { e.preventDefault(); send.tap?.({}); onTap(myHue, selfId); } });
function onTap(h, id) {
  const now = performance.now();
  recentTaps = recentTaps.filter(t => now - t.at < HARMONY_WINDOW);
  const others = new Set(recentTaps.map(t => t.id)); others.delete(id);
  recentTaps.push({ at: now, id });
  ripples.push({ h, r: 0, big: others.size > 0 });
  if (others.size > 0 && (id === selfId || others.has(selfId))) {
    stats.harmonies++; toast(`harmony — ${others.size + 1} of you hit the same beat`);
  }
}

$('#say').onsubmit = e => {
  e.preventDefault();
  const text = $('#msg').value.trim(); if (!text || !room) return;
  if (!syncedIds().length) { toast('nobody at your second yet — whispers need company'); return; }
  send.say({ text }); floatMsg(text, myHue); stats.whispers++; $('#msg').value = '';
};
function floatMsg(text, h) {
  const d = document.createElement('div');
  d.className = 'float'; d.textContent = text;
  d.style.left = 8 + Math.random() * 45 + 'vw'; d.style.borderColor = `hsl(${h} 90% 65%)`;
  $('#floaters').append(d); setTimeout(() => d.remove(), 9000);
}
let toastT;
function toast(t) { $('#toast').textContent = t; $('#toast').classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => $('#toast').classList.remove('on'), 2600); }

// ---------- the ring: song progress, everyone's position on it ----------
function drawRing() {
  const p = Math.min(1, pos() / track.duration), R = 120, C = 2 * Math.PI * R;
  const dot = (st, h, me, synced) => {
    const a = ((Date.now() - st) / track.duration) * 2 * Math.PI - Math.PI / 2;
    return `<circle cx="${150 + R * Math.cos(a)}" cy="${150 + R * Math.sin(a)}" r="${me ? 9 : 7}" fill="hsl(${h} 90% 65%)" opacity="${synced ? 1 : .3}"${me ? ' stroke="#fff" stroke-width="2"' : ''}/>`;
  };
  $('#ring').innerHTML =
    `<circle cx="150" cy="150" r="${R}" fill="none" stroke="#2c2640" stroke-width="4"/>` +
    `<circle cx="150" cy="150" r="${R}" fill="none" stroke="url(#g)" stroke-width="4" stroke-linecap="round" stroke-dasharray="${C * p} ${C}" transform="rotate(-90 150 150)"/>` +
    `<defs><linearGradient id="g"><stop offset="0" stop-color="#ff4fa3"/><stop offset="1" stop-color="#5ef2d6"/></linearGradient></defs>` +
    Object.entries(peers).map(([id, q]) => dot(q.startedAt, q.hue, false, inSync(id))).join('') +
    dot(startedAt, myHue, true, true);
}

let lastTick = Date.now(), lastHello = 0;
function tick() {
  if (!room || !track) return;
  const now = Date.now(), dt = now - lastTick; lastTick = now;
  for (const id in peers) if (now - peers[id].seen > 9000) delete peers[id];
  if (now - lastHello > 2500) { hello(); lastHello = now; }
  const synced = syncedIds(), drifted = Object.keys(peers).length - synced.length;
  if (synced.length) { stats.shared += dt; synced.forEach(id => stats.met.add(id)); }
  stats.peak = Math.max(stats.peak, synced.length);
  $('#count').textContent = synced.length ? `${synced.length + 1} of you, right now` : 'just you… for now';
  $('#hint').textContent = drifted ? `${drifted} more hearing it at a different moment` : 'tap anywhere to the beat';
  $('#clock').textContent = `${fmt(pos())} / ${fmt(track.duration)}`;
  drawRing();
  if (pos() >= track.duration) finish();
}
setInterval(tick, 250);

function finish() {
  leaveRoom();
  const s = Math.round(stats.shared / 1000);
  $('#card').innerHTML = stats.met.size
    ? `<b>${stats.met.size} stranger${stats.met.size > 1 ? 's' : ''}</b>heard it with you, at the same second<br>
       <b>${s}s</b>of the song shared<br><b>${stats.harmonies}</b>beats hit together<br><small>None of you will ever know who the others were.</small>`
    : `<b>Just you this time.</b>Every song is a room. Most are empty until they aren't.`;
  show('end');
}
$('#again').onclick = () => { spKey = null; show('pick'); if (spotifyToken()) pollSpotify(); };

// ---------- background: stars that ripple when anyone taps ----------
const cv = $('#sky'), cx = cv.getContext('2d');
let ripples = [], stars = [];
function resize() { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; stars = Array.from({ length: 140 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() })); }
addEventListener('resize', resize); resize();
(function frame() {
  const W = cv.width, H = cv.height;
  cx.fillStyle = 'rgba(7,6,13,.35)'; cx.fillRect(0, 0, W, H);
  const pulse = ripples.length ? 1 : 0;
  for (const s of stars) { s.y -= .0002 * (s.z + .2); if (s.y < 0) s.y = 1; cx.fillStyle = `rgba(243,239,250,${.2 + s.z * .5 + pulse * .2})`; cx.fillRect(s.x * W, s.y * H, 1.5 * devicePixelRatio, 1.5 * devicePixelRatio); }
  for (const r of ripples) {
    r.r += (r.big ? 14 : 8) * devicePixelRatio;
    cx.strokeStyle = `hsla(${r.h} 90% 65% / ${Math.max(0, 1 - r.r / (W * .6))})`; cx.lineWidth = (r.big ? 6 : 2) * devicePixelRatio;
    cx.beginPath(); cx.arc(W / 2, H * .45, r.r, 0, 7); cx.stroke();
  }
  ripples = ripples.filter(r => r.r < W * .6);
  requestAnimationFrame(frame);
})();

// ---------- Spotify: auto-detects the song + exact position, follows you track to track ----------
const redirect = location.origin + location.pathname;
const spotifyToken = () => { const t = JSON.parse(localStorage.getItem('sp') || 'null'); return t && t.exp > Date.now() ? t.token : null; };
$('#spotifyBtn').onclick = async () => {
  if (!SPOTIFY_CLIENT_ID) { alert('Spotify needs a Client ID in app.js (free at developer.spotify.com). Until then, search your song below — it matches Spotify listeners too.'); return; }
  const verifier = [...crypto.getRandomValues(new Uint8Array(48))].map(b => b.toString(36)).join('').slice(0, 64);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  sessionStorage.setItem('pkce', verifier);
  location.href = `https://accounts.spotify.com/authorize?${new URLSearchParams({ client_id: SPOTIFY_CLIENT_ID, response_type: 'code', redirect_uri: redirect, scope: 'user-read-currently-playing', code_challenge_method: 'S256', code_challenge: challenge })}`;
};
async function spotifyCallback() {
  const code = new URLSearchParams(location.search).get('code'); if (!code) return;
  history.replaceState(null, '', redirect);
  const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: SPOTIFY_CLIENT_ID, grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: sessionStorage.getItem('pkce') }) }).then(r => r.json());
  if (r.access_token) localStorage.setItem('sp', JSON.stringify({ token: r.access_token, exp: Date.now() + r.expires_in * 1000 }));
}
let spKey = null;
async function pollSpotify() {
  const tok = spotifyToken(); if (!tok) return;
  const r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status !== 200) return;
  const d = await r.json(); if (!d.item || !d.is_playing) return;
  const t = { title: d.item.name, artist: d.item.artists.map(a => a.name).join(', '), art: d.item.album.images[0]?.url, duration: d.item.duration_ms };
  startedAt = Date.now() - d.progress_ms;  // re-anchor every poll: seeks and pauses just work
  if (d.item.id !== spKey) { spKey = d.item.id; track = t; enter(); }
}
spotifyCallback().then(() => { if (spotifyToken()) { $('#spotifyBtn').textContent = 'Spotify connected — press play'; pollSpotify(); setInterval(pollSpotify, 4000); } });
