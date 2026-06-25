const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
webpush.setVapidDetails('mailto:test@example.com', VAPID_PUBLIC, VAPID_PRIVATE);

const users = {};      // { username: { password, displayName, bio, avatarUrl } }
const messages = {};   // { chatKey: [...] }
const subscriptions = {};
let msgCounter = 0;

function chatKey(a, b) { return [a, b].sort().join(':'); }

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  // Static files
  const staticMap = { '/': 'index.html', '/sw.js': 'sw.js', '/icon.png': 'icon.png' };
  if (req.method === 'GET' && staticMap[url.pathname]) {
    const mimes = { '.html':'text/html', '.js':'application/javascript', '.png':'image/png' };
    const file = staticMap[url.pathname];
    const ext = path.extname(file) || '.html';
    serveFile(res, file, mimes[ext] || 'text/plain'); return;
  }

  // VAPID
  if (req.method === 'GET' && url.pathname === '/vapid-public-key') {
    json(res, { key: VAPID_PUBLIC }); return;
  }

  // User search
  if (req.method === 'GET' && url.pathname === '/search') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const results = Object.keys(users)
      .filter(u => u.toLowerCase().includes(q) || users[u].displayName.toLowerCase().includes(q))
      .map(u => ({ username: u, displayName: users[u].displayName, avatarUrl: users[u].avatarUrl || null }));
    json(res, results); return;
  }

  // Get user profile
  if (req.method === 'GET' && url.pathname.startsWith('/profile/')) {
    const username = url.pathname.slice(9);
    if (!users[username]) { res.writeHead(404); res.end('Not found'); return; }
    const { password, ...pub } = users[username];
    json(res, pub); return;
  }

  // File upload (avatar, image, video, file)
  if (req.method === 'POST' && url.pathname === '/upload') {
    readBody(req, (buf) => {
      const boundary = req.headers['content-type'].split('boundary=')[1];
      const parts = parseParts(buf, boundary);
      if (!parts.file) { res.writeHead(400); res.end('no file'); return; }
      const ext = path.extname(parts.filename || '').toLowerCase();
      const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), parts.file);
      const fileUrl = `/file/${filename}`;
      // If avatar update
      if (parts.type === 'avatar' && parts.username && users[parts.username]) {
        users[parts.username].avatarUrl = fileUrl;
        broadcastUsers();
      }
      json(res, { url: fileUrl, name: parts.filename, ext });
    }); return;
  }

  // Update profile
  if (req.method === 'POST' && url.pathname === '/profile') {
    readBody(req, (buf) => {
      try {
        const data = JSON.parse(buf.toString());
        const { username, password, displayName, bio } = data;
        if (!users[username] || users[username].password !== password) { res.writeHead(403); res.end('Forbidden'); return; }
        if (displayName) users[username].displayName = displayName;
        if (bio !== undefined) users[username].bio = bio;
        broadcastUsers();
        json(res, { ok: true });
      } catch { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }

  // Serve uploaded files
  if (req.method === 'GET' && url.pathname.startsWith('/file/')) {
    const filename = url.pathname.slice(6);
    const filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filename).toLowerCase();
    const mimes = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/mp4','.pdf':'application/pdf' };
    const mime = mimes[ext] || 'application/octet-stream';
    
    // Range support for video
    const stat = fs.statSync(filePath);
    const rangeHeader = req.headers['range'];
    if (rangeHeader && mime.startsWith('video')) {
      const [startStr, endStr] = rangeHeader.replace('bytes=','').split('-');
      const start = parseInt(startStr);
      const end = endStr ? parseInt(endStr) : stat.size - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges':'bytes', 'Content-Length': end-start+1, 'Content-Type': mime });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Accept-Ranges':'bytes' });
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

function readBody(req, cb) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => cb(Buffer.concat(chunks)));
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filename, mime) {
  const filePath = path.join(__dirname, filename);
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': mime });
  res.end(fs.readFileSync(filePath));
}

function parseParts(buf, boundary) {
  const result = {};
  const bnd = Buffer.from('--' + boundary);
  let pos = 0;
  while (pos < buf.length) {
    const start = bufIndexOf(buf, bnd, pos);
    if (start === -1) break;
    pos = start + bnd.length + 2;
    const headerEnd = bufIndexOf(buf, Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) break;
    const headers = buf.slice(pos, headerEnd).toString();
    pos = headerEnd + 4;
    const nextBnd = bufIndexOf(buf, bnd, pos);
    const dataEnd = nextBnd === -1 ? buf.length : nextBnd - 2;
    const data = buf.slice(pos, dataEnd);
    pos = nextBnd;
    const nameMatch = headers.match(/name="([^"]+)"/);
    const fnMatch = headers.match(/filename="([^"]+)"/);
    if (nameMatch) {
      if (fnMatch) { result.file = data; result.filename = fnMatch[1]; }
      else result[nameMatch[1]] = data.toString();
    }
  }
  return result;
}

function bufIndexOf(buf, search, start = 0) {
  for (let i = start; i <= buf.length - search.length; i++) {
    let found = true;
    for (let j = 0; j < search.length; j++) { if (buf[i+j] !== search[j]) { found = false; break; } }
    if (found) return i;
  }
  return -1;
}

// WebSocket
const wss = new WebSocketServer({ server });
const clients = new Map();

wss.on('connection', (ws) => {
  let myName = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'register': {
        const { username, password, displayName } = msg;
        if (!username || !password) return send(ws, { type: 'error', text: 'Заполни все поля' });
        if (!/^[a-zA-Z0-9_]+$/.test(username)) return send(ws, { type: 'error', text: 'Юзернейм: только буквы, цифры и _' });
        if (users[username]) return send(ws, { type: 'error', text: 'Юзернейм занят' });
        users[username] = { password, displayName: displayName || username, bio: '', avatarUrl: null };
        myName = username;
        clients.set(username, ws);
        send(ws, { type: 'auth_ok', username, displayName: users[username].displayName, avatarUrl: null });
        broadcastUsers();
        break;
      }
      case 'login': {
        const { username, password } = msg;
        if (!users[username] || users[username].password !== password) return send(ws, { type: 'error', text: 'Неверные данные' });
        myName = username;
        clients.set(username, ws);
        send(ws, { type: 'auth_ok', username, displayName: users[username].displayName, avatarUrl: users[username].avatarUrl || null });
        broadcastUsers();
        break;
      }
      case 'get_history': {
        const key = chatKey(myName, msg.with);
        send(ws, { type: 'history', with: msg.with, messages: messages[key] || [] });
        markRead(myName, msg.with);
        break;
      }
      case 'message': {
        if (!myName) return;
        const { to, text, fileUrl, fileName, fileType, isVideo } = msg;
        const key = chatKey(myName, to);
        if (!messages[key]) messages[key] = [];
        const entry = { id: ++msgCounter, from: myName, text: text||'', fileUrl: fileUrl||null, fileName: fileName||null, fileType: fileType||null, isVideo: isVideo||false, time: msg.time || now(), status: 'sent' };
        messages[key].push(entry);
        if (messages[key].length > 500) messages[key].shift();
        send(ws, { type: 'message', with: to, ...entry });
        const toWs = clients.get(to);
        if (toWs && toWs.readyState === 1) {
          send(toWs, { type: 'message', with: myName, ...entry });
          entry.status = 'delivered';
          send(ws, { type: 'status', id: entry.id, with: to, status: 'delivered' });
        }
        sendPush(to, myName, text || (isVideo ? '🎥 Видео' : `📎 ${fileName}`));
        break;
      }
      case 'read': { if (myName) markRead(myName, msg.with); break; }
      case 'subscribe': { if (myName) subscriptions[myName] = msg.subscription; break; }
    }
  });

  ws.on('close', () => { if (myName) { clients.delete(myName); broadcastUsers(); myName = null; } });
});

function markRead(reader, other) {
  const key = chatKey(reader, other);
  const msgs = messages[key];
  if (!msgs) return;
  const ids = [];
  msgs.forEach(m => { if (m.from === other && m.status !== 'read') { m.status = 'read'; ids.push(m.id); } });
  if (!ids.length) return;
  const otherWs = clients.get(other);
  if (otherWs && otherWs.readyState === 1) send(otherWs, { type: 'read', with: reader, ids });
}

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function broadcastUsers() {
  const online = [...clients.keys()];
  const allUsers = Object.keys(users).map(u => ({
    username: u, displayName: users[u].displayName, online: online.includes(u), avatarUrl: users[u].avatarUrl || null
  }));
  const payload = JSON.stringify({ type: 'users', users: allUsers });
  for (const [, ws] of clients) { if (ws.readyState === 1) ws.send(payload); }
}

async function sendPush(to, from, text) {
  const sub = subscriptions[to];
  if (!sub) return;
  const fromDisplay = users[from]?.displayName || from;
  try { await webpush.sendNotification(sub, JSON.stringify({ title: `Егерь — ${fromDisplay}`, body: text })); }
  catch (e) { if (e.statusCode === 410) delete subscriptions[to]; }
}

function now() {
  const d = new Date();
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

server.listen(process.env.PORT || 3000, () => console.log('✅ Сервер запущен'));
