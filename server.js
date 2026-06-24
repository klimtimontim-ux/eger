const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;

webpush.setVapidDetails('mailto:test@example.com', VAPID_PUBLIC, VAPID_PRIVATE);

// { username: { password, displayName } }
const users = {};
// { 'user1:user2': [ {id, from, text, time, status} ] }
const messages = {};
const subscriptions = {};

let msgCounter = 0;
function chatKey(a, b) { return [a, b].sort().join(':'); }

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') { serveFile(res, 'index.html', 'text/html'); return; }
  if (req.method === 'GET' && req.url === '/sw.js') { serveFile(res, 'sw.js', 'application/javascript'); return; }
  if (req.method === 'GET' && req.url === '/vapid-public-key') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: VAPID_PUBLIC })); return;
  }
  // Загрузка файлов
  if (req.method === 'POST' && req.url === '/upload') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      // Читаем multipart вручную
      const boundary = req.headers['content-type'].split('boundary=')[1];
      const parts = parseParts(buf, boundary);
      if (!parts.file) { res.writeHead(400); res.end('no file'); return; }
      const filename = `${Date.now()}_${parts.filename || 'file'}`;
      const uploadDir = path.join(__dirname, 'uploads');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
      fs.writeFileSync(path.join(uploadDir, filename), parts.file);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: `/file/${filename}`, name: parts.filename }));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/file/')) {
    const filename = req.url.slice(6);
    const filePath = path.join(__dirname, 'uploads', filename);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200);
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  res.writeHead(404); res.end('Not found');
});

function parseParts(buf, boundary) {
  const result = {};
  const bnd = Buffer.from('--' + boundary);
  let pos = 0;
  while (pos < buf.length) {
    const start = indexOf(buf, bnd, pos);
    if (start === -1) break;
    pos = start + bnd.length + 2;
    const headerEnd = indexOf(buf, Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) break;
    const headers = buf.slice(pos, headerEnd).toString();
    pos = headerEnd + 4;
    const nextBnd = indexOf(buf, bnd, pos);
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

function indexOf(buf, search, start = 0) {
  for (let i = start; i <= buf.length - search.length; i++) {
    let found = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i+j] !== search[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

function serveFile(res, filename, mime) {
  const filePath = path.join(__dirname, filename);
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': mime });
  res.end(fs.readFileSync(filePath));
}

const wss = new WebSocketServer({ server });
const clients = new Map(); // username → ws

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
        users[username] = { password, displayName: displayName || username };
        myName = username;
        clients.set(username, ws);
        send(ws, { type: 'auth_ok', username, displayName: users[username].displayName });
        broadcastUsers();
        break;
      }

      case 'login': {
        const { username, password } = msg;
        if (!users[username] || users[username].password !== password) return send(ws, { type: 'error', text: 'Неверные данные' });
        myName = username;
        clients.set(username, ws);
        send(ws, { type: 'auth_ok', username, displayName: users[username].displayName });
        broadcastUsers();
        break;
      }

      case 'get_history': {
        const { with: other } = msg;
        const key = chatKey(myName, other);
        send(ws, { type: 'history', with: other, messages: messages[key] || [] });
        // Помечаем прочитанными
        markRead(myName, other);
        break;
      }

      case 'message': {
        if (!myName) return;
        const { to, text, fileUrl, fileName, fileType } = msg;
        const key = chatKey(myName, to);
        if (!messages[key]) messages[key] = [];
        const entry = {
          id: ++msgCounter,
          from: myName,
          text: text || '',
          fileUrl: fileUrl || null,
          fileName: fileName || null,
          fileType: fileType || null,
          time: now(),
          status: 'sent'
        };
        messages[key].push(entry);
        if (messages[key].length > 500) messages[key].shift();

        // Отправителю
        send(ws, { type: 'message', with: to, ...entry });

        // Получателю
        const toWs = clients.get(to);
        if (toWs && toWs.readyState === 1) {
          send(toWs, { type: 'message', with: myName, ...entry });
          // Доставлено
          entry.status = 'delivered';
          send(ws, { type: 'status', id: entry.id, with: to, status: 'delivered' });
        }

        sendPush(to, myName, text || `📎 ${fileName}`);
        break;
      }

      case 'read': {
        // Пользователь открыл чат и прочитал сообщения
        if (!myName) return;
        markRead(myName, msg.with);
        break;
      }

      case 'subscribe': {
        if (!myName) return;
        subscriptions[myName] = msg.subscription;
        break;
      }
    }
  });

  ws.on('close', () => {
    if (myName) { clients.delete(myName); broadcastUsers(); myName = null; }
  });
});

function markRead(reader, other) {
  const key = chatKey(reader, other);
  const msgs = messages[key];
  if (!msgs) return;
  // Помечаем все сообщения от other как прочитанные
  const ids = [];
  msgs.forEach(m => {
    if (m.from === other && m.status !== 'read') {
      m.status = 'read';
      ids.push(m.id);
    }
  });
  if (ids.length === 0) return;
  // Уведомляем отправителя
  const otherWs = clients.get(other);
  if (otherWs && otherWs.readyState === 1) {
    send(otherWs, { type: 'read', with: reader, ids });
  }
}

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function broadcastUsers() {
  const online = [...clients.keys()];
  const allUsers = Object.keys(users).map(u => ({ username: u, displayName: users[u].displayName, online: online.includes(u) }));
  const payload = JSON.stringify({ type: 'users', users: allUsers });
  for (const [, ws] of clients) { if (ws.readyState === 1) ws.send(payload); }
}

async function sendPush(to, from, text) {
  const sub = subscriptions[to];
  if (!sub) return;
  const fromDisplay = users[from] ? users[from].displayName : from;
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title: `Егерь — ${fromDisplay}`, body: text }));
  } catch (e) {
    if (e.statusCode === 410) delete subscriptions[to];
  }
}

function now() {
  const d = new Date();
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

server.listen(process.env.PORT || 3000, () => console.log('✅ Сервер запущен'));
