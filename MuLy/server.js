const express = require('express');
const fs = require('fs');
const p = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const IRC = require('irc-framework');
const AmuleClient = require('amule-ec-node');
const { EC_OPCODES, EC_TAGS } = require('amule-ec-node/ECDefs');
const NodeID3 = require('node-id3');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/irc-ws' });

app.use(express.json());
app.use(express.static(p.join(__dirname)));
app.use('/web', express.static(p.join(__dirname, '../web')));

const HOST = '127.0.0.1';
const EC_PORT = 4712;
const TM = { global: 1, local: 0, kad: 2 };
let cl = null;

function log(msg, e) {
  const t = new Date().toTimeString().slice(0,8);
  if (e) console.error(`[${t}] ✗ ${msg}`, e.message || e);
  else console.log(`[${t}] ${msg}`);
}
function safe(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch(e) { log('Error', e); if (!res.headersSent) res.status(500).json({ ok: false, error: e.message }); }
  };
}
function nc(res) {
  if (!cl) { res.status(401).json({ error: 'Not connected' }); return true; }
  return false;
}
function gc(tag, id) { return tag.children?.find(c => c.tagId === id)?.humanValue; }

// ── IRC STATE ──
let ircClient = null;
let ircWs = null;
let ircNick = '';
let ircListBuf = [];
let ircListening = false;

function ircSend(type, data) {
  if (ircWs && ircWs.readyState === 1) ircWs.send(JSON.stringify({ type, ...data }));
}

const IRC_AUTO = '#eMule-Spanish';
const IRC_LIST_MAX = 30;

function attachIrcEvents(client) {
  client.on('registered', () => {
    ircNick = client.user.nick;
    ircSend('status', { connected: true, nick: ircNick });
    log('IRC registered as '+ircNick);
    client.join(IRC_AUTO);
    ircListBuf = [];
    ircListening = true;
    client.raw('LIST');
  });
  client.on('message', e => {
    ircSend('message', { target: e.target, nick: e.nick, text: e.message, time: Date.now(), pm: !e.target.startsWith('#') });
  });
  client.on('join', e => ircSend('join', { channel: e.channel, nick: e.nick }));
  client.on('part', e => ircSend('part', { channel: e.channel, nick: e.nick, reason: e.message }));
  client.on('quit', e => ircSend('quit', { nick: e.nick, reason: e.message }));
  client.on('nick', e => ircSend('nick', { oldNick: e.nick, newNick: e.new_nick }));
  client.on('userlist', e => ircSend('userlist', { channel: e.channel, users: e.users.map(u => u.nick) }));
  client.on('topic', e => ircSend('topic', { channel: e.channel, topic: e.topic }));
  client.on('notice', e => ircSend('notice', { nick: e.nick, text: e.message }));
  client.on('raw', e => {
    if (!ircListening) return;
    if (e.command === '322') {
      const ch = e.params[1], users = parseInt(e.params[2])||0, topic = e.params[3]||'';
      if (ch && ircListBuf.length < IRC_LIST_MAX) ircListBuf.push({ name: ch, users, topic });
    }
    if (e.command === '323') {
      ircListening = false;
      ircListBuf.sort((a,b) => b.users - a.users);
      ircSend('list_end', { list: ircListBuf.slice(0, IRC_LIST_MAX) });
      ircListBuf = [];
    }
  });
  client.on('socket close', () => { ircSend('status', { connected: false }); log('IRC disconnected'); });
  client.on('close', () => ircSend('status', { connected: false }));
}

wss.on('connection', ws => {
  ircWs = ws;
  if (ircClient && ircClient.connected) ircSend('status', { connected: true, nick: ircNick });
  ws.on('close', () => { if (ircWs === ws) ircWs = null; });
});

// ── IRC API ──
app.post('/api/irc/connect', safe(async (req, res) => {
  const { host, port = 6667, nick, nick2, password, tls = false } = req.body;
  if (!host || !nick) return res.status(400).json({ error: 'host and nick required' });
  if (ircClient) { try { ircClient.quit(); } catch(_){} ircClient = null; }
  const client = new IRC.Client();
  client.connect({ host, port: parseInt(port), nick, account: nick2 ? { account: nick2 } : undefined, password: password || undefined, tls, rejectUnauthorized: false });
  attachIrcEvents(client);
  ircClient = client;
  log(`IRC connecting to ${host}:${port} as ${nick}`);
  res.json({ ok: true });
}));

app.post('/api/irc/disconnect', safe(async (req, res) => {
  if (ircClient) { try { ircClient.quit('Bye'); } catch(_){} ircClient = null; }
  res.json({ ok: true });
}));

app.post('/api/irc/join', safe(async (req, res) => {
  if (!ircClient) return res.status(400).json({ error: 'Not connected' });
  const { channel, key } = req.body;
  ircClient.join(channel, key || undefined);
  res.json({ ok: true });
}));

app.post('/api/irc/part', safe(async (req, res) => {
  if (!ircClient) return res.status(400).json({ error: 'Not connected' });
  ircClient.part(req.body.channel);
  res.json({ ok: true });
}));

app.post('/api/irc/msg', safe(async (req, res) => {
  if (!ircClient) return res.status(400).json({ error: 'Not connected' });
  const { target, text } = req.body;
  ircClient.say(target, text);
  res.json({ ok: true });
}));

app.post('/api/irc/nick', safe(async (req, res) => {
  if (!ircClient) return res.status(400).json({ error: 'Not connected' });
  ircClient.changeNick(req.body.nick);
  res.json({ ok: true });
}));

app.get('/api/irc/state', (req, res) => {
  res.json({ connected: !!(ircClient && ircClient.connected), nick: ircNick, host: ircClient?.options?.host || '' });
});

// ── AMULE ──
app.get('/', (req, res) => res.sendFile(p.join(__dirname, 'index.html')));

app.post('/api/connect', safe(async (req, res) => {
  if (cl) { try { cl.close(); } catch(_){} cl = null; }
  const c = new AmuleClient(HOST, EC_PORT, req.body.password);
  await c.connect();
  cl = c; log('Connected');
  res.json({ ok: true });
}));

app.get('/api/stats', safe(async (req, res) => {
  if (nc(res)) return;
  const data = await cl.getStats();
  delete data.EC_TAG_STATS_LOGGER_MESSAGE;
  res.json(data);
}));

app.get('/api/connstate', safe(async (req, res) => {
  if (nc(res)) return;
  const resp = await cl.session.sendPacket(EC_OPCODES.EC_OP_GET_CONNSTATE, []);
  const connTag = resp.tags?.find(t => t.tagId === EC_TAGS.EC_TAG_CONNSTATE);
  const srvTag = connTag?.children?.find(c => c.tagId === EC_TAGS.EC_TAG_SERVER);
  let connectedServer = null;
  if (srvTag) {
    const hv = srvTag.humanValue || '';
    const parts = hv.split(':');
    connectedServer = {
      ip: parts[0] || gc(srvTag, EC_TAGS.EC_TAG_SERVER_IP) || '',
      port: parseInt(parts[1]) || gc(srvTag, EC_TAGS.EC_TAG_SERVER_PORT) || 0,
      name: gc(srvTag, EC_TAGS.EC_TAG_SERVER_NAME) || ''
    };
  }
  res.json({ connectedServer });
}));

app.get('/api/servers', safe(async (req, res) => {
  if (nc(res)) return;
  const resp = await cl.session.sendPacket(EC_OPCODES.EC_OP_GET_SERVER_LIST, []);
  const list = (resp.tags || []).map(tag => {
    const hv = tag.humanValue || '';
    const parts = hv.split(':');
    return {
      name: gc(tag, EC_TAGS.EC_TAG_SERVER_NAME) || '—',
      ip: parts[0] || '',
      port: parseInt(parts[1]) || 0,
      users: gc(tag, EC_TAGS.EC_TAG_SERVER_USERS),
      usersMax: gc(tag, EC_TAGS.EC_TAG_SERVER_USERS_MAX),
      files: gc(tag, EC_TAGS.EC_TAG_SERVER_FILES),
      ping: gc(tag, EC_TAGS.EC_TAG_SERVER_PING),
      desc: gc(tag, EC_TAGS.EC_TAG_SERVER_DESC),
      version: gc(tag, EC_TAGS.EC_TAG_SERVER_VERSION),
    };
  });
  res.json(list);
}));

app.get('/api/servers/info', safe(async (req, res) => {
  if (nc(res)) return;
  const resp = await cl.session.sendPacket(EC_OPCODES.EC_OP_GET_SERVERINFO, []);
  const msg = resp.tags?.find(t => t.tagId === EC_TAGS.EC_TAG_STRING)?.humanValue || '';
  res.json({ message: msg });
}));

app.post('/api/servers/connect', safe(async (req, res) => {
  if (nc(res)) return;
  const { ip, port } = req.body;
  res.json({ ok: await cl.connectServer(ip, parseInt(port)) });
}));

app.post('/api/servers/disconnect', safe(async (req, res) => {
  if (nc(res)) return;
  const { ip, port } = req.body;
  res.json({ ok: await cl.disconnectServer(ip, parseInt(port)) });
}));

app.delete('/api/servers', safe(async (req, res) => {
  if (nc(res)) return;
  const { ip, port } = req.body;
  res.json({ ok: await cl.removeServer(ip, parseInt(port)) });
}));

app.get('/api/downloads', safe(async (req, res) => {
  if (nc(res)) return;
  res.json(await cl.getDownloadQueue() || []);
}));

app.post('/api/downloads/pause', safe(async (req, res) => {
  if (nc(res)) return;
  res.json({ ok: await cl.pauseDownload(req.body.hash) });
}));

app.post('/api/downloads/resume', safe(async (req, res) => {
  if (nc(res)) return;
  res.json({ ok: await cl.resumeDownload(req.body.hash) });
}));

app.delete('/api/downloads', safe(async (req, res) => {
  if (nc(res)) return;
  res.json({ ok: await cl.cancelDownload(req.body.hash) });
}));

app.post('/api/download', safe(async (req, res) => {
  if (nc(res)) return;
  const { hash, link, categoryId = 0 } = req.body;
  if (link) { await cl.addEd2kLink(link, categoryId); log('Link queued'); }
  else { await cl.downloadSearchResult(hash, categoryId); log(`Hash: ${hash}`); }
  res.json({ ok: true });
}));

app.get('/api/shared', safe(async (req, res) => {
  if (nc(res)) return;
  res.json(await cl.getSharedFiles() || []);
}));

app.post('/api/shared/reload', safe(async (req, res) => {
  if (nc(res)) return;
  res.json({ ok: await cl.refreshSharedFiles() });
}));

app.get('/api/uploads', safe(async (req, res) => {
  if (nc(res)) return;
  const resp = await cl.session.sendPacket(EC_OPCODES.EC_OP_GET_ULOAD_QUEUE, []);
  const list = (resp.tags || []).map(tag => {
    const gc = id => tag.children?.find(c => c.tagId === id)?.humanValue;
    return {
      fileName: gc(EC_TAGS.EC_TAG_PARTFILE_NAME),
      fileHash: gc(EC_TAGS.EC_TAG_PARTFILE_HASH),
      fileSize: gc(EC_TAGS.EC_TAG_PARTFILE_SIZE_FULL),
      speed: gc(EC_TAGS.EC_TAG_PARTFILE_SPEED)
    };
  });
  res.json(list);
}));

app.post('/api/search/start', safe(async (req, res) => {
  if (nc(res)) return;
  const { query, type = 'global', extension } = req.body;
  const network = TM[type] ?? 1;
  log(`Search: "${query}" [${type}=${network}]`);
  await cl._search(query, network, extension || null);
  res.json({ ok: true });
}));

app.get('/api/search/results', safe(async (req, res) => {
  if (nc(res)) return;
  const data = await cl.getSearchResults();
  res.json({ results: data?.results || [], count: data?.resultsLength || 0 });
}));

app.get('/api/categories', safe(async (req, res) => {
  if (nc(res)) return;
  res.json(await cl.getCategories());
}));

app.post('/api/categories', safe(async (req, res) => {
  if (nc(res)) return;
  const { title, catPath = '', comment = '', color = 0, priority = 0 } = req.body;
  res.json(await cl.createCategory(title, catPath, comment, color, priority));
}));

app.put('/api/categories/:id', safe(async (req, res) => {
  if (nc(res)) return;
  const { title, catPath = '', comment = '', color = 0, priority = 0 } = req.body;
  res.json({ ok: await cl.updateCategory(parseInt(req.params.id), title, catPath, comment, color, priority) });
}));

app.delete('/api/categories/:id', safe(async (req, res) => {
  if (nc(res)) return;
  res.json({ ok: await cl.deleteCategory(parseInt(req.params.id)) });
}));

app.post('/api/categories/assign', safe(async (req, res) => {
  if (nc(res)) return;
  const { hash, categoryId } = req.body;
  res.json({ ok: await cl.setFileCategory(hash, categoryId) });
}));

app.get('/api/preferences', safe(async (req, res) => {
  if (nc(res)) return;
  res.json(await cl.getPreferences());
}));

app.post('/api/preferences', safe(async (req, res) => {
  if (nc(res)) return;
  const { maxDownload, maxUpload } = req.body;
  const results = {};
  if (maxDownload !== undefined) results.maxDownload = await cl.setMaxDownload(parseInt(maxDownload));
  if (maxUpload !== undefined) results.maxUpload = await cl.setMaxUpload(parseInt(maxUpload));
  res.json({ ok: true, ...results });
}));

app.post('/api/downloads/clear-completed', safe(async (req, res) => {
  if (nc(res)) return;
  res.json({ ok: await cl.clearCompleted() });
}));

app.get('/api/log', safe(async (req, res) => {
  if (nc(res)) return;
  res.json(await cl.getLog());
}));

app.get('/api/log/debug', safe(async (req, res) => {
  if (nc(res)) return;
  res.json(await cl.getDebugLog());
}));


const MB = p.join(__dirname, 'Archivos');
const A_EXT = new Set(['.mp3','.flac','.ogg','.wav','.m4a','.aac','.opus','.wma','.aiff','.ape','.mid']);
const V_EXT = new Set(['.mp4','.webm','.mov','.mkv','.avi','.ts','.flv','.3gp','.wmv']);
const I_EXT = new Set(['.jpg','.jpeg','.png','.gif','.webp','.avif','.bmp','.tiff','.svg','.heic']);
const D_EXT = new Set(['.pdf','.doc','.docx','.xls','.xlsx','.txt','.zip','.rar','.md','.csv','.json','.epub','.7z','.tar','.gz']);
let mCache = null;

const mStorage = multer.diskStorage({
  destination(req, file, cb) {
    const rel = req.body.rel || '';
    const dir = rel ? p.dirname(p.join(MB, rel)) : MB;
    const abs = p.resolve(dir);
    if (!abs.startsWith(MB)) return cb(new Error('Forbidden'));
    fs.mkdirSync(abs, { recursive: true });
    cb(null, abs);
  },
  filename(req, file, cb) {
    const rel = req.body.rel || '';
    cb(null, rel ? p.basename(rel) : file.originalname);
  }
});
const mUpload = multer({ storage: mStorage });

function mSafe(rel) {
  const abs = p.resolve(MB, rel);
  return (abs.startsWith(MB + p.sep) || abs === MB) ? abs : null;
}
function mType(ext) {
  if (A_EXT.has(ext)) return 'audio';
  if (V_EXT.has(ext)) return 'video';
  if (I_EXT.has(ext)) return 'image';
  if (D_EXT.has(ext)) return 'doc';
  return 'doc';
}
function scanDir(dir, base) {
  const items = [];
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(_) { return items; }
  for (const e of entries) {
    const abs = p.join(dir, e.name);
    if (e.isDirectory()) { items.push(...scanDir(abs, base)); continue; }
    const ext = p.extname(e.name).toLowerCase();
    const type = mType(ext); if (!type) continue;
    const rel = p.relative(base, abs).replace(/\\/g, '/');
    items.push({ name: e.name, rel, type, ext, size: fs.statSync(abs).size });
  }
  return items;
}
function buildCache() {
  if (!fs.existsSync(MB)) fs.mkdirSync(MB, { recursive: true });
  const items = scanDir(MB, MB);
  for (const it of items) {
    if (it.type !== 'audio' || it.ext !== '.mp3') continue;
    try {
      const t = NodeID3.read(p.join(MB, it.rel));
      it.title = t.title || null; it.artist = t.artist || null;
      it.album = t.album || null; it.year = t.year || null; it.genre = t.genre || null;
      if (t.image?.imageBuffer) it.cover = 'data:'+(t.image.mime||'image/jpeg')+';base64,'+t.image.imageBuffer.toString('base64');
    } catch(_) {}
  }
  mCache = items;
  log('Media: '+items.length+' archivos');
}
buildCache();

app.get('/api/media', (req, res) => { if (!mCache) buildCache(); res.json(mCache); });
app.post('/api/media/scan', (req, res) => { buildCache(); res.json({ ok: true, count: mCache.length }); });

app.put('/api/media/meta', mUpload.single('cover'), safe(async (req, res) => {
  const { rel, title, artist, album, year, genre } = req.body;
  const abs = mSafe(rel); if (!abs) return res.status(403).json({ error: 'Forbidden' });
  if (p.extname(rel).toLowerCase() !== '.mp3') return res.status(400).json({ error: 'Solo mp3' });
  const tags = {};
  if (title  !== undefined) tags.title  = title;
  if (artist !== undefined) tags.artist = artist;
  if (album  !== undefined) tags.album  = album;
  if (year   !== undefined) tags.year   = String(year);
  if (genre  !== undefined) tags.genre  = genre;
  if (req.file) {
    const imgBuf = fs.readFileSync(req.file.path);
    const mime = req.file.mimetype || 'image/jpeg';
    tags.image = { mime, type: { id: 3, name: 'front cover' }, description: '', imageBuffer: imgBuf };
    fs.unlinkSync(req.file.path);
  }
  NodeID3.update(tags, abs);
  const it = mCache?.find(i => i.rel === rel);
  if (it) {
    Object.assign(it, { title: tags.title??it.title, artist: tags.artist??it.artist, album: tags.album??it.album, year: tags.year??it.year, genre: tags.genre??it.genre });
    if (tags.image) it.cover = 'data:'+tags.image.mime+';base64,'+tags.image.imageBuffer.toString('base64');
  }
  res.json({ ok: true, cover: it?.cover || null });
}));

app.delete('/api/media/file', safe(async (req, res) => {
  const { rel } = req.body; const abs = mSafe(rel);
  if (!abs) return res.status(403).json({ error: 'Forbidden' });
  fs.unlinkSync(abs);
  if (mCache) mCache = mCache.filter(i => i.rel !== rel);
  res.json({ ok: true });
}));

app.post('/api/media/upload', mUpload.single('file'), safe(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const rel = req.body.rel || req.file.originalname;
  const abs = p.resolve(MB, rel);
  if (!abs.startsWith(MB)) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: 'Forbidden' }); }
  const ext = p.extname(rel).toLowerCase();
  const type = mType(ext);
  if (mCache) {
    const existing = mCache.findIndex(i => i.rel === rel.replace(/\\/g,'/'));
    const item = { name: p.basename(rel), rel: rel.replace(/\\/g,'/'), type, ext, size: fs.statSync(abs).size };
    if (existing >= 0) mCache[existing] = item; else mCache.push(item);
  }
  res.json({ ok: true, rel });
}));

app.get('/files{/*path}', (req, res) => {
  const rel = [].concat(req.params.path||[]).join('/'); const abs = mSafe(rel);
  if (!abs) return res.status(403).send('Forbidden');
  if (!fs.existsSync(abs)) return res.status(404).send('Not found');
  res.sendFile(abs);
});

server.listen(6859, () => log('MuLy → http://localhost:6859'));
