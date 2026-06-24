const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;

webpush.setVapidDetails('mailto:test@example.com', VAPID_PUBLIC, VAPID_PRIVATE);

// ─── Хранилище ────────────────────────────────────────────
const users = {};         // { username: password }
const messages = {};      // { 'user1:user2': [ {from, text, time} ] }
const subscriptions = {}; // { username: pushSubscription }

function chatKey(a, b) {
  return [a, b].sort().join(':');
}

// ─── HTTP ─────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    serveFile(res, 'index.html', 'text/html'); return;
  }
  if (req.method === 'GET' && req.url === '/sw.js') {
    serveFile(res, 'sw.js', 'application/javascript'); return;
  }
  if (req.method === 'GET' && req.url === '/vapid-public-key') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: VAPID_PUBLIC })); return;
  }
  res.writeHead(404); res.end('Not found');
});

function serveFile(res, filename, mime) {
  const filePath = path.join(__dirname, filename);
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': mime });
  res.end(fs.readFileSync(filePath));
}

// ─── WebSocket ────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const clients = new Map(); // username → ws

wss.on('connection', (ws) => {
  let myName = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'register': {
        const { username, password } = msg;
        if (!username || !password) return send(ws, { type: 'error', text: 'Заполни все поля' });
        if (users[username]) return send(ws, { type: 'error', text: 'Имя занято' });
        users[username] = password;
        myName = username;
        clients.set(username, ws);
        send(ws, { type: 'auth_ok', username });
        broadcastUsers();
        break;
      }

      case 'login': {
        const { username, password } = msg;
        if (users[username] !== password) return send(ws, { type: 'error', text: 'Неверные данные' });
        myName = username;
        clients.set(username, ws);
        send(ws, { type: 'auth_ok', username });
        broadcastUsers();
        break;
      }

      case 'get_history': {
        const { with: other } = msg;
        const key = chatKey(myName, other);
        send(ws, { type: 'history', with: other, messages: messages[key] || [] });
        break;
      }

      case 'message': {
        if (!myName) return;
        const { to, text } = msg;
        const key = chatKey(myName, to);
        if (!messages[key]) messages[key] = [];
        const entry = { from: myName, text, time: now() };
        messages[key].push(entry);
        if (messages[key].length > 500) messages[key].shift();

        send(ws, { type: 'message', with: to, ...entry });

        const toWs = clients.get(to);
        if (toWs && toWs.readyState === 1) {
          send(toWs, { type: 'message', with: myName, ...entry });
        }

        sendPush(to, myName, text);
        break;
      }

      case 'subscribe': {
        if (!myName) return;
        subscriptions[myName] = msg.subscription;
        console.log(`[sub] ${myName} подписался, всего подписок: ${Object.keys(subscriptions).length}`);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (myName) {
      clients.delete(myName);
      broadcastUsers();
      myName = null;
    }
  });
});

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastUsers() {
  const online = [...clients.keys()];
  const allUsers = Object.keys(users);
  const payload = JSON.stringify({ type: 'users', online, all: allUsers });
  for (const [, ws] of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

async function sendPush(to, from, text) {
  const sub = subscriptions[to];
  console.log(`[push] to=${to} sub=${sub ? 'есть' : 'НЕТ'}`);
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify({
      title: `Егерь — ${from}`,
      body: text
    }));
    console.log(`[push] отправлен ${to}`);
  } catch (e) {
    console.log(`[push] ошибка ${to}:`, e.statusCode, e.message);
    if (e.statusCode === 410) delete subscriptions[to];
  }
}

function now() {
  const d = new Date();
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

server.listen(process.env.PORT || 3000, () => console.log('✅ Сервер запущен'));
