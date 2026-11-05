// Twitch — chat por IRC (WebSocket oficial irc-ws.chat.twitch.tv) e status das lives pela
// API Helix. Tudo por caminhos documentados pela Twitch:
// - Sem token, o chat entra como "justinfan" (só leitura, sem login).
// - Com o token OAuth da própria pessoa (fluxo implícito, app dela no Developer Console),
//   o chat entra com a conta dela e pode enviar mensagens.
// - O status ao vivo usa um token de app (client credentials) do mesmo app.

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const HELIX = 'https://api.twitch.tv/helix';

// "@a=1;b=2 :nick!nick@nick.tmi.twitch.tv PRIVMSG #canal :texto" -> partes.
function parseLine(line) {
  let rest = line;
  const tags = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    for (const kv of rest.slice(1, sp).split(';')) {
      const i = kv.indexOf('=');
      const k = i < 0 ? kv : kv.slice(0, i);
      const v = i < 0 ? '' : kv.slice(i + 1);
      tags[k] = v.replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    }
    rest = rest.slice(sp + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const t = rest.indexOf(' :');
  const trailing = t >= 0 ? rest.slice(t + 2) : null;
  const params = (t >= 0 ? rest.slice(0, t) : rest).split(' ').filter(Boolean);
  return { tags, prefix, command: params.shift(), params, trailing };
}

// Troca os trechos de emote (tag "emotes=id:0-4,6-10/id2:...") por "[temote:id:nome]",
// o mesmo formato de marcação que a interface já usa para os emotes da Kick.
function markEmotes(text, emotesTag) {
  if (!emotesTag) return text;
  const chars = [...text]; // posições da Twitch contam caracteres Unicode, não unidades UTF-16
  const ranges = [];
  for (const part of emotesTag.split('/')) {
    const [id, spots] = part.split(':');
    if (!id || !spots || !/^[\w-]+$/.test(id)) continue;
    for (const spot of spots.split(',')) {
      const [a, b] = spot.split('-').map(Number);
      if (Number.isInteger(a) && Number.isInteger(b) && b >= a && b < chars.length) ranges.push({ id, a, b });
    }
  }
  ranges.sort((x, y) => x.a - y.a);
  let out = '';
  let pos = 0;
  for (const r of ranges) {
    if (r.a < pos) continue;
    out += chars.slice(pos, r.a).join('');
    out += `[temote:${r.id}:${chars.slice(r.a, r.b + 1).join('').replace(/[[\]]/g, '')}]`;
    pos = r.b + 1;
  }
  return out + chars.slice(pos).join('');
}

const BADGE_TEXT = {
  broadcaster: 'streamer', moderator: 'mod', vip: 'vip', subscriber: 'sub', founder: 'founder',
  staff: 'staff', partner: 'verificado', turbo: 'turbo', premium: 'prime',
};

// Converte um PRIVMSG no mesmo formato de mensagem que a Kick manda (o renderer usa um só).
function toChatData(msg) {
  const tags = msg.tags;
  const username = tags['display-name'] || (msg.prefix.split('!')[0]);
  const badges = (tags.badges || '').split(',').filter(Boolean).map((b) => b.split('/')[0])
    .filter((type) => BADGE_TEXT[type]).map((type) => ({ type, text: BADGE_TEXT[type] }));
  let text = msg.trailing || '';
  // "/me": vem como \x01ACTION texto\x01.
  const action = /^\x01ACTION (.*)\x01$/.exec(text);
  if (action) text = action[1];
  const data = {
    id: tags.id || `${Date.now()}-${Math.random()}`,
    content: markEmotes(text, tags.emotes),
    created_at: tags['tmi-sent-ts'] ? new Date(Number(tags['tmi-sent-ts'])).toISOString() : new Date().toISOString(),
    sender: { username, identity: { color: tags.color || null, badges } },
  };
  if (tags['reply-parent-display-name']) {
    data.type = 'reply';
    data.metadata = {
      original_sender: { username: tags['reply-parent-display-name'] },
      original_message: { content: tags['reply-parent-msg-body'] || '' },
    };
    // A Twitch repete "@nome " no começo da resposta; a linha "respondendo" já mostra isso.
    data.content = data.content.replace(/^@\S+\s/, '');
  }
  return data;
}

class TwitchChat {
  constructor({ onMessage, onNotice, onState } = {}) {
    this.onMessage = onMessage || (() => {});
    this.onNotice = onNotice || (() => {});
    this.onState = onState || (() => {});
    this.wanted = new Set();   // canais (login) que devem estar no chat
    this.joined = new Set();
    this.auth = null;          // { login, token } para entrar com a conta da pessoa
    this.ws = null;
    this.connected = false;
    this.retryMs = 2000;
    this.closing = false;
  }

  setAuth(auth) {
    const same = (auth && this.auth && auth.login === this.auth.login && auth.token === this.auth.token) || (!auth && !this.auth);
    this.auth = auth;
    if (!same) this.reconnect();
  }

  setChannels(logins) {
    this.wanted = new Set(logins.map((l) => l.toLowerCase()));
    if (!this.ws) { if (this.wanted.size) this.connect(); return; }
    if (!this.connected) return;
    const join = [...this.wanted].filter((c) => !this.joined.has(c));
    const part = [...this.joined].filter((c) => !this.wanted.has(c));
    // JOIN em lotes pequenos (a Twitch limita ~20 JOINs a cada 10 s).
    for (let i = 0; i < join.length; i += 10) {
      const batch = join.slice(i, i + 10);
      setTimeout(() => this.raw(`JOIN ${batch.map((c) => `#${c}`).join(',')}`), (i / 10) * 6000);
      batch.forEach((c) => this.joined.add(c));
    }
    if (part.length) { this.raw(`PART ${part.map((c) => `#${c}`).join(',')}`); part.forEach((c) => this.joined.delete(c)); }
  }

  raw(line) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(line);
  }

  connect() {
    if (this.ws) return;
    this.closing = false;
    const ws = new WebSocket(IRC_URL);
    this.ws = ws;
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      if (this.auth) {
        ws.send(`PASS oauth:${this.auth.token}`);
        ws.send(`NICK ${this.auth.login}`);
      } else {
        ws.send('PASS SCHMOOPIIE');
        ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      }
    };
    ws.onmessage = (e) => {
      for (const line of String(e.data).split('\r\n')) if (line) this.handle(parseLine(line));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.joined.clear();
      this.onState(false);
      if (this.closing) return;
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 60 * 1000);
    };
    ws.onerror = () => {};
  }

  reconnect() {
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.joined.clear();
    if (ws) { try { ws.close(); } catch {} }
    if (this.wanted.size) this.connect();
  }

  close() {
    this.closing = true;
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = null;
  }

  handle(msg) {
    switch (msg.command) {
      case 'PING': this.raw(`PONG :${msg.trailing || 'tmi.twitch.tv'}`); break;
      case '001':
        this.connected = true;
        this.retryMs = 2000;
        this.onState(true);
        this.setChannels([...this.wanted]);
        break;
      case 'RECONNECT': this.reconnect(); break;
      case 'PRIVMSG': {
        const channel = (msg.params[0] || '').replace(/^#/, '');
        this.onMessage(channel, toChatData(msg));
        break;
      }
      case 'NOTICE': {
        const channel = (msg.params[0] || '').replace(/^#/, '');
        // Token recusado: volta para o modo só leitura.
        if (/authentication failed|improperly formatted auth/i.test(msg.trailing || '')) {
          this.onNotice(null, 'Twitch recusou o token do chat. Conecte a Twitch de novo.');
          this.auth = null;
          this.reconnect();
          return;
        }
        this.onNotice(channel === '*' ? null : channel, msg.trailing || '');
        break;
      }
      default: break;
    }
  }

  // Envia uma mensagem com a conta da pessoa (só com token).
  send(channel, text) {
    if (!this.auth) return { ok: false, message: 'Conecte a Twitch (botão "API Twitch") para enviar mensagens.' };
    if (!this.connected) return { ok: false, message: 'Chat da Twitch ainda conectando, tente de novo.' };
    const clean = String(text).replace(/[\r\n]+/g, ' ').slice(0, 500);
    this.raw(`PRIVMSG #${channel.toLowerCase()} :${clean}`);
    return { ok: true };
  }
}

// ---------- Helix ----------
// Token de app (client credentials): só para consultar quem está ao vivo.
let appToken = null; // { token, exp, clientId }
async function getAppToken(fetchFn, clientId, clientSecret) {
  if (appToken && appToken.clientId === clientId && appToken.exp > Date.now() + 60 * 1000) return appToken.token;
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' });
  const res = await fetchFn('https://id.twitch.tv/oauth2/token', { method: 'POST', body });
  if (!res.ok) {
    const msg = ((await res.json().catch(() => ({}))).message || '').toLowerCase();
    if (msg.includes('client secret')) throw new Error('Client Secret inválido. Gere um novo em dev.twitch.tv (Gerenciar > Novo segredo) e cole aqui.');
    if (msg.includes('client')) throw new Error('Client ID inválido. Confira o Client ID do app em dev.twitch.tv.');
    throw new Error(`a Twitch recusou o app (HTTP ${res.status})`);
  }
  const json = await res.json();
  appToken = { token: json.access_token, exp: Date.now() + json.expires_in * 1000, clientId };
  return appToken.token;
}

// Quem está ao vivo entre os logins pedidos: { login: { title, viewers, displayName } }.
async function fetchLive(fetchFn, { clientId, clientSecret }, logins) {
  const token = await getAppToken(fetchFn, clientId, clientSecret);
  const live = {};
  for (let i = 0; i < logins.length; i += 100) {
    const qs = logins.slice(i, i + 100).map((l) => `user_login=${encodeURIComponent(l)}`).join('&');
    const res = await fetchFn(`${HELIX}/streams?${qs}&first=100`, { headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` } });
    if (res.status === 401) appToken = null;
    if (!res.ok) throw new Error(`Helix HTTP ${res.status}`);
    for (const s of (await res.json()).data || []) {
      live[s.user_login.toLowerCase()] = { title: s.title, viewers: s.viewer_count, displayName: s.user_name };
    }
  }
  return live;
}

// Valida o token OAuth da pessoa e devolve o login dela.
async function validateUserToken(fetchFn, token) {
  const res = await fetchFn('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${token}` } });
  if (!res.ok) return null;
  const json = await res.json();
  return { login: json.login, scopes: json.scopes || [], expiresIn: json.expires_in };
}

module.exports = { TwitchChat, fetchLive, validateUserToken, parseLine, markEmotes, toChatData };
