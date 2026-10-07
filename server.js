const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ========== PERSISTENT STORAGE ==========
const DATA_FILE = path.join(__dirname, 'players.json');
let playersDB = {};

function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      playersDB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    playersDB = {};
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(playersDB, null, 2));
  } catch (e) {
    console.error('Save failed', e.message);
  }
}

loadDB();

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw) + 'lagos-salt-2026').digest('hex');
}

// ========== GAME DATA ==========
const PLACES = [
  { id: 'home',   name: 'Your Room',       emoji: '🏠', x: 10, y: 72, desc: 'Rest, cook, shower' },
  { id: 'market', name: 'Balogun Market',  emoji: '🛒', x: 38, y: 22, desc: 'Buy food, hang out' },
  { id: 'office', name: 'Victoria Island', emoji: '🏢', x: 74, y: 18, desc: 'Work & career' },
  { id: 'amala',  name: 'Amala Spot',      emoji: '🍲', x: 22, y: 48, desc: 'Chop amala' },
  { id: 'beach',  name: 'Elegushi Beach',  emoji: '🏖️', x: 82, y: 58, desc: 'Party & chill' },
  { id: 'church', name: 'Church',          emoji: '⛪', x: 52, y: 78, desc: 'Pray & reflect' },
  { id: 'club',   name: 'Quilox',          emoji: '🎉', x: 68, y: 42, desc: 'Night life' },
  { id: 'garage', name: 'Okada Stand',     emoji: '🛵', x: 16, y: 16, desc: 'Quick cash gigs' },
  { id: 'tech',   name: 'CcHub',           emoji: '💻', x: 55, y: 30, desc: 'Tech vibes & hangout' },
  { id: 'park',   name: 'Freedom Park',    emoji: '🌳', x: 45, y: 60, desc: 'Relax outdoors' },
];

const JOBS = [
  { id: 'none',    name: 'Unemployed',       pay: 0,     level: 0 },
  { id: 'okada',   name: 'Okada Rider',      pay: 4500,  level: 1 },
  { id: 'sales',   name: 'Shop Attendant',   pay: 7000,  level: 2 },
  { id: 'office',  name: 'Office Assistant', pay: 12000, level: 3 },
  { id: 'manager', name: 'Team Lead',        pay: 22000, level: 4 },
  { id: 'exec',    name: 'Manager',          pay: 38000, level: 5 },
];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const online = new Map(); // socket.id → player

let gameDay = 1;
let gameHour = 8;
let gameMinute = 0;

// ========== HELPERS ==========
function getPublicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    money: p.money,
    job: p.job,
    location: p.location,
    needs: p.needs,
    emoji: p.emoji || '🙂',
    status: p.status || null   // temporary emote/status
  };
}

function broadcastCity() {
  const list = Array.from(online.values()).map(getPublicPlayer);
  io.emit('city_update', {
    players: list,
    day: gameDay,
    hour: gameHour,
    minute: gameMinute,
    dayName: DAYS[(gameDay - 1) % 7]
  });
}

function createNewPlayer(name, password) {
  return {
    name,
    passwordHash: hashPassword(password),
    money: 15000,
    job: JOBS[0],
    location: 'home',
    needs: { hunger: 75, energy: 80, fun: 55, social: 45, hygiene: 65 },
    rentDue: 7,
    rentAmount: 8000,
    emoji: ['😎','🥰','😤','🥳','😌','🤔','🤩','🫡','😈','😇'][Math.floor(Math.random()*10)],
    status: null,
    lastSeen: Date.now()
  };
}

// ========== SOCKET ==========
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Check if username already exists (for login UI)
  socket.on('check_name', (name) => {
    const key = (name || '').trim().toLowerCase();
    const exists = !!(key && playersDB[key]);
    socket.emit('name_status', { exists, name: (name || '').trim() });
  });

  socket.on('join', (data) => {
    const name = (data.name || '').trim().slice(0, 16);
    const password = String(data.password || '');

    if (!name || name.length < 2) {
      return socket.emit('error_msg', 'Name must be at least 2 characters');
    }
    if (password.length < 3) {
      return socket.emit('error_msg', 'Password must be at least 3 characters');
    }

    const key = name.toLowerCase();
    let player = playersDB[key];

    if (player) {
      // Existing account → check password
      if (player.passwordHash !== hashPassword(password)) {
        return socket.emit('error_msg', 'Wrong password for this name');
      }
    } else {
      // New account
      player = createNewPlayer(name, password);
      playersDB[key] = player;
      saveDB();
    }

    // Attach to socket
    player.id = socket.id;
    player.name = name;
    player.lastSeen = Date.now();
    player.status = null;
    online.set(socket.id, player);

    socket.emit('joined', {
      you: getPublicPlayer(player),
      places: PLACES,
      jobs: JOBS,
      isNew: !playersDB[key].lastSeen || (Date.now() - (playersDB[key].lastSeen || 0) > 1000 * 60 * 60 * 24 * 30)
    });

    broadcastCity();
    io.emit('chat', { system: true, text: `${name} entered Lagos` });
  });

  socket.on('travel', (placeId) => {
    const p = online.get(socket.id);
    if (!p) return;
    if (p.money < 200) return socket.emit('error_msg', 'Not enough ₦ for transport (₦200)');

    const place = PLACES.find(pl => pl.id === placeId);
    if (!place) return;

    p.money -= 200;
    p.location = placeId;
    p.status = null;
    p.lastSeen = Date.now();
    playersDB[p.name.toLowerCase()] = strip(p);
    saveDB();

    socket.emit('action_result', {
      money: p.money,
      location: p.location,
      msg: `Arrived at ${place.name}`
    });
    broadcastCity();
  });

  socket.on('do_action', (actionId) => {
    const p = online.get(socket.id);
    if (!p) return;

    const result = processAction(p, actionId);
    if (result.error) {
      return socket.emit('error_msg', result.error);
    }

    playersDB[p.name.toLowerCase()] = strip(p);
    saveDB();

    socket.emit('action_result', result);
    broadcastCity();

    if (result.chat) {
      io.emit('chat', { name: p.name, text: result.chat });
    }
  });

  // Send money to another player (must be at same location)
  socket.on('send_money', ({ toName, amount }) => {
    const p = online.get(socket.id);
    if (!p) return;

    amount = Math.floor(Number(amount));
    if (!amount || amount < 100) return socket.emit('error_msg', 'Minimum tip is ₦100');
    if (p.money < amount) return socket.emit('error_msg', 'Not enough ₦');

    // Find target online at same location
    let target = null;
    for (const other of online.values()) {
      if (other.name.toLowerCase() === String(toName).toLowerCase() && other.location === p.location) {
        target = other;
        break;
      }
    }
    if (!target) return socket.emit('error_msg', 'Player not here or offline');

    p.money -= amount;
    target.money += amount;

    playersDB[p.name.toLowerCase()] = strip(p);
    playersDB[target.name.toLowerCase()] = strip(target);
    saveDB();

    socket.emit('action_result', { money: p.money, msg: `You sent ₦${amount.toLocaleString()} to ${target.name}` });
    io.to(target.id).emit('action_result', { money: target.money, msg: `${p.name} sent you ₦${amount.toLocaleString()}!` });
    io.emit('chat', { system: true, text: `${p.name} tipped ${target.name} ₦${amount.toLocaleString()}` });
    broadcastCity();
  });

  // Temporary status / emote
  socket.on('emote', (emoji) => {
    const p = online.get(socket.id);
    if (!p) return;
    const allowed = ['👋','😂','🔥','💯','🙌','😎','🥳','❤️','💪','🙏'];
    if (!allowed.includes(emoji)) return;
    p.status = emoji;
    broadcastCity();
    // Clear after 8 seconds
    setTimeout(() => {
      if (online.get(socket.id) === p) {
        p.status = null;
        broadcastCity();
      }
    }, 8000);
  });

  socket.on('chat', (text) => {
    const p = online.get(socket.id);
    if (!p || !text) return;
    const clean = String(text).slice(0, 140).trim();
    if (clean) io.emit('chat', { name: p.name, text: clean });
  });

  socket.on('disconnect', () => {
    const p = online.get(socket.id);
    if (p) {
      playersDB[p.name.toLowerCase()] = strip(p);
      saveDB();
      online.delete(socket.id);
      io.emit('chat', { system: true, text: `${p.name} left Lagos` });
      broadcastCity();
    }
  });
});

function strip(p) {
  const { id, status, ...rest } = p;
  return { ...rest, lastSeen: Date.now() };
}

// ========== ACTIONS ==========
function processAction(p, actionId) {
  const actions = {
    sleep:      { cost: 0,    effects: { energy: 70, hunger: -12, hygiene: -8 },  msg: 'You slept well.' },
    cook:       { cost: 800,  effects: { hunger: 50, energy: -5 },               msg: 'Home food hits different.' },
    shower:     { cost: 0,    effects: { hygiene: 65 },                          msg: 'Fresh and clean.' },
    rest:       { cost: 0,    effects: { energy: 22, fun: 8 },                   msg: 'Short rest helped.' },
    shop_food:  { cost: 2500, effects: { hunger: 12 },                           msg: 'Bought some food.' },
    eat_out:    { cost: 1500, effects: { hunger: 55, fun: 18, energy: -5 },      msg: 'Amala + ewedu. Blessed.' },
    work:       { cost: 0,    effects: { energy: -35, fun: -18, social: -8, hygiene: -12 }, pay: true, msg: 'Shift completed.' },
    apply_job:  { cost: 0,    effects: { energy: -10 }, special: 'job',          msg: 'You asked around for work.' },
    hangout:    { cost: 400,  effects: { social: 40, fun: 28, energy: -10 },     msg: 'Good vibes.', chat: 'is hanging out' },
    party:      { cost: 4500, effects: { fun: 65, social: 35, energy: -40, hygiene: -22, hunger: -12 }, msg: 'Night was wild.', chat: 'is partying' },
    pray:       { cost: 0,    effects: { fun: 18, energy: 12, social: 10 },      msg: 'Peace of mind.' },
    gig_okada:  { cost: 0,    effects: { energy: -28, hygiene: -15, fun: -5 },   pay: 'okada', msg: 'Okada runs done.' },
    code:       { cost: 0,    effects: { energy: -20, fun: 15, social: 10 },     msg: 'Coded a bit at the hub.' },
    walk:       { cost: 0,    effects: { energy: -8, fun: 15, hygiene: -5 },     msg: 'Nice walk in the park.' },
  };

  const a = actions[actionId];
  if (!a) return { error: 'Unknown action' };

  const placeActions = {
    home:   ['sleep', 'cook', 'shower', 'rest'],
    market: ['shop_food', 'hangout'],
    office: ['work', 'apply_job'],
    amala:  ['eat_out', 'hangout'],
    beach:  ['party', 'hangout', 'rest'],
    church: ['pray', 'hangout'],
    club:   ['party', 'hangout'],
    garage: ['gig_okada', 'hangout'],
    tech:   ['code', 'hangout', 'rest'],
    park:   ['walk', 'hangout', 'rest'],
  };

  const allowed = placeActions[p.location] || [];
  if (!allowed.includes(actionId)) return { error: "You can't do that here" };

  if (actionId === 'work' && p.job.id === 'none') {
    return { error: 'Get a job first (Apply for work)' };
  }

  if (a.cost > 0 && p.money < a.cost) return { error: 'Not enough ₦' };

  p.money -= (a.cost || 0);

  if (a.effects) {
    for (const [k, v] of Object.entries(a.effects)) {
      if (p.needs[k] !== undefined) {
        p.needs[k] = Math.max(0, Math.min(100, p.needs[k] + v));
      }
    }
  }

  let earned = 0;
  if (a.pay === true) {
    earned = p.job.pay;
    p.money += earned;
  } else if (a.pay === 'okada') {
    earned = 2000 + Math.floor(Math.random() * 2800);
    p.money += earned;
  }

  let jobMsg = '';
  if (a.special === 'job') {
    const idx = JOBS.findIndex(j => j.id === p.job.id);
    if (idx < JOBS.length - 1 && Math.random() < 0.42) {
      p.job = JOBS[idx + 1];
      jobMsg = ` 🎉 Promoted to ${p.job.name}!`;
    } else {
      jobMsg = ' No openings right now.';
    }
  }

  return {
    money: p.money,
    needs: p.needs,
    job: p.job,
    location: p.location,
    msg: a.msg + (earned ? ` (+₦${earned.toLocaleString()})` : '') + jobMsg,
    chat: a.chat || null
  };
}

// ========== CLOCK + DECAY ==========
setInterval(() => {
  gameMinute += 10;
  if (gameMinute >= 60) {
    gameMinute = 0;
    gameHour++;
    if (gameHour >= 24) {
      gameHour = 0;
      gameDay++;
    }
  }

  for (const p of online.values()) {
    p.needs.hunger  = Math.max(0, p.needs.hunger  - 0.65);
    p.needs.energy  = Math.max(0, p.needs.energy  - 0.42);
    p.needs.fun     = Math.max(0, p.needs.fun     - 0.32);
    p.needs.social  = Math.max(0, p.needs.social  - 0.22);
    p.needs.hygiene = Math.max(0, p.needs.hygiene - 0.28);
  }
  broadcastCity();
}, 2500);

// Rent tick
setInterval(() => {
  for (const p of online.values()) {
    p.rentDue = (p.rentDue || 7) - 1;
    if (p.rentDue <= 0) {
      if (p.money >= p.rentAmount) {
        p.money -= p.rentAmount;
        p.rentDue = 7;
        io.to(p.id).emit('action_result', {
          money: p.money,
          msg: `🏠 Rent paid ₦${p.rentAmount.toLocaleString()}`
        });
      } else {
        p.money = Math.max(0, p.money - Math.floor(p.rentAmount * 0.6));
        p.rentDue = 7;
        io.to(p.id).emit('error_msg', 'Struggled with rent this week...');
      }
      playersDB[p.name.toLowerCase()] = strip(p);
      saveDB();
    }
  }
}, 1000 * 60 * 4); // every ~4 real minutes

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Lagos Mini Online running on port ${PORT}`);
});
