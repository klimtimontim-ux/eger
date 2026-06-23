const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');

// ─── VAPID ───────────────────────────────────────────────
// Генерируй один раз: node -e "require('web-push').generateVAPIDKeys().then(k=>console.log(JSON.stringify(k)))"
// Вставь сюда свои ключи:
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
webpush.setVapidDetails('mailto:test@example.com', VAPID_PUBLIC, VAPID_PRIVATE);

// ─── Хранилище ────────────────────────────────────────────
const users = {};         // { username: password }
const messages = [];      // [ { from, text, time } ]
const subscriptions = {}; // { username: pushSubscription }

// ─── HTTP сервер ──────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Отдаём статику
  if (req.method === 'GET' && req.url === '/') {
    serveFile(res, 'index.html', 'text/html');
    return;
  }
  if (req.method === 'GET' && req.url === '/sw.js') {
    serveFile(res, 'sw.js', 'application/javascript');
    return;
  }

  // VAPID public key для клиента
  if (req.method === 'GET' && req.url === '/vapid-public-key') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: VAPID_PUBLIC }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function serveFile(res, filename, mime) {
  const filePath = path.join(__dirname, filename);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('File not found: ' + filename);
    return;
  }
  res.writeHead(200, { 'Content-Type': mime });
  res.end(fs.readFileSync(filePath));
}

// ─── WebSocket ────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const clients = new Map(); // ws → username

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'register': {
        const { username, password } = msg;
        if (!username || !password) return ws.send(j({ type: 'error', text: 'Заполни все поля' }));
        if (users[username]) return ws.send(j({ type: 'error', text: 'Имя занято' }));
        users[username] = password;
        clients.set(ws, username);
        ws.send(j({ type: 'auth_ok', username, messages }));
        break;
      }

      case 'login': {
        const { username, password } = msg;
        if (users[username] !== password) return ws.send(j({ type: 'error', text: 'Неверные данные' }));
        clients.set(ws, username);
        ws.send(j({ type: 'auth_ok', username, messages }));
        break;
      }

      case 'message': {
        const from = clients.get(ws);
        if (!from) return;
        const entry = { from, text: msg.text, time: now() };
        messages.push(entry);
        if (messages.length > 200) messages.shift();
        // Шлём всем подключённым
        broadcast({ type: 'message', ...entry });
        // Push-уведомления всем остальным
        sendPushToAll(from, entry.text);
        break;
      }

      case 'subscribe': {
        const username = clients.get(ws);
        if (!username) return;
        subscriptions[username] = msg.subscription;
        console.log(`[push] ${username} подписался на уведомления`);
        break;
      }
    }
  });

  ws.on('close', () => clients.delete(ws));
});

function broadcast(obj) {
  const data = j(obj);
  for (const [ws] of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

async function sendPushToAll(senderName, text) {
  const payload = JSON.stringify({ title: 'Егерь', body: `${senderName}: ${text}` });
  for (const [username, sub] of Object.entries(subscriptions)) {
    if (username === senderName) continue; // себе не шлём
    try {
      await webpush.sendNotification(sub, payload);
    } catch (e) {
      console.warn(`[push] Ошибка для ${username}:`, e.statusCode);
      if (e.statusCode === 410) delete subscriptions[username]; // подписка истекла
    }
  }
}

function j(obj) { return JSON.stringify(obj); }
function now() {
  const d = new Date();
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

server.listen(3000, () => console.log('✅ Сервер запущен: http://localhost:3000'));
