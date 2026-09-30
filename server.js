#!/usr/bin/env node
/*
 * VH UNO — LAN multiplayer server
 * Zero dependencies. Run:  node server.js   (optional: node server.js 4000)
 * Players on the same Wi-Fi/LAN open http://<this-computer-ip>:<port>
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || process.argv[2] || '3000', 10);
const FAST = process.env.VH_FAST === '1'; // test mode: bots act instantly
const PUBLIC_DIR = path.join(__dirname, 'public');
const HARD_MAX_PLAYERS = 20;
const DISCONNECT_AUTOPLAY_MS = 10000;
const LOBBY_DROP_MS = 45000;
const ROOM_IDLE_MS = 30 * 60 * 1000;

// ------------------------------------------------------------------ utils
const rid = (n = 6) => crypto.randomBytes(n).toString('hex');
const rand = (n) => Math.floor(Math.random() * n);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      const fam = typeof i.family === 'string' ? i.family : (i.family === 4 ? 'IPv4' : 'IPv6');
      if (fam === 'IPv4' && !i.internal) out.push({ name, address: i.address });
    }
  }
  // Prefer typical home/office ranges first
  const score = (a) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : a.startsWith('172.') ? 2 : 3);
  out.sort((a, b) => score(a.address) - score(b.address));
  return out;
}

// ------------------------------------------------------------------ cards
const COLORS = ['red', 'yellow', 'green', 'blue'];
const COLOR_NAME = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue' };
const VALUE_NAME = { skip: 'Skip', reverse: 'Reverse', draw2: 'Draw Two', wild: 'Wild', wild4: 'Wild Draw Four' };

function buildDeck(decks) {
  const cards = [];
  let id = 0;
  for (let d = 0; d < decks; d++) {
    for (const color of COLORS) {
      cards.push({ id: id++, color, value: '0' });
      for (let v = 1; v <= 9; v++) for (let k = 0; k < 2; k++) cards.push({ id: id++, color, value: String(v) });
      for (const v of ['skip', 'reverse', 'draw2']) for (let k = 0; k < 2; k++) cards.push({ id: id++, color, value: v });
    }
    for (let k = 0; k < 4; k++) {
      cards.push({ id: id++, color: 'wild', value: 'wild' });
      cards.push({ id: id++, color: 'wild', value: 'wild4' });
    }
  }
  return shuffle(cards);
}
const isNumber = (c) => /^[0-9]$/.test(c.value);
const cardPoints = (c) => (isNumber(c) ? +c.value : c.color === 'wild' ? 50 : 20);
function cardName(c) {
  if (c.color === 'wild') return VALUE_NAME[c.value];
  return `${COLOR_NAME[c.color]} ${VALUE_NAME[c.value] || c.value}`;
}

// ------------------------------------------------------------------ rooms
const rooms = new Map();
const BOT_NAMES = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Isha', 'Vihaan', 'Anaya', 'Arjun', 'Zara',
  'Dev', 'Kiara', 'Neel', 'Tara', 'Om', 'Riya', 'Yash', 'Sara', 'Ved', 'Myra', 'Ishaan', 'Nia'];
const REACTIONS = ['😂', '🔥', '😱', '👏', '😡', '🎉', '🙏', '😎', '🤡', '💀', '🍆', '🍌', '🥒', '🍑🍑🍑🍑', ' 💦 💦'];

function defaultSettings() {
  return {
    maxPlayers: HARD_MAX_PLAYERS,
    finishMode: 'all', // 'all' = keep playing until everyone has finished (ranked) | 'first' = official, first out wins
    rounds: 0, // finishMode 'all': rounds in the session, 0 = until the host ends it
    targetScore: 500, // finishMode 'first': 0 = single round
    handSize: 7,
    decks: 'auto', // 'auto' | 1 | 2 | 3
    turnTimer: 0, // seconds, 0 = off
    wild4: 'challenge', // 'challenge' | 'strict' | 'free'
    stacking: false,
    drawToMatch: false,
    sevenZero: false,
    jumpIn: false,
  };
}

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[rand(A.length)]).join(''); } while (rooms.has(c));
  return c;
}

function createRoom() {
  const room = {
    code: newCode(), hostId: null, players: [], settings: defaultSettings(),
    status: 'lobby', game: null, round: 0, dealer: -1,
    chat: [], log: [], events: [], eventSeq: 0,
    conns: new Set(), timer: null, turnToken: 0, bcPending: false,
    createdAt: Date.now(), lastActive: Date.now(), hueSeq: rand(12),
  };
  rooms.set(room.code, room);
  return room;
}

function cleanName(s, fallback) {
  s = String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || fallback;
}
function uniqueName(room, name) {
  const taken = new Set(room.players.map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) { const n = `${name.slice(0, 13)} ${i}`; if (!taken.has(n.toLowerCase())) return n; }
}

function addPlayer(room, name, isBot = false) {
  const p = {
    id: rid(4), token: isBot ? null : rid(16), name: uniqueName(room, name), isBot,
    hand: [], score: 0, firsts: 0, rounds: 0, placeSum: 0, lastPlace: 0, unoCalled: false, spectator: room.status !== 'lobby',
    hue: (room.hueSeq++ * 47) % 360, disconnectedAt: isBot ? null : Date.now(), joinedAt: Date.now(),
  };
  room.players.push(p);
  return p;
}
const getP = (room, id) => room.players.find((p) => p.id === id);
const activeCount = (room) => room.players.filter((p) => !p.spectator).length;
function isConnected(room, pid) {
  for (const c of room.conns) if (c.pid === pid) return true;
  return false;
}

function pushLog(room, text) {
  room.log.push({ t: Date.now(), text });
  if (room.log.length > 80) room.log.splice(0, room.log.length - 80);
}
function emit(room, ev) {
  ev.seq = ++room.eventSeq;
  ev.t = Date.now();
  room.events.push(ev);
  if (room.events.length > 30) room.events.splice(0, room.events.length - 30);
}

// ------------------------------------------------------------------ game helpers
const curId = (g) => g.order[g.turn];
function idxAfter(g, from, steps) {
  const n = g.order.length;
  return (((from + g.direction * steps) % n) + n) % n;
}
const topCard = (g) => g.discard[g.discard.length - 1];

function reshuffle(room) {
  const g = room.game;
  if (g.discard.length <= 1) return;
  const top = g.discard.pop();
  g.drawPile = shuffle(g.discard.concat(g.drawPile));
  g.discard = [top];
  pushLog(room, 'Discard pile reshuffled into the draw pile.');
  emit(room, { type: 'shuffle' });
}

function drawCards(room, p, n) {
  const g = room.game;
  const got = [];
  for (let i = 0; i < n; i++) {
    if (!g.drawPile.length) reshuffle(room);
    if (!g.drawPile.length) break;
    const c = g.drawPile.pop();
    p.hand.push(c);
    got.push(c);
  }
  if (p.hand.length > 1) p.unoCalled = false;
  g.unoVulnerable = g.unoVulnerable.filter((id) => id !== p.id);
  if (got.length) emit(room, { type: 'draw', pid: p.id, n: got.length });
  return got;
}

function isPlayable(room, p, c) {
  const g = room.game;
  if (!g || room.status !== 'playing' || g.phase !== 'play') return false;
  if (g.drawnCardId !== null && c.id !== g.drawnCardId) return false;
  if (g.pendingDraw > 0) {
    if (g.pendingType === 'draw2') return c.value === 'draw2' || c.value === 'wild4';
    return c.value === 'wild4';
  }
  if (c.value === 'wild') return true;
  if (c.value === 'wild4') {
    if (room.settings.wild4 === 'strict') return !p.hand.some((h) => h.id !== c.id && h.color === g.currentColor);
    return true;
  }
  const t = topCard(g);
  return c.color === g.currentColor || c.value === t.value;
}

function canJumpIn(room, p, c) {
  const g = room.game;
  if (!room.settings.jumpIn || !g || room.status !== 'playing' || g.phase !== 'play') return false;
  if (g.pendingDraw > 0 || c.color === 'wild' || curId(g) === p.id || !g.order.includes(p.id)) return false;
  const t = topCard(g);
  return t.color === c.color && t.value === c.value;
}

function bestColor(hand) {
  const cnt = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of hand) if (c.color !== 'wild') cnt[c.color] += 1 + (isNumber(c) ? 0 : 0.5);
  let best = COLORS[rand(4)], bv = 0;
  for (const k of COLORS) if (cnt[k] > bv) { bv = cnt[k]; best = k; }
  return best;
}

const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
function resetStats(p) { p.score = 0; p.firsts = 0; p.rounds = 0; p.placeSum = 0; p.lastPlace = 0; }
// Session standings for 'all' mode: most points, then most wins, then best average place, then latest place
function standings(room) {
  const avg = (p) => (p.rounds ? p.placeSum / p.rounds : 99);
  return room.players.filter((p) => p.rounds > 0)
    .sort((a, b) => b.score - a.score || b.firsts - a.firsts || avg(a) - avg(b) || a.lastPlace - b.lastPlace)
    .map((p) => p.id);
}

// ------------------------------------------------------------------ game flow
function decksFor(room, n) {
  const s = room.settings;
  let d = s.decks === 'auto' ? (n > 10 ? 2 : 1) : +s.decks;
  while (d < 3 && n * s.handSize > d * 108 - 30) d++;
  return d;
}

function startGame(room) {
  for (const p of room.players) { resetStats(p); p.spectator = false; }
  // Respect max players: extra people wait as spectators
  room.players.forEach((p, i) => { if (i >= room.settings.maxPlayers) p.spectator = true; });
  room.round = 0;
  room.dealer = -1;
  const st = room.settings;
  if (st.finishMode === 'all') {
    pushLog(room, `New session started. Rounds keep going until everyone has finished${st.rounds ? `, ${st.rounds} round${st.rounds > 1 ? 's' : ''} in total` : ''}.`);
  } else {
    pushLog(room, `New game started. First to ${st.targetScore || 'win one round'}${st.targetScore ? ' points' : ''} wins.`);
  }
  startRound(room);
}

function startRound(room) {
  const s = room.settings;
  let slots = s.maxPlayers - activeCount(room);
  for (const p of room.players) if (p.spectator && slots > 0) { p.spectator = false; slots--; }
  const players = room.players.filter((p) => !p.spectator);
  if (players.length < 2) fail('Need at least 2 players.');
  for (const p of room.players) { p.hand = []; p.unoCalled = false; }
  room.round++;
  const n = players.length;
  const decks = decksFor(room, n);
  const g = room.game = {
    order: players.map((p) => p.id), dealt: players.map((p) => p.id), finished: [], direction: 1, turn: 0,
    drawPile: buildDeck(decks), discard: [], currentColor: null,
    pendingDraw: 0, pendingType: null, phase: 'play', drawnCardId: null,
    wd4: null, unoVulnerable: [], deadline: null, turnSeq: 0, decks, roundResult: null,
  };
  room.dealer = (room.dealer + 1) % n;
  for (let i = 0; i < s.handSize; i++) for (const p of players) p.hand.push(g.drawPile.pop());

  let top = g.drawPile.pop();
  while (top.value === 'wild4') {
    g.drawPile.splice(rand(g.drawPile.length), 0, top);
    top = g.drawPile.pop();
  }
  g.discard.push(top);
  const dealer = getP(room, g.order[room.dealer]);
  const first = idxAfter(g, room.dealer, 1);
  g.turn = first;
  room.status = 'playing';
  pushLog(room, `Round ${room.round}: ${dealer.name} deals ${s.handSize} cards each${decks > 1 ? ` from ${decks} decks` : ''}. First card: ${cardName(top)}.`);
  emit(room, { type: 'deal', round: room.round });

  if (top.color === 'wild') {
    g.phase = 'chooseColor';
  } else {
    g.currentColor = top.color;
    const fp = getP(room, g.order[first]);
    if (top.value === 'skip') {
      pushLog(room, `${fp.name} is skipped by the first card.`);
      emit(room, { type: 'skip', pid: fp.id });
      g.turn = idxAfter(g, first, 1);
    } else if (top.value === 'reverse') {
      g.direction = -1;
      g.turn = room.dealer;
      pushLog(room, `First card is a Reverse — ${dealer.name} (dealer) goes first and play runs the other way.`);
      emit(room, { type: 'reverse', dir: -1 });
    } else if (top.value === 'draw2') {
      drawCards(room, fp, 2);
      pushLog(room, `${fp.name} draws 2 from the first card and is skipped.`);
      g.turn = idxAfter(g, first, 1);
    }
  }
  beginTurn(room);
}

function beginTurn(room) {
  const g = room.game;
  g.drawnCardId = null;
  g.turnSeq++;
  g.deadline = room.settings.turnTimer ? Date.now() + room.settings.turnTimer * 1000 : null;
}

function requireTurn(room, p) {
  if (room.status !== 'playing') fail('The round is not running.');
  if (!room.game.order.includes(p.id)) fail('You are watching this round.');
  if (curId(room.game) !== p.id) fail("It's not your turn.");
}

function playCard(room, p, cardId, color, targetId) {
  const g = room.game;
  if (room.status !== 'playing' || !g) fail('The round is not running.');
  if (g.phase !== 'play') fail('Finish the current choice first.');
  const idx = p.hand.findIndex((c) => c.id === cardId);
  if (idx < 0) fail("That card isn't in your hand.");
  const card = p.hand[idx];
  let jumped = false;
  if (curId(g) !== p.id) {
    if (!canJumpIn(room, p, card)) fail("It's not your turn.");
    jumped = true;
  } else if (!isPlayable(room, p, card)) fail("That card doesn't match.");
  if (card.color === 'wild' && !COLORS.includes(color)) fail('Pick a color for the wild card.');
  const s = room.settings;
  const willHave = p.hand.length - 1;
  let target = null;
  if (s.sevenZero && card.value === '7' && willHave > 0) {
    target = getP(room, targetId);
    if (!target || target.id === p.id || !g.order.includes(target.id)) fail('Pick a player to swap hands with.');
  }

  g.unoVulnerable = [];
  if (jumped) {
    g.turn = g.order.indexOf(p.id);
    g.drawnCardId = null;
    pushLog(room, `${p.name} jumps in!`);
    emit(room, { type: 'jump', pid: p.id });
  }
  const prevColor = g.currentColor;
  p.hand.splice(idx, 1);
  g.discard.push(card);
  g.drawnCardId = null;
  g.currentColor = card.color === 'wild' ? color : card.color;
  emit(room, { type: 'play', pid: p.id, card, color: g.currentColor });

  if (p.hand.length === 1 && !p.unoCalled) g.unoVulnerable.push(p.id);
  if (p.hand.length > 1) p.unoCalled = false;

  const won = p.hand.length === 0;
  const me = g.turn;
  const n = g.order.length;
  const nextP = () => getP(room, g.order[idxAfter(g, me, 1)]);
  let msg = `${p.name} played ${cardName(card)}${card.color === 'wild' ? ` and picked ${COLOR_NAME[color]}` : ''}.`;

  switch (card.value) {
    case 'skip': {
      const v = nextP();
      msg += ` ${v.name} is skipped.`;
      emit(room, { type: 'skip', pid: v.id });
      g.turn = idxAfter(g, me, 2);
      break;
    }
    case 'reverse':
      g.direction *= -1;
      emit(room, { type: 'reverse', dir: g.direction });
      if (n === 2) { g.turn = idxAfter(g, me, 2); msg += ` It works like a Skip with two players.`; }
      else { g.turn = idxAfter(g, me, 1); msg += ' Direction reversed.'; }
      break;
    case 'draw2':
      if (s.stacking) {
        g.pendingDraw += 2; g.pendingType = 'draw2';
        g.turn = idxAfter(g, me, 1);
        if (g.pendingDraw > 2) msg += ` Stack is now +${g.pendingDraw}!`;
      } else {
        const v = nextP();
        drawCards(room, v, 2);
        msg += ` ${v.name} draws 2 and is skipped.`;
        emit(room, { type: 'skip', pid: v.id });
        g.turn = idxAfter(g, me, 2);
      }
      break;
    case 'wild4':
      if (s.stacking) {
        g.pendingDraw += 4; g.pendingType = 'wild4';
        g.turn = idxAfter(g, me, 1);
        if (g.pendingDraw > 4) msg += ` Stack is now +${g.pendingDraw}!`;
      } else if (s.wild4 === 'challenge' && !won) {
        g.wd4 = { by: p.id, prevColor, guilty: p.hand.some((c) => c.color === prevColor) };
        g.turn = idxAfter(g, me, 1);
        g.phase = 'challenge';
        msg += ` ${getP(room, curId(g)).name} can accept it or challenge.`;
      } else {
        const v = nextP();
        drawCards(room, v, 4);
        msg += ` ${v.name} draws 4 and is skipped.`;
        emit(room, { type: 'skip', pid: v.id });
        g.turn = idxAfter(g, me, 2);
      }
      break;
    case '7':
      if (target) {
        const tmp = p.hand; p.hand = target.hand; target.hand = tmp;
        p.unoCalled = false; target.unoCalled = false; g.unoVulnerable = [];
        msg += ` ${p.name} swaps hands with ${target.name}.`;
        emit(room, { type: 'swap', pid: p.id, target: target.id });
      }
      g.turn = idxAfter(g, me, 1);
      break;
    case '0':
      if (s.sevenZero && !won) {
        const hands = g.order.map((id) => getP(room, id).hand);
        g.order.forEach((id, i) => {
          const to = getP(room, g.order[idxAfter(g, i, 1)]);
          to.hand = hands[i];
        });
        for (const id of g.order) getP(room, id).unoCalled = false;
        g.unoVulnerable = [];
        msg += ' Everyone passes their hand along!';
        emit(room, { type: 'rotate', dir: g.direction });
      }
      g.turn = idxAfter(g, me, 1);
      break;
    default:
      g.turn = idxAfter(g, me, 1);
  }
  pushLog(room, msg);

  if (won && s.finishMode === 'all') {
    finishPlayer(room, p);
    if (g.order.length <= 1) { endRoundAll(room); return; }
    beginTurn(room);
    return;
  }
  if (won) {
    if (g.pendingDraw > 0) {
      const v = getP(room, curId(g));
      drawCards(room, v, g.pendingDraw);
      pushLog(room, `${v.name} still draws ${g.pendingDraw}.`);
      g.pendingDraw = 0; g.pendingType = null;
    }
    endRound(room, p);
    return;
  }
  if (g.unoVulnerable.includes(p.id)) scheduleBotCatches(room, p.id);
  beginTurn(room);
}

function drawAction(room, p) {
  requireTurn(room, p);
  const g = room.game;
  if (g.phase !== 'play') fail('Finish the current choice first.');
  if (g.drawnCardId !== null) fail('You already drew — play that card or keep it.');
  g.unoVulnerable = [];
  if (g.pendingDraw > 0) {
    const n = g.pendingDraw;
    const got = drawCards(room, p, n);
    pushLog(room, `${p.name} draws ${got.length} and is skipped.`);
    g.pendingDraw = 0; g.pendingType = null;
    g.turn = idxAfter(g, g.turn, 1);
    beginTurn(room);
    return;
  }
  const drawn = [];
  for (;;) {
    const got = drawCards(room, p, 1);
    if (!got.length) break;
    drawn.push(got[0]);
    if (isPlayable(room, p, got[0]) || !room.settings.drawToMatch || drawn.length >= 60) break;
  }
  const last = drawn[drawn.length - 1];
  const plural = drawn.length === 1 ? 'a card' : `${drawn.length} cards`;
  if (last && isPlayable(room, p, last)) {
    g.drawnCardId = last.id;
    pushLog(room, `${p.name} drew ${plural}.`);
  } else {
    pushLog(room, drawn.length ? `${p.name} drew ${plural} and passed.` : `${p.name} couldn't draw (no cards left) and passed.`);
    g.turn = idxAfter(g, g.turn, 1);
    beginTurn(room);
  }
}

function passAction(room, p) {
  requireTurn(room, p);
  const g = room.game;
  if (g.drawnCardId === null) fail('Draw a card first.');
  g.unoVulnerable = [];
  pushLog(room, `${p.name} kept the card and passed.`);
  g.turn = idxAfter(g, g.turn, 1);
  beginTurn(room);
}

function chooseColorAction(room, p, color) {
  requireTurn(room, p);
  const g = room.game;
  if (g.phase !== 'chooseColor') fail('No color to choose right now.');
  if (!COLORS.includes(color)) fail('Pick red, yellow, green or blue.');
  g.currentColor = color;
  g.phase = 'play';
  pushLog(room, `${p.name} picked ${COLOR_NAME[color]} for the starting Wild.`);
  emit(room, { type: 'color', color });
  beginTurn(room);
}

function challengeAction(room, p, doChallenge) {
  requireTurn(room, p);
  const g = room.game;
  if (g.phase !== 'challenge' || !g.wd4) fail('Nothing to challenge.');
  const w = g.wd4;
  const by = getP(room, w.by);
  g.phase = 'play';
  g.wd4 = null;
  g.unoVulnerable = [];
  if (!doChallenge || !by) {
    drawCards(room, p, 4);
    pushLog(room, `${p.name} accepts the Wild Draw Four, draws 4 and is skipped.`);
    emit(room, { type: 'skip', pid: p.id });
    g.turn = idxAfter(g, g.turn, 1);
  } else if (w.guilty) {
    drawCards(room, by, 4);
    pushLog(room, `${p.name} challenged — and won! ${by.name} had a ${COLOR_NAME[w.prevColor]} card and draws 4. ${p.name} plays on.`);
    emit(room, { type: 'challenge', pid: p.id, by: by.id, won: true });
  } else {
    drawCards(room, p, 6);
    pushLog(room, `${p.name} challenged — and lost. ${by.name} played it fair, so ${p.name} draws 6 and is skipped.`);
    emit(room, { type: 'challenge', pid: p.id, by: by.id, won: false });
    g.turn = idxAfter(g, g.turn, 1);
  }
  beginTurn(room);
}

function unoAction(room, p) {
  const g = room.game;
  if (room.status !== 'playing' || !g || !g.order.includes(p.id)) return;
  if (p.hand.length > 2) fail('You can only call UNO with 2 or fewer cards.');
  if (p.unoCalled) return;
  p.unoCalled = true;
  g.unoVulnerable = g.unoVulnerable.filter((id) => id !== p.id);
  pushLog(room, `${p.name} shouts UNO!`);
  emit(room, { type: 'uno', pid: p.id });
}

function catchAction(room, p, targetId) {
  const g = room.game;
  if (room.status !== 'playing' || !g || !(g.order.includes(p.id) || (g.finished || []).includes(p.id))) fail('You are not in this round.');
  const t = getP(room, targetId);
  if (!t || t.id === p.id || !g.unoVulnerable.includes(t.id)) fail('Too late — nobody to catch.');
  g.unoVulnerable = g.unoVulnerable.filter((id) => id !== t.id);
  drawCards(room, t, 2);
  pushLog(room, `${p.name} caught ${t.name} without calling UNO! ${t.name} draws 2.`);
  emit(room, { type: 'catch', pid: p.id, target: t.id });
}

function endRound(room, winner) {
  const g = room.game;
  let pts = 0;
  const hands = {};
  for (const id of g.order) {
    const pl = getP(room, id);
    if (!pl || pl.id === winner.id) continue;
    const sum = pl.hand.reduce((a, c) => a + cardPoints(c), 0);
    pts += sum;
    hands[id] = { cards: pl.hand.slice(), points: sum };
  }
  winner.score += pts;
  g.unoVulnerable = [];
  g.phase = 'over';
  g.deadline = null;
  g.roundResult = { winnerId: winner.id, points: pts, hands, round: room.round };
  const target = room.settings.targetScore;
  const gameOver = !target || winner.score >= target;
  room.status = gameOver ? 'gameOver' : 'roundOver';
  pushLog(room, `${winner.name} wins round ${room.round} and scores ${pts} points!${gameOver ? ` ${winner.name} wins the game!` : ''}`);
  emit(room, { type: 'win', pid: winner.id, points: pts, gameOver });
}

// 'all' mode: a player who empties their hand leaves the turn order and takes the next place
function finishPlayer(room, p) {
  const g = room.game;
  const i = g.order.indexOf(p.id);
  if (i < 0) return;
  g.finished.push(p.id);
  const place = g.finished.length;
  g.order.splice(i, 1);
  if (g.turn > i) g.turn--;
  if (g.order.length) g.turn = ((g.turn % g.order.length) + g.order.length) % g.order.length;
  g.unoVulnerable = g.unoVulnerable.filter((id) => id !== p.id);
  p.unoCalled = false;
  const left = g.order.length;
  pushLog(room, `${p.name} finishes ${ordinal(place)}!${left > 1 ? ` ${left} players still going.` : ''}`);
  emit(room, { type: 'finish', pid: p.id, place });
}

function endRoundAll(room) {
  const g = room.game;
  const rest = g.order.filter((id) => getP(room, id));
  const ids = g.finished.filter((id) => getP(room, id)).concat(rest);
  const n = ids.length;
  const hands = {};
  const ranking = ids.map((id, i) => {
    const pl = getP(room, id);
    const pts = n - 1 - i; // one point for every player you finished ahead of
    pl.score += pts; pl.rounds += 1; pl.placeSum += i + 1; pl.lastPlace = i + 1;
    if (i === 0) pl.firsts += 1;
    if (pl.hand.length) hands[id] = { cards: pl.hand.slice(), points: pl.hand.reduce((a, c) => a + cardPoints(c), 0) };
    return { id, place: i + 1, points: pts };
  });
  g.unoVulnerable = [];
  g.phase = 'over'; g.deadline = null; g.wd4 = null; g.pendingDraw = 0; g.pendingType = null;
  g.order = g.dealt.filter((id) => getP(room, id));
  g.turn = 0;
  const target = room.settings.rounds;
  const gameOver = !!target && room.round >= target;
  const table = standings(room);
  g.roundResult = { mode: 'all', round: room.round, ranking, hands, standings: table, winnerId: ids[0], lastId: ids[n - 1], points: n - 1 };
  room.status = gameOver ? 'gameOver' : 'roundOver';
  const last = getP(room, ids[n - 1]);
  pushLog(room, `${last ? last.name : 'The last player'} finishes last. Round ${room.round} is over.`);
  if (gameOver) { const w = getP(room, table[0]); if (w) pushLog(room, `${w.name} wins the session!`); }
  emit(room, { type: 'roundEnd', winnerId: ids[0], lastId: ids[n - 1], gameOver });
}

function removePlayer(room, pid, reason) {
  const i = room.players.findIndex((p) => p.id === pid);
  if (i < 0) return;
  const p = room.players[i];
  room.players.splice(i, 1);
  for (const c of [...room.conns]) if (c.pid === pid) { try { c.res.end(); } catch (e) { /* ignore */ } room.conns.delete(c); }
  pushLog(room, `${p.name} ${reason || 'left the room'}.`);
  const g = room.game;
  if (g && g.dealt) {
    g.dealt = g.dealt.filter((id) => id !== pid);
    g.finished = g.finished.filter((id) => id !== pid);
  }
  if (g && g.order.includes(pid)) {
    const idx = g.order.indexOf(pid);
    const wasTurn = idx === g.turn;
    if (room.status === 'playing') g.drawPile.unshift(...shuffle(p.hand.slice()));
    g.order.splice(idx, 1);
    g.unoVulnerable = g.unoVulnerable.filter((id) => id !== pid);
    if (g.order.length === 1 && room.status === 'playing' && room.settings.finishMode === 'all' && g.finished.length) {
      endRoundAll(room);
    } else if (g.order.length < 2) {
      room.status = 'lobby';
      room.game = null;
      pushLog(room, 'Not enough players left — back to the lobby.');
    } else if (room.status === 'playing') {
      if (g.wd4 && g.wd4.by === pid) { g.wd4 = null; if (g.phase === 'challenge') g.phase = 'play'; }
      if (idx < g.turn) g.turn--;
      else if (wasTurn) {
        const n = g.order.length;
        g.turn = g.direction === 1 ? idx % n : (idx - 1 + n) % n;
        if (g.phase === 'challenge') { g.phase = 'play'; g.wd4 = null; }
        beginTurn(room);
      }
      g.turn = ((g.turn % g.order.length) + g.order.length) % g.order.length;
    }
  }
  if (room.hostId === pid) {
    const h = room.players.find((x) => !x.isBot && isConnected(room, x.id)) || room.players.find((x) => !x.isBot);
    room.hostId = h ? h.id : null;
    if (h) pushLog(room, `${h.name} is now the host.`);
  }
  if (!room.players.some((x) => !x.isBot)) destroyRoom(room);
}

function destroyRoom(room) {
  clearTimeout(room.timer);
  for (const c of room.conns) { try { c.res.end(); } catch (e) { /* ignore */ } }
  room.conns.clear();
  room.dead = true;
  rooms.delete(room.code);
}

// ------------------------------------------------------------------ bots & auto-play
function botPickCard(room, p, playable) {
  const g = room.game;
  const next = getP(room, g.order[idxAfter(g, g.turn, 1)]);
  const danger = next && next.hand.length <= 2;
  const honest = playable.filter((c) => c.value !== 'wild4' || !p.hand.some((h) => h.color === g.currentColor) || g.pendingDraw > 0);
  const pool = honest.length ? honest : playable;
  const score = (c) => {
    let s = 0;
    if (c.color === 'wild') s -= 40; // save wilds
    if (c.value === 'wild4') s -= 10;
    if (danger && ['draw2', 'skip', 'reverse', 'wild4'].includes(c.value)) s += 80;
    if (c.color === g.currentColor) s += 5;
    s += cardPoints(c) * 0.3;
    s += Math.random() * 6;
    return s;
  };
  return pool.slice().sort((a, b) => score(b) - score(a))[0];
}

function botAct(room, p) {
  const g = room.game;
  if (!g || room.status !== 'playing' || curId(g) !== p.id) return;
  if (g.phase === 'challenge') {
    const by = getP(room, g.wd4 && g.wd4.by);
    const odds = by && by.hand.length <= 2 ? 0.45 : 0.25;
    return challengeAction(room, p, Math.random() < odds);
  }
  if (g.phase === 'chooseColor') return chooseColorAction(room, p, bestColor(p.hand));
  const playable = p.hand.filter((c) => isPlayable(room, p, c));
  if (g.drawnCardId !== null) {
    const c = playable.find((x) => x.id === g.drawnCardId);
    if (c && Math.random() < 0.92) return botPlay(room, p, c);
    return passAction(room, p);
  }
  if (!playable.length) return drawAction(room, p);
  return botPlay(room, p, botPickCard(room, p, playable));
}

function botPlay(room, p, c) {
  const g = room.game;
  if (p.hand.length === 2 && !p.unoCalled && (p.isBot ? Math.random() < 0.88 : true)) unoAction(room, p);
  const rest = p.hand.filter((h) => h.id !== c.id);
  const color = c.color === 'wild' ? bestColor(rest) : undefined;
  let target;
  if (room.settings.sevenZero && c.value === '7') {
    const others = g.order.filter((id) => id !== p.id).map((id) => getP(room, id));
    others.sort((a, b) => a.hand.length - b.hand.length);
    target = others[0] && others[0].id;
  }
  playCard(room, p, c.id, color, target);
}

// Timeout: simple, predictable auto-move for a player who ran out of time
function timeoutAct(room, p) {
  const g = room.game;
  if (!g || room.status !== 'playing' || curId(g) !== p.id) return;
  pushLog(room, `${p.name} ran out of time.`);
  if (g.phase === 'challenge') return challengeAction(room, p, false);
  if (g.phase === 'chooseColor') return chooseColorAction(room, p, bestColor(p.hand));
  if (g.drawnCardId !== null) return passAction(room, p);
  drawAction(room, p);
  if (room.status === 'playing' && curId(g) === p.id && g.drawnCardId !== null) passAction(room, p);
}

function scheduleBotCatches(room, targetId) {
  const g = room.game;
  const catchers = g.order.map((id) => getP(room, id)).filter((b) => b && b.isBot && b.id !== targetId);
  for (const b of catchers) {
    if (Math.random() > 0.3) continue;
    const delay = FAST ? 1 : 1400 + Math.random() * 2600;
    setTimeout(() => {
      if (room.dead || room.status !== 'playing' || !room.game || !room.game.unoVulnerable.includes(targetId)) return;
      if (!getP(room, b.id)) return;
      try { catchAction(room, b, targetId); broadcast(room); } catch (e) { /* someone else caught first */ }
    }, delay);
  }
}

function schedule(room) {
  clearTimeout(room.timer);
  room.timer = null;
  const token = ++room.turnToken;
  if (room.dead || room.status !== 'playing' || !room.game) return;
  const g = room.game;
  const actor = getP(room, curId(g));
  if (!actor) return;
  let delay, fn;
  if (actor.isBot) {
    delay = FAST ? 0 : (g.phase === 'challenge' ? 1500 : 850) + Math.random() * 900;
    fn = () => botAct(room, actor);
  } else {
    const now = Date.now();
    const opts = [];
    if (g.deadline) opts.push({ at: g.deadline, fn: () => timeoutAct(room, actor) });
    if (!isConnected(room, actor.id)) {
      const since = actor.disconnectedAt || now;
      opts.push({ at: since + (FAST ? 0 : DISCONNECT_AUTOPLAY_MS), fn: () => { if (!isConnected(room, actor.id)) botAct(room, actor); } });
    }
    if (!opts.length) return;
    opts.sort((a, b) => a.at - b.at);
    delay = Math.max(0, opts[0].at - now);
    fn = opts[0].fn;
  }
  room.timer = setTimeout(() => {
    if (room.dead || token !== room.turnToken) return;
    try { fn(); } catch (e) { if (!(e instanceof GameError)) console.error('[auto-play]', e); }
    changed(room);
  }, delay);
}

// ------------------------------------------------------------------ views & broadcast
function view(room, viewerId) {
  const g = room.game;
  const me = getP(room, viewerId);
  const players = room.players.map((p) => ({
    id: p.id, name: p.name, isBot: p.isBot, hue: p.hue,
    connected: p.isBot || isConnected(room, p.id), score: p.score,
    firsts: p.firsts, rounds: p.rounds, avgPlace: p.rounds ? Math.round((p.placeSum / p.rounds) * 10) / 10 : null,
    place: g && g.finished ? g.finished.indexOf(p.id) + 1 || null : null,
    cards: p.hand.length, uno: p.unoCalled && p.hand.length <= 2, spectator: p.spectator,
    vulnerable: !!(g && g.unoVulnerable.includes(p.id)),
  }));
  let game = null;
  if (g) {
    const inRound = me && g.order.includes(me.id);
    game = {
      order: g.order, seats: g.dealt || g.order, finished: g.finished || [], turnId: curId(g), direction: g.direction, top: topCard(g),
      recent: g.discard.slice(-5), discardCount: g.discard.length, drawCount: g.drawPile.length,
      color: g.currentColor, pendingDraw: g.pendingDraw, pendingType: g.pendingType,
      phase: g.phase, deadline: g.deadline, turnSeq: g.turnSeq, decks: g.decks,
      dealerId: (g.dealt || g.order)[room.dealer] || null,
      myPlace: me && g.finished ? g.finished.indexOf(me.id) + 1 || null : null,
      wd4: g.wd4 ? { by: g.wd4.by, prevColor: g.wd4.prevColor } : null,
      result: g.roundResult, inRound: !!inRound,
    };
    if (inRound) {
      game.hand = me.hand;
      game.playable = room.status === 'playing'
        ? me.hand.filter((c) => (curId(g) === me.id ? isPlayable(room, me, c) : canJumpIn(room, me, c))).map((c) => c.id)
        : [];
      game.drawnCardId = curId(g) === me.id ? g.drawnCardId : null;
    }
  }
  return {
    me: me ? { id: me.id, name: me.name } : null,
    room: { code: room.code, hostId: room.hostId, status: room.status, settings: room.settings, round: room.round },
    players, game,
    log: room.log.slice(-40), chat: room.chat.slice(-60), events: room.events.slice(-20),
    serverNow: Date.now(),
  };
}

function broadcast(room) {
  if (room.bcPending || room.dead) return;
  room.bcPending = true;
  setImmediate(() => {
    room.bcPending = false;
    for (const c of room.conns) {
      try { c.res.write(`data: ${JSON.stringify(view(room, c.pid))}\n\n`); } catch (e) { /* closed */ }
    }
  });
}

function changed(room) {
  room.lastActive = Date.now();
  broadcast(room);
  schedule(room);
}

// ------------------------------------------------------------------ actions
function applySettings(room, input) {
  const s = room.settings;
  const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
  if (input.maxPlayers !== undefined) s.maxPlayers = Math.max(2, Math.min(HARD_MAX_PLAYERS, parseInt(input.maxPlayers, 10) || HARD_MAX_PLAYERS));
  if (input.finishMode !== undefined) s.finishMode = pick(input.finishMode, ['all', 'first'], s.finishMode);
  if (input.rounds !== undefined) s.rounds = pick(+input.rounds, [0, 1, 3, 5, 10], s.rounds);
  if (input.targetScore !== undefined) s.targetScore = pick(+input.targetScore, [0, 100, 200, 300, 500, 1000], s.targetScore);
  if (input.handSize !== undefined) s.handSize = pick(+input.handSize, [5, 7, 10], s.handSize);
  if (input.decks !== undefined) s.decks = input.decks === 'auto' ? 'auto' : pick(+input.decks, [1, 2, 3], s.decks);
  if (input.turnTimer !== undefined) s.turnTimer = pick(+input.turnTimer, [0, 15, 30, 45, 60], s.turnTimer);
  if (input.wild4 !== undefined) s.wild4 = pick(input.wild4, ['challenge', 'strict', 'free'], s.wild4);
  for (const k of ['stacking', 'drawToMatch', 'sevenZero', 'jumpIn']) if (input[k] !== undefined) s[k] = !!input[k];
}

function handleAction(room, p, a) {
  const isHost = room.hostId === p.id;
  const host = () => { if (!isHost) fail('Only the host can do that.'); };
  let reschedule = true;
  switch (a.type) {
    case 'settings': host(); if (room.status !== 'lobby') fail('Change settings in the lobby.'); applySettings(room, a.settings || {}); break;
    case 'addBot': {
      host();
      if (room.status !== 'lobby') fail('Add bots in the lobby.');
      if (activeCount(room) >= room.settings.maxPlayers) fail('The room is full.');
      const used = new Set(room.players.map((x) => x.name));
      const name = BOT_NAMES.find((x) => !used.has(x)) || 'Bot';
      const b = addPlayer(room, name, true);
      pushLog(room, `${b.name} (bot) joined.`);
      break;
    }
    case 'kick': {
      host();
      const t = getP(room, a.target);
      if (!t || t.id === p.id) fail('Pick someone else.');
      removePlayer(room, t.id, t.isBot ? 'was removed' : 'was removed by the host');
      break;
    }
    case 'makeHost': {
      host();
      const t = getP(room, a.target);
      if (!t || t.isBot) fail('Pick a person, not a bot.');
      room.hostId = t.id;
      pushLog(room, `${t.name} is now the host.`);
      break;
    }
    case 'leave': removePlayer(room, p.id, 'left the room'); break;
    case 'start': {
      host();
      if (room.status !== 'lobby') fail('A game is already running.');
      if (room.players.length < 2) fail('You need at least 2 players — add a bot or share the link.');
      startGame(room);
      break;
    }
    case 'nextRound': host(); if (room.status !== 'roundOver') fail('The round is still running.'); startRound(room); break;
    case 'endSession': {
      host();
      if (room.status !== 'roundOver' || !room.game || !room.game.roundResult) fail('Finish the round first.');
      room.status = 'gameOver';
      room.game.roundResult.sessionEnded = true;
      room.game.roundResult.standings = standings(room);
      const w = getP(room, room.game.roundResult.standings[0]);
      pushLog(room, `The host ended the session.${w ? ` ${w.name} wins!` : ''}`);
      emit(room, { type: 'roundEnd', gameOver: true });
      break;
    }
    case 'toLobby': {
      host();
      if (room.status === 'playing') fail('Finish or end the round first.');
      room.status = 'lobby'; room.game = null;
      for (const x of room.players) { x.hand = []; x.spectator = false; x.unoCalled = false; }
      pushLog(room, 'Back in the lobby.');
      break;
    }
    case 'endGame': {
      host();
      if (room.status === 'lobby') fail('No game is running.');
      room.status = 'lobby'; room.game = null;
      for (const x of room.players) { x.hand = []; x.spectator = false; x.unoCalled = false; }
      pushLog(room, 'The host ended the game.');
      break;
    }
    case 'play': playCard(room, p, a.cardId, a.color, a.target); break;
    case 'draw': drawAction(room, p); break;
    case 'pass': passAction(room, p); break;
    case 'chooseColor': chooseColorAction(room, p, a.color); break;
    case 'challenge': challengeAction(room, p, !!a.challenge); break;
    case 'uno': unoAction(room, p); reschedule = false; break;
    case 'catch': catchAction(room, p, a.target); reschedule = false; break;
    case 'chat': {
      const text = String(a.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
      if (!text) return;
      room.chat.push({ t: Date.now(), pid: p.id, name: p.name, hue: p.hue, text });
      if (room.chat.length > 100) room.chat.splice(0, room.chat.length - 100);
      reschedule = false;
      break;
    }
    case 'react':
      if (!REACTIONS.includes(a.emoji)) fail('Unknown reaction.');
      emit(room, { type: 'react', pid: p.id, emoji: a.emoji });
      reschedule = false;
      break;
    default: fail('Unknown action.');
  }
  if (room.dead) return;
  if (reschedule) changed(room); else { room.lastActive = Date.now(); broadcast(room); }
}

// ------------------------------------------------------------------ http
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 20000) { reject(new GameError('Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new GameError('Bad request.')); } });
    req.on('error', reject);
  });
}

function findRoom(code) { return rooms.get(String(code || '').toUpperCase().trim()); }
function byToken(room, token) { return token ? room.players.find((p) => p.token === token) : null; }

async function api(req, res, route) {
  const body = await readBody(req);
  if (route === 'create') {
    const room = createRoom();
    const p = addPlayer(room, cleanName(body.name, 'Host'));
    room.hostId = p.id;
    pushLog(room, `${p.name} created the room.`);
    console.log(`[room ${room.code}] created by ${p.name}`);
    return sendJSON(res, 200, { code: room.code, token: p.token, id: p.id });
  }
  if (route === 'join') {
    const room = findRoom(body.code);
    if (!room) return sendJSON(res, 404, { error: 'Room not found. Check the code, or ask the host to share the link again.' });
    const existing = byToken(room, body.token);
    if (existing) return sendJSON(res, 200, { code: room.code, token: existing.token, id: existing.id, rejoined: true });
    if (body.token && !body.name) return sendJSON(res, 404, { error: 'Your seat in this room is gone.' });
    if (room.players.length >= 40) return sendJSON(res, 400, { error: 'This room is full.' });
    if (room.status === 'lobby' && activeCount(room) >= room.settings.maxPlayers) return sendJSON(res, 400, { error: `This room is full (${room.settings.maxPlayers} players).` });
    const p = addPlayer(room, cleanName(body.name, 'Player'));
    pushLog(room, p.spectator ? `${p.name} joined and will be dealt in next round.` : `${p.name} joined.`);
    console.log(`[room ${room.code}] ${p.name} joined`);
    changed(room);
    return sendJSON(res, 200, { code: room.code, token: p.token, id: p.id });
  }
  if (route === 'action') {
    const room = findRoom(body.code);
    if (!room) return sendJSON(res, 404, { error: 'This room has closed.' });
    const p = byToken(room, body.token);
    if (!p) return sendJSON(res, 404, { error: 'You are no longer in this room.' });
    handleAction(room, p, body);
    return sendJSON(res, 200, { ok: true });
  }
  return sendJSON(res, 404, { error: 'Not found.' });
}

function sse(req, res, url) {
  const room = findRoom(url.searchParams.get('code'));
  const p = room && byToken(room, url.searchParams.get('token'));
  if (!room || !p) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('gone'); }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  const conn = { pid: p.id, res };
  const wasConnected = isConnected(room, p.id);
  room.conns.add(conn);
  p.disconnectedAt = null;
  res.write(`data: ${JSON.stringify(view(room, p.id))}\n\n`);
  if (!wasConnected) changed(room);
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.on('close', () => {
    room.conns.delete(conn);
    if (!isConnected(room, p.id) && getP(room, p.id)) {
      p.disconnectedAt = Date.now();
      if (!room.dead) changed(room);
    }
  });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // unknown paths fall back to the app (so /?room=ABCD style links always load)
      if (path.extname(file)) { res.writeHead(404); return res.end('Not found'); }
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(500); return res.end('index.html missing'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }); res.end(d2);
      });
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': (ext === '.woff2' || ext === '.jpg') ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(data);
  });
}

function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/events') return sse(req, res, url);
  if (req.method === 'GET' && url.pathname === '/api/info') {
    return sendJSON(res, 200, { port: PORT, ips: lanIPs().map((i) => i.address), host: os.hostname() });
  }
  if (req.method === 'GET' && url.pathname === '/api/rooms') {
    const list = [...rooms.values()].filter((r) => r.players.some((p) => !p.isBot && isConnected(r, p.id))).map((r) => {
      const h = getP(r, r.hostId);
      return { code: r.code, host: h ? h.name : '—', players: activeCount(r), max: r.settings.maxPlayers, status: r.status };
    });
    return sendJSON(res, 200, { rooms: list });
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    return api(req, res, url.pathname.slice(5)).catch((e) => {
      if (e instanceof GameError) return sendJSON(res, 400, { error: e.message });
      console.error(e);
      return sendJSON(res, 500, { error: 'Server error — check the host computer\'s console.' });
    });
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
  res.writeHead(405); res.end();
}

// ------------------------------------------------------------------ housekeeping
function sweep() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    for (const c of room.conns) { try { c.res.write(': ping\n\n'); } catch (e) { /* ignore */ } }
    if (room.status === 'lobby') {
      for (const p of [...room.players]) {
        if (!p.isBot && !isConnected(room, p.id) && p.disconnectedAt && now - p.disconnectedAt > LOBBY_DROP_MS) {
          removePlayer(room, p.id, 'disconnected');
          if (!room.dead) changed(room);
        }
      }
    }
    const anyone = room.players.some((p) => !p.isBot && isConnected(room, p.id));
    if (!room.dead && !anyone && now - room.lastActive > ROOM_IDLE_MS) destroyRoom(room);
  }
}

// ------------------------------------------------------------------ boot
if (require.main === module) {
  setInterval(sweep, 15000);
  const server = http.createServer(handler);
  server.keepAliveTimeout = 65000;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is busy. Try:  node server.js ${PORT + 1}\n`);
    else console.error(e);
    process.exit(1);
  });
  server.listen(PORT, '0.0.0.0', () => {
    const ips = lanIPs();
    const line = '─'.repeat(52);
    console.log(`\n  ${line}\n   VH UNO server is running\n  ${line}`);
    console.log(`   On this computer:   http://localhost:${PORT}`);
    if (ips.length) {
      console.log('   Share on your LAN:');
      for (const i of ips) console.log(`     http://${i.address}:${PORT}    (${i.name})`);
    } else console.log('   No LAN address found — connect this computer to Wi-Fi/LAN.');
    console.log(`  ${line}\n   Keep this window open while you play. Ctrl+C to stop.\n`);
  });
}

module.exports = {
  rooms, createRoom, addPlayer, handleAction, startGame, startRound, isPlayable, canJumpIn, view, getP, standings, finishPlayer,
  botAct, schedule, removePlayer, applySettings, cardPoints, buildDeck, GameError,
};
