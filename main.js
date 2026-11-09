// TK MultiStream (antigo Kickterino) — processo principal.
// Ideia: uma sessão de navegador persistente (você faz login na Kick uma vez),
// uma janela oculta "api" em kick.com para consultar status/pontos, e uma janela
// oculta e muda por canal AO VIVO tocando o player real — é isso que conta como "assistindo".
const {
  app, BrowserWindow, dialog, ipcMain, session, shell, clipboard, Tray, Menu, Notification, nativeImage, powerSaveBlocker, powerMonitor, net, webContents, WebContentsView,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const twitch = require('./twitch');
const nodeNet = require('net');

// ---------- Várias contas numa janela só ----------
// A conta principal é o app com janela. Cada conta alt é uma cópia deste mesmo app rodando por trás
// (--conta=NOME --tk-fundo: sem janela nem bandeja), com logins, canais, farm e bônus próprios.
// A principal mostra a conta escolhida na barra de contas: os comandos da interface (os mesmos
// ipcMain.handle de sempre) são repassados para a cópia daquela conta por um canal local (pipe).
const HEADLESS = process.argv.includes('--tk-fundo');
const HANDLERS = new Map();      // canal -> função (para atender pelo canal de controle)
let routeHandler = null;         // definido mais abaixo: repassa para a conta alt escolhida
let localResult = null;          // definido mais abaixo: com uma alt na tela, a resposta é o estado dela
const ipcHandleOriginal = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => {
  HANDLERS.set(channel, fn);
  return ipcHandleOriginal(channel, (e, ...args) => {
    const routed = routeHandler && routeHandler(channel, args);
    if (routed !== undefined) return routed;
    const value = fn(e, ...args);
    return localResult ? Promise.resolve(value).then((v) => localResult(v)) : value;
  });
};
const pipeName = (id) => `\\\\.\\pipe\\tk-multistream-${id}`;

// Mantém vídeos rodando mesmo com janelas ocultas/minimizadas.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Com placa de vídeo, o Chromium congela vídeos de janelas ocultas (o tempo do player parava em 0–1 s).
app.commandLine.appendSwitch('disable-background-media-suspend');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,BackgroundVideoTrackOptimization,IntensiveWakeUpThrottling');
// O JavaScript de cada página reserva menos memória "jovem".
app.commandLine.appendSwitch('js-flags', '--max-semi-space-size=1');
// As alts rodam por trás, sem nada na tela: sem placa de vídeo, cada uma gasta ~250 MB a menos.
if (process.argv.includes('--tk-fundo')) app.disableHardwareAcceleration();

// Contas extras (alts): "--conta=alt1" abre uma cópia separada do app, com pasta de dados própria
// (logins da Kick, da Twitch e do PokeIdle, canais, bônus e histórico só daquela conta). Cada cópia
// roda sozinha, com as próprias vagas de live; o atalho de cada alt passa o --conta.
const ACCOUNT = (process.argv.find((a) => a.startsWith('--conta=')) || '').slice(8)
  .toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20) || null;
const APP_TITLE = ACCOUNT ? `TK MultiStream — ${ACCOUNT}` : 'TK MultiStream';
// O app agora se chama TK MultiStream, mas login, canais e histórico continuam na pasta antiga.
const MAIN_DATA = path.join(app.getPath('appData'), 'Kickterino');
// Pasta de dados alternativa (testes sem mexer na instalação de verdade).
if (process.env.KICKTERINO_DATA) app.setPath('userData', process.env.KICKTERINO_DATA);
else app.setPath('userData', ACCOUNT ? `${MAIN_DATA}-${ACCOUNT}` : MAIN_DATA);

const PARTITION = 'persist:kick';
const KICK = 'https://kick.com';
// Twitch: sessão separada (cada plataforma tem a própria conta e as próprias vagas de live).
const TWITCH_PARTITION = 'persist:twitch';
const TWITCH = 'https://www.twitch.tv';

// Canais da Kick ficam na lista como "slug" (como sempre); os da Twitch como "twitch:login".
const platformOf = (key) => (String(key).startsWith('twitch:') ? 'twitch' : 'kick');
const nameOf = (key) => String(key).replace(/^twitch:/, '');
const partitionOf = (key) => (platformOf(key) === 'twitch' ? TWITCH_PARTITION : PARTITION);
const channelUrl = (key) => (platformOf(key) === 'twitch' ? `${TWITCH}/${nameOf(key)}` : `${KICK}/${key}`);
// Live escondida só com o player (sem chat, painéis e o resto do site): bem menos memória.
// Twitch: o autor do Twitchterino mediu em 04/11/2026, com conta logada, ~220 MB contra ~440 MB por
// live, os mesmos pontos e o baú aparecendo. Kick: testado em 05/11/2026 na conta do usuário, os
// pontos também sobem (~215 MB por live); o chat da Kick no app some (vinha da página).
// Para voltar à página inteira: config.twitchWatchMode / config.kickWatchMode = 'page'.
const watchMode = (key) => (platformOf(key) === 'twitch' ? (config.twitchWatchMode || 'player') : (config.kickWatchMode || 'player'));
const watchUrl = (key) => {
  if (watchMode(key) !== 'player') return channelUrl(key);
  return platformOf(key) === 'twitch'
    ? `https://player.twitch.tv/?channel=${encodeURIComponent(nameOf(key))}&parent=www.twitch.tv&muted=true&autoplay=true`
    : `https://player.kick.com/${encodeURIComponent(key)}?muted=true&autoplay=true`;
};
const POLL_MS = 60 * 1000;
const PLAYER_CHECK_MS = 30 * 1000;

const configPath = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULT_CONFIG = {
  channels: [
    'yetz', 'biscoitao', 'surskity', 'tftoddy', 'techzz', 'clovaobengalalol', 'axt', 'yulla', 'faturetosl',
    'cogu', 'rodil', 'patopapao2', 'matta', 'luccatv', 'guaxilol1', 'dersin2k', 'mecmeno',
  ],
  farming: true,
  // Medido em 30/10/2026: a Kick só contou pontos em ~2 lives por vez (12 abertas renderam o
  // mesmo que 2). Mais vagas só gastam memória; o rodízio espalha os pontos entre os canais.
  maxWatchers: 2,
  lowQuality: true,
  rotation: true,
  bonusTarget: 0, // 0 = automático (300, 500, 1.000); ou o custo do único bônus que a pessoa quer
  notifyBonus: true,
  notifyChat: true,  // menções ao seu nome e sorteios no chat
  sleepMode: false,  // "antes de dormir": só aparece para quem ligar
  favorites: [],
  purchases: [],     // bônus comprados: { t, cost, slug } (cronômetro e relatório)
  daily: {},         // pontos ganhos por dia: { 'AAAA-MM-DD': pts }
  // App da própria pessoa no Twitch Developer Console (dev.twitch.tv/console/apps).
  twitchClientId: '',
  twitchClientSecret: '', // só para saber quem está ao vivo (token de app)
  twitchToken: '',        // token OAuth da pessoa (chat:read chat:edit), para enviar mensagens
  pokeBonus: {},          // { twitch: { xp, captura, shiny, setAt, source }, kick: {...} } — fim de cada bônus
  pokeReadAt: null,       // última leitura feita do jogo aberto no app
};
let config = { ...DEFAULT_CONFIG };
let firstRun = false;

function loadConfig() {
  firstRun = !fs.existsSync(configPath());
  try { config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; } catch {}
  // Conta alt nova: começa com a lista de canais e o app da Twitch da conta principal (os logins não).
  if (firstRun && ACCOUNT) {
    try {
      const main = JSON.parse(fs.readFileSync(path.join(MAIN_DATA, 'config.json'), 'utf8'));
      for (const k of ['channels', 'favorites', 'seenDefaults', 'twitchClientId', 'twitchClientSecret', 'maxWatchers', 'lowQuality', 'rotation', 'bonusTarget', 'configVersion', 'lastSeenVersion']) {
        if (main[k] !== undefined) config[k] = main[k];
      }
    } catch {}
  }
  // Canais oficiais novos de uma versão nova entram uma vez; os que a pessoa removeu não voltam.
  const seen = new Set(config.seenDefaults || config.channels);
  for (const slug of DEFAULT_CONFIG.channels) {
    if (!seen.has(slug) && !config.channels.includes(slug)) config.channels.push(slug);
  }
  config.seenDefaults = [...new Set([...seen, ...DEFAULT_CONFIG.channels])];
  // v2: instalações antigas vinham com 20 lives; passa para o padrão novo (2 + rodízio) uma vez.
  if ((config.configVersion || 1) < 2) {
    config.maxWatchers = DEFAULT_CONFIG.maxWatchers;
    config.rotation = true;
    config.configVersion = 2;
  }
  saveConfig();
}
function saveConfig() {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

let mainWin = null;
let apiWin = null;
let apiReady = null;
const watchers = new Map(); // slug -> BrowserWindow
const allWatchers = watchers; // (reconcilePlatform usa um "watchers" só da plataforma)
const status = new Map();   // slug -> { live, viewers, chatroomId, title, points, watchedMs, watchingSince, error }

function send(channel, payload) {
  if (process.env.KICKTERINO_DEBUG && channel === 'chat') console.log(`CHAT ${payload.slug} ${payload.kind} ${payload.data.username || payload.data.sender.username}`);
  // Conta alt: o que iria para a interface vai para a conta principal, que mostra se for a escolhida.
  if (ACCOUNT) controlBroadcast({ ev: channel, payload });
  if (HEADLESS) return;
  // Principal com uma alt na tela: o status da principal não pode cobrir o da alt.
  if (!ACCOUNT && activeAlt && channel === 'status') return;
  if (channel === 'status' && !ACCOUNT) payload = { ...payload, tk: tkSnapshot() };
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

// Anúncios e rastreadores de terceiros: não fazem parte da live e só gastam memória/CPU.
const BLOCKED_HOSTS = [
  'googlesyndication.com', 'doubleclick.net', 'googletagmanager.com', 'google-analytics.com',
  'googleadservices.com', 'adservice.google.com', 'imasdk.googleapis.com', 'amazon-adsystem.com',
  'facebook.net', 'facebook.com/tr', 'quora.com', 'analytics.tiktok.com', 'criteo.com', 'criteo.net',
  'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'taboola.com', 'hotjar.com', 'clarity.ms',
];

// Lives ocultas não precisam de imagens nem fontes: ninguém está olhando para elas.
const watcherIds = new Set();
const HIDDEN_SKIP = new Set(['image', 'font']);

function isHiddenWatcher(webContents) {
  if (!webContents || !watcherIds.has(webContents.id)) return false;
  const win = BrowserWindow.fromWebContents(webContents);
  return !!win && !userOpened.has(win);
}

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

function setupSession() {
  for (const p of [PARTITION, TWITCH_PARTITION, POKEIDLE_PARTITION]) setupPartition(p);
}
function setupPartition(partition) {
  const ses = session.fromPartition(partition);
  ses.setSpellCheckerEnabled(false);
  // Câmera, microfone, localização e afins: nenhuma página precisa disso aqui.
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    const url = details.url;
    cb({
      cancel: BLOCKED_HOSTS.some((h) => url.includes(h)) || url.startsWith('https://static.kick.com/ads/')
        || (HIDDEN_SKIP.has(details.resourceType) && isHiddenWatcher(details.webContents)),
    });
  });
}

// Deixa só a menor qualidade (160p) na lista de qualidades da live — o mesmo que escolher 160p no player.
function lowestQualityOnly(playlist) {
  const lines = playlist.split('\n');
  const head = [];
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) { variants.push([lines[i], lines[i + 1]]); i++; }
    else if (!variants.length) head.push(lines[i]);
  }
  if (variants.length < 2) return null;
  const bandwidth = (l) => Number((l.match(/BANDWIDTH=(\d+)/) || [0, Infinity])[1]);
  variants.sort((a, b) => bandwidth(a[0]) - bandwidth(b[0]));
  return [...head, ...variants[0]].join('\n') + '\n';
}

// Só a Kick e as páginas de login que ela usa abrem no app: nada de site de fora na mesma
// sessão que guarda o login. Pop-ups de login abrem numa janela normal com a mesma sessão.
const TRUSTED_DOMAINS = ['kick.com', 'google.com', 'accounts.youtube.com', 'apple.com', 'discord.com', 'twitch.tv', 'pokeidle.io'];
const GOOGLE_REGIONAL = /^accounts\.google\.(com?\.)?[a-z]{2}$/; // o Google passa pelo domínio do país no login

function isTrustedUrl(url) {
  if (url === 'about:blank') return true;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (GOOGLE_REGIONAL.test(hostname)
      || TRUSTED_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`)));
  } catch { return false; }
}

app.on('web-contents-created', (_e, wc) => {
  // O pop-up de login usa a mesma sessão da página que o abriu (Kick, Twitch ou a conta do PokeIdle).
  const sameSession = () => [TWITCH_PARTITION, ...pokeAccountIds().map(pokePartition)]
    .find((p) => wc.session === session.fromPartition(p)) || PARTITION;
  // Links de fora abertos pelo PokeIdle (votar no TopIdle, Discord, tutoriais) vão para o navegador
  // da pessoa: dentro do app eles seriam bloqueados (a sessão do app só abre sites confiáveis).
  const fromPokeIdle = () => pokeAccountIds().some((id) => wc.session === session.fromPartition(pokePartition(id)));
  const openOutside = (url) => { if (/^https?:\/\//i.test(url) && fromPokeIdle()) shell.openExternal(url).catch(() => {}); };
  wc.setWindowOpenHandler(({ url }) => {
    if (isTrustedUrl(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { partition: sameSession() } } };
    }
    openOutside(url);
    return { action: 'deny' };
  });
  const guard = (details) => {
    if (details.isMainFrame && !isTrustedUrl(details.url)) { details.preventDefault(); openOutside(details.url); }
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
});

// Página "vazia" em kick.com: mesma origem e cookies, mas sem carregar o site inteiro.
const LIGHT_URL = `${KICK}/robots.txt`;

const withTimeout = (promise, ms) => Promise.race([
  promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
]);

function loadApi(url) {
  apiReady = new Promise((resolve) => apiWin.webContents.once('did-finish-load', resolve));
  apiWin.loadURL(url);
  return apiReady;
}

function createApiWindow() {
  apiWin = new BrowserWindow({
    width: 1100, height: 800, show: false, title: 'Kick — login', autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, backgroundThrottling: false },
  });
  apiWin.webContents.setAudioMuted(true);
  // Sem internet ou com a Kick fora do ar: tenta de novo sozinho. Nunca durante o login.
  const retryApi = () => setTimeout(() => { if (!apiWin.isVisible()) loadApi(LIGHT_URL); }, 30 * 1000);
  apiWin.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) retryApi();
  });
  apiWin.webContents.on('render-process-gone', retryApi);
  loadApi(LIGHT_URL);
  // Fechar a janela de login apenas a esconde e volta para a página leve.
  apiWin.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    apiWin.hide();
    loadApi(LIGHT_URL).then(poll);
  });
}

// Loja de pontos: o chat popout oficial da Kick, que tem o saldo e as recompensas do canal.
const storeWindows = new Map();
const pendingAutoKickPurchases = new Map();
// ---------- Twitch: resgates de bônus lidos da janela de pontos ----------
// Na Twitch os bônus do PokeIdle saem em pacotes de horas (1h, 3h, 5h, 10h), então a queda do saldo
// não diz o que foi comprado (3.000 pode ser 10h de XP, 6h de Capture ou 3h de Lure). A janela de
// pontos do app mostra no chat "sua_conta resgatou Bônus +15% XP PokeIdle (5h)": o app lê essas
// linhas (só as novas, só as da sua conta) e soma exatamente o bônus e as horas.
const REDEEM_WATCH_SCRIPT = `(() => {
  if (window.__stRedeem) return true;
  window.__stRedeem = [];
  const seen = new WeakSet();
  const look = (n) => {
    if (!n || n.nodeType !== 1 || seen.has(n)) return;
    seen.add(n);
    const t = (n.innerText || '').replace(/\\s+/g, ' ').trim();
    if (t.length < 400 && /resgatou|redeemed/i.test(t)) window.__stRedeem.push(t);
  };
  new MutationObserver((muts) => { for (const m of muts) m.addedNodes.forEach(look); })
    .observe(document.body, { childList: true, subtree: true });
  return true;
})()`;

const BONUS_BY_WORD = [[/secret\s*lure|lure/i, 1000], [/capture\s*boost|capture|captura/i, 500], [/\bxp\b/i, 300]];

// "sua_conta resgatou Bônus de +15% Capture Boost (10h) 5.000" -> { cost: 500, hours: 10 }
function parseRedemption(text, login) {
  const t = String(text || '');
  if (!login || !new RegExp(`(^|\\s)${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(resgatou|redeemed)\\b`, 'i').test(t)) return null;
  if (!/pokeidle|\+\s*15\s*%/i.test(t)) return null; // só bônus do PokeIdle
  const hit = BONUS_BY_WORD.find(([re]) => re.test(t));
  if (!hit) return null;
  const h = /\((\d{1,3})\s*h\)/i.exec(t);
  const hours = h ? Math.min(240, Number(h[1])) : 1;
  return { cost: hit[1], hours };
}

let twitchLoginName = null;
async function twitchLogin() {
  if (twitchLoginName) return twitchLoginName;
  const c = await session.fromPartition(TWITCH_PARTITION).cookies.get({ url: TWITCH, name: 'login' }).catch(() => []);
  twitchLoginName = (c[0] && decodeURIComponent(c[0].value)) || twitchUser || null;
  return twitchLoginName;
}

function watchStoreRedemptions(slug, win) {
  const recent = new Map(); // texto -> instante (a mesma linha pode aparecer duas vezes)
  const install = () => win.webContents.executeJavaScript(REDEEM_WATCH_SCRIPT).catch(() => {});
  win.webContents.on('did-finish-load', install);
  const flush = async () => {
    if (win.isDestroyed()) return [];
    const lines = await win.webContents.executeJavaScript('(window.__stRedeem || []).splice(0)').catch(() => []);
    if (!lines.length) return [];
    const login = await twitchLogin();
    const now = Date.now();
    let added = 0;
    const parsed = [];
    for (const line of lines) {
      if (now - (recent.get(line) || 0) < 10 * 1000) continue;
      recent.set(line, now);
      const r = parseRedemption(line, login);
      if (!r) continue;
      parsed.push(r);
      for (let i = 0; i < r.hours; i++) config.purchases.push({ t: now + added + i, cost: r.cost, slug, platform: 'twitch', source: 'loja' });
      added += r.hours;
      const s = status.get(slug);
      if (s) s.expectedDrop = (s.expectedDrop || 0) + r.cost * r.hours; // a queda do saldo já está explicada
      const name = (BONUSES.find((b) => b.cost === r.cost) || {}).name || 'bônus';
      send('toast', `⏱ +${r.hours}h de ${name} (Twitch) no cronômetro`);
    }
    if (added) {
      config.purchases = config.purchases.filter((p) => now - p.t < KEEP_PURCHASES_MS);
      saveConfig(); configDirty = false;
      send('status', snapshot());
      updateTray();
    }
    return parsed;
  };
  const timer = setInterval(() => flush(), 3000);
  win.on('closed', () => clearInterval(timer));
  return flush;
}

function storeChatUrl(slug) {
  return platformOf(slug) === 'twitch'
    ? `${TWITCH}/popout/${nameOf(slug)}/chat`
    : `${KICK}/popout/${slug}/chat`;
}

function openStore(slug, title = `Pontos — ${slug}`) {
  let win = storeWindows.get(slug);
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 420, height: 720, title, autoHideMenuBar: true, backgroundColor: '#0b0e0f',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { partition: partitionOf(slug) },
  });
  win.loadURL(storeChatUrl(slug));
  win.on('page-title-updated', (e) => e.preventDefault()); // mantém o "(2 de 4)" do modo antes de dormir
  if (platformOf(slug) === 'twitch') watchStoreRedemptions(slug, win);
  win.on('closed', () => {
    storeWindows.delete(slug);
    refreshChannel(slug).then(() => send('status', snapshot()));
    if (storeSequence && storeSequence.current === slug) openNextStore();
  });
  storeWindows.set(slug, win);
}

// Modo antes de dormir: abre as lojas uma de cada vez; a próxima abre quando a pessoa fecha a atual.
let storeSequence = null;
function openNextStore() {
  const seq = storeSequence;
  const slug = seq && seq.queue.shift();
  if (!slug) { storeSequence = null; send('status', snapshot()); return; }
  seq.current = slug;
  seq.done++;
  const name = (status.get(slug) || {}).displayName || slug;
  openStore(slug, `Pontos — ${name} (${seq.done} de ${seq.total})`);
  send('status', snapshot());
}

async function sessionToken() {
  const cookies = await session.fromPartition(PARTITION).cookies.get({ url: KICK, name: 'session_token' });
  return cookies[0] ? decodeURIComponent(cookies[0].value) : '';
}

// Faz um fetch de dentro da página kick.com (mesmos cookies/headers de um navegador normal).
async function kickFetch(apiPath, { method = 'GET', body } = {}) {
  await withTimeout(apiReady, 20 * 1000);
  const token = await sessionToken();
  const code = `(async () => {
    const xsrf = decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || '');
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    const token = ${JSON.stringify(token)};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;
    const r = await fetch(${JSON.stringify(apiPath)}, {
      method: ${JSON.stringify(method)}, headers, credentials: 'include',
      ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''}
    });
    return { status: r.status, text: await r.text() };
  })()`;
  const res = await withTimeout(apiWin.webContents.executeJavaScript(code, true), 20 * 1000);
  let json = null;
  try { json = JSON.parse(res.text); } catch {}
  return { status: res.status, json };
}

// Na janela de cada live: força 160p enquanto ela está oculta e lê o chat do websocket
// que a própria página da Kick abre (realtime.*.kick.com), repassando mensagens e resgates.
function instrumentWatcher(slug, win) {
  const dbg = win.webContents.debugger;
  try { dbg.attach('1.3'); } catch { return; }
  const seen = new Set();
  const isKick = platformOf(slug) === 'kick'; // na Twitch o chat vem do IRC, não da página
  dbg.on('message', async (_e, method, p) => {
    if (method === 'Fetch.requestPaused') {
      const pass = () => dbg.sendCommand('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      if (!config.lowQuality || win.isDestroyed() || userOpened.has(win)) return pass();
      try {
        const { body, base64Encoded } = await dbg.sendCommand('Fetch.getResponseBody', { requestId: p.requestId });
        const text = base64Encoded ? Buffer.from(body, 'base64').toString() : body;
        const low = text.includes('#EXT-X-STREAM-INF') ? lowestQualityOnly(text) : null;
        if (!low) return pass();
        await dbg.sendCommand('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: p.responseStatusCode || 200,
          responseHeaders: p.responseHeaders, body: Buffer.from(low).toString('base64'),
        });
      } catch { pass(); }
      return;
    }
    if (!isKick || method !== 'Network.webSocketFrameReceived') return;
    for (const line of p.response.payloadData.split('\n')) {
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      const pub = frame.push && frame.push.pub && frame.push.pub.data;
      if (!pub || typeof pub.data !== 'string') continue;
      let data;
      try { data = JSON.parse(pub.data); } catch { continue; }
      if (pub.event === 'App\\Events\\ChatMessageEvent') {
        if (seen.has(data.id)) continue;
        seen.add(data.id);
        if (seen.size > 2000) seen.clear();
        send('chat', { slug, kind: 'message', data });
      } else if (pub.event === 'RewardRedeemedEvent') {
        send('chat', { slug, kind: 'reward', data });
      }
    }
  });
  if (isKick) dbg.sendCommand('Network.enable').catch(() => {});
  dbg.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*.m3u8*', requestStage: 'Response' }] }).catch(() => {});
}

// Lives que a pessoa abriu para ver (com imagem, som e qualidade normal).
const userOpened = new WeakSet();

// Janela "invisível": existe para o Windows (o vídeo é desenhado e anda de verdade, ao contrário
// de uma janela oculta, que o Chromium congela), mas é transparente, não recebe cliques e não
// aparece na barra de tarefas nem no Alt+Tab.
// No Linux a transparência não existe (a janela apareceria na tela) e o Chromium não congela
// janela oculta, então lá ela só fica escondida.
const isLinux = process.platform === 'linux';
function makeInvisible(win) {
  userOpened.delete(win);
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.setFocusable(false);
  win.setSize(480, 270);
  win.setPosition(0, 0);
  if (isLinux) win.hide();
  else win.showInactive();
}

function startWatcher(slug) {
  if (watchers.has(slug)) return;
  const win = new BrowserWindow({
    width: 480, height: 270, x: 0, y: 0, show: false,
    title: `${platformOf(slug) === 'twitch' ? 'Twitch' : 'Kick'} — ${nameOf(slug)}`, autoHideMenuBar: true,
    type: 'toolbar', skipTaskbar: true, focusable: false, opacity: 0,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { partition: partitionOf(slug), backgroundThrottling: false, spellcheck: false },
  });
  win.webContents.setAudioMuted(true);
  const wcId = win.webContents.id;
  watcherIds.add(wcId);
  win.on('closed', () => watcherIds.delete(wcId));
  instrumentWatcher(slug, win);
  win.loadURL(watchUrl(slug));
  makeInvisible(win);
  // Fechar a live aberta só a torna invisível de novo: volta para 160p, sem som e sem imagens.
  win.on('close', (e) => {
    if (app.isQuitting || watchers.get(slug) !== win) return;
    e.preventDefault();
    makeInvisible(win);
    win.webContents.setAudioMuted(true);
    win.loadURL(watchUrl(slug)); // volta para o modo leve (só o player, se for o caso)
  });
  win.on('closed', () => { if (watchers.get(slug) === win) watchers.delete(slug); });
  // Página que caiu ou não carregou: fecha, e a próxima rodada abre de novo (ou põe outra live).
  const drop = () => setImmediate(() => { if (watchers.get(slug) === win) stopWatcher(slug); });
  win.webContents.on('render-process-gone', drop);
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) drop();
  });
  watchers.set(slug, win);
  const s = status.get(slug) || {};
  s.watchingSince = Date.now();
  status.set(slug, s);
}

// Twitch: o resumo de pontos (saldo e baú) não carrega na página da live escondida, mas carrega
// no chat popout. Em vez de um chat aberto por live (pesado), UMA janela invisível passa pelos
// canais da Twitch de tempos em tempos: lê o saldo de todos (para perceber os bônus comprados) e
// coleta o baú dos canais assistidos. Entre uma passada e outra ela fica fechada.
const SWEEP_GAP_MS = 5 * 60 * 1000;  // pausa entre o fim de uma passada e o começo da próxima
const SWEEP_OFFLINE_MS = 30 * 60 * 1000; // canal offline: o saldo quase não muda; relê a cada 30 min
let sweepWin = null;
let sweeping = false;

function openSweepWin() {
  if (sweepWin && !sweepWin.isDestroyed()) return sweepWin;
  const win = new BrowserWindow({
    width: 400, height: 640, x: 0, y: 0, show: false, title: 'Twitch — pontos',
    type: 'toolbar', skipTaskbar: true, focusable: false, opacity: 0, autoHideMenuBar: true,
    webPreferences: { partition: TWITCH_PARTITION, backgroundThrottling: false, spellcheck: false },
  });
  win.webContents.setAudioMuted(true);
  win.setIgnoreMouseEvents(true);
  // Igual às lives escondidas: sem imagens nem fontes (ninguém olha; o saldo é texto).
  const wcId = win.webContents.id;
  watcherIds.add(wcId);
  win.on('closed', () => { watcherIds.delete(wcId); if (sweepWin === win) sweepWin = null; });
  if (isLinux) win.hide(); else win.showInactive();
  sweepWin = win;
  return win;
}

function closeSweepWin() {
  const win = sweepWin;
  sweepWin = null;
  if (win && !win.isDestroyed()) win.destroy();
}

// Espera o saldo aparecer no chat (ele chega alguns segundos depois da página).
async function waitTwitchBalance(win, ms = 15 * 1000) {
  const until = Date.now() + ms;
  while (Date.now() < until && !win.isDestroyed()) {
    const ok = await win.webContents.executeJavaScript(
      `!!document.querySelector('[data-test-selector="copo-balance-string"], [data-test-selector="balance-string"]')`,
    ).catch(() => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function twitchSweep() {
  if (sweeping) return;
  const keys = twitchKeys();
  if (!config.farming || !twitchLoggedIn || !keys.length) return;
  sweeping = true;
  try {
    // Os assistidos primeiro (baú), depois os outros (saldo e compras).
    const watched = keys.filter((k) => watchers.has(k));
    const order = [...watched, ...keys.filter((k) => !watched.includes(k))];
    for (const key of order) {
      if (!config.channels.includes(key)) continue;
      const st0 = status.get(key) || {};
      // Offline e lido há pouco: pula (menos CPU e internet). Assistidos e ao vivo sempre entram.
      if (!watchers.has(key) && st0.live === false && st0.pointsReadAt && Date.now() - st0.pointsReadAt < SWEEP_OFFLINE_MS) continue;
      const win = openSweepWin();
      await withTimeout(win.loadURL(`${TWITCH}/popout/${nameOf(key)}/chat`), 25 * 1000).catch(() => {});
      if (win.isDestroyed()) break;
      await waitTwitchBalance(win);
      const s = status.get(key);
      if (s) await checkTwitchPage(key, win, s);
    }
  } catch {} finally {
    sweeping = false;
    closeSweepWin();
    if (configDirty) { configDirty = false; saveConfig(); }
    send('status', snapshot());
    updateTray();
  }
}

function scheduleTwitchSweep(delay = SWEEP_GAP_MS) {
  setTimeout(() => twitchSweep().finally(() => scheduleTwitchSweep()), delay);
}

function stopWatcher(slug) {
  const win = watchers.get(slug);
  if (!win) return;
  watchers.delete(slug);
  const s = status.get(slug);
  if (s && s.watchingSince) { s.watchedMs = (s.watchedMs || 0) + (Date.now() - s.watchingSince); s.watchingSince = null; }
  if (!win.isDestroyed()) win.destroy();
}

// Avisa quando o saldo do canal alcança um bônus do PokeIdle. O saldo ao abrir o app é a
// referência: só o que for alcançado depois gera aviso.
const BONUSES = [
  { cost: 300, name: '+15% XP' }, { cost: 500, name: '+15% Capture Boost' }, { cost: 1000, name: '+15% Secret Lure' },
];
const liveNotifications = new Set(); // sem referência, o Windows perde o clique na notificação

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, 'build', 'icon.png') });
  liveNotifications.add(n);
  n.on('click', () => { liveNotifications.delete(n); if (onClick) onClick(); });
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}

function checkBonus(slug, s) {
  const tier = BONUSES.filter((b) => s.points >= b.cost).length;
  const wanted = !config.bonusTarget || (tier && BONUSES[tier - 1].cost === config.bonusTarget);
  if (s.bonusTier != null && tier > s.bonusTier && config.notifyBonus && wanted) {
    notify(`${s.displayName || slug}: ${s.points} pontos`, `Já dá para resgatar ${BONUSES[tier - 1].name}. Clique para abrir a loja.`, () => openStore(slug));
  }
  s.bonusTier = tier;
}

// ---------- Bônus ativos, histórico e relatório ----------
// Cada bônus dura 1 h e as horas compradas se somam. A compra é percebida pela queda do saldo:
// entre duas leituras o saldo pode ter subido até ~25 pts, então vale a menor combinação de
// bônus que explica a queda. Compras que a pessoa registra à mão entram igual.
const BONUS_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_PURCHASES_MS = 10 * DAY_MS;
let configDirty = false;

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function addDaily(n) {
  const k = dayKey(Date.now());
  config.daily[k] = (config.daily[k] || 0) + n;
  configDirty = true;
}

function matchPurchase(drop) {
  let best = null;
  for (let c = 0; c <= 6; c++) for (let b = 0; b <= 6; b++) for (let a = 0; a <= 6; a++) {
    const n = a + b + c, sum = 300 * a + 500 * b + 1000 * c;
    if (!n || sum < drop || sum > drop + 25 || (best && n >= best.length)) continue;
    best = [...Array(c).fill(1000), ...Array(b).fill(500), ...Array(a).fill(300)];
  }
  return best || [];
}

function registerPurchases(slug, drop) {
  const now = Date.now();
  matchPurchase(drop).forEach((cost, i) => config.purchases.push({ t: now + i, cost, slug, platform: platformOf(slug) }));
  config.purchases = config.purchases.filter((p) => now - p.t < KEEP_PURCHASES_MS);
  configDirty = true;
}

function addKnownPurchase(slug, cost, hours, source = 'auto') {
  const now = Date.now();
  for (let i = 0; i < hours; i++) {
    config.purchases.push({ t: now + i, cost, slug, platform: platformOf(slug), source });
  }
  config.purchases = config.purchases.filter((p) => now - p.t < KEEP_PURCHASES_MS);
  saveConfig();
  configDirty = false;
  updateTray();
}

// Fim de cada bônus, somando as horas na ordem das compras.
function bonusIntervals(purchases = config.purchases) {
  const byCost = {};
  for (const p of [...purchases].sort((a, b) => a.t - b.t)) {
    const list = byCost[p.cost] || (byCost[p.cost] = []);
    const last = list[list.length - 1];
    if (last && last.end >= p.t) last.end += BONUS_MS;
    else list.push({ start: p.t, end: p.t + BONUS_MS });
  }
  return byCost;
}

// ---------- Bônus do PokeIdle por plataforma (Twitch e Kick) ----------
// O jogo guarda, para cada plataforma, o instante em que cada bônus acaba
// (estado.eu.twitch.bonus / estado.eu.kick.bonus = { xp, captura, shiny }).
// Fontes, da mais confiável para a menos:
//  1. lido do jogo aberto na janela do PokeIdle do app (ou digitado à mão): config.pokeBonus;
//  2. compras percebidas depois disso (queda do saldo na Kick, ou "+1h" à mão).
const POKE_TIPOS = ['xp', 'captura', 'shiny']; // mesma ordem de BONUSES (300, 500, 1.000)
const PLATFORMS = ['twitch', 'kick'];
const pokeBase = (platform) => ((config.pokeBonus || {})[platform] || {});

function bonusEnd(platform, i, now) {
  const base = pokeBase(platform);
  const since = Number(base.setAt) || 0;
  let end = Number(base[POKE_TIPOS[i]]) || 0;
  const buys = config.purchases
    .filter((p) => (p.platform || 'kick') === platform && p.cost === BONUSES[i].cost && p.t > since)
    .sort((a, b) => a.t - b.t);
  for (const p of buys) end = Math.max(end, p.t) + BONUS_MS;
  return end > now ? end : null;
}

function activeBonuses(now = Date.now(), platform = 'kick') {
  return BONUSES.map((b, i) => ({ cost: b.cost, name: b.name, tipo: POKE_TIPOS[i], endsAt: bonusEnd(platform, i, now) }));
}

// Valores lidos do jogo (ou digitados): passam a ser a referência daquela plataforma.
function setPokeBonus(platform, values, source) {
  if (!PLATFORMS.includes(platform)) return;
  const now = Date.now();
  const cur = { ...pokeBase(platform) };
  // Guarda primeiro o fim atual de TODOS (com as compras já somadas): mudar um bônus não apaga os outros.
  POKE_TIPOS.forEach((tipo, i) => { cur[tipo] = bonusEnd(platform, i, now) || 0; });
  for (const tipo of POKE_TIPOS) if (tipo in values) cur[tipo] = Number(values[tipo]) || 0;
  cur.setAt = now;
  cur.source = source;
  config.pokeBonus = { ...(config.pokeBonus || {}), [platform]: cur };
  configDirty = true;
}

// Aviso 5 min antes de cada bônus acabar (uma vez por fim de bônus).
const warnedEnds = new Set();
function checkBonusEnding() {
  const now = Date.now();
  for (const platform of PLATFORMS) {
    const label = platform === 'twitch' ? 'Twitch' : 'Kick';
    for (const b of activeBonuses(now, platform)) {
      const key = `${platform}:${b.cost}:${b.endsAt}`;
      if (!b.endsAt || b.endsAt - now > 5 * 60 * 1000 || warnedEnds.has(key)) continue;
      warnedEnds.add(key);
      if (!config.notifyBonus) continue;
      if (config.autoXp && b.tipo === 'xp') continue; // a renovação automática cuida dele
      // Sugere o canal da mesma plataforma com mais pontos que ainda paga esse bônus.
      const rich = config.channels.filter((slug) => platformOf(slug) === platform)
        .map((slug) => [slug, status.get(slug) || {}])
        .filter(([, s]) => (s.points || 0) >= b.cost).sort((x, y) => y[1].points - x[1].points)[0];
      notify(`Seu ${b.name} (${label}) acaba em ${Math.max(1, Math.round((b.endsAt - now) / 60000))} min`,
        rich ? `${rich[1].displayName || rich[0]} tem ${rich[1].points} pts. Clique para abrir a loja.`
          : `Abra a loja de um canal da ${label} para renovar.`,
        () => (rich ? openStore(rich[0]) : showMain()));
    }
  }
}

// ---------- Renovação automática do +15% XP ----------
// Faltando poucos minutos para o +15% XP acabar (na Twitch ou na Kick, o que acabar por último),
// compra 1 h no canal desta conta com mais pontos. Cada conta (principal e alts) decide sozinha.
const AUTOXP_BEFORE_MS = 6 * 60 * 1000;
let autoXpBusy = false;
let autoXpWaitUntil = 0;
let autoXpWarned = 0;
// Registro das tentativas (auto-xp.log na pasta de dados da conta), para saber por que não renovou.
function autoXpLog(msg) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'auto-xp.log'), `${new Date().toLocaleString('pt-BR')} ${msg}
`); } catch {}
}
function xpEndsAt(now = Date.now()) {
  return Math.max(bonusEnd('twitch', 0, now) || 0, bonusEnd('kick', 0, now) || 0);
}
async function checkAutoXp() {
  if (!config.autoXp || autoXpBusy || REDEEM_DRYRUN) return;
  const now = Date.now();
  if (now < autoXpWaitUntil) return;
  const end = xpEndsAt(now);
  if (end - now > AUTOXP_BEFORE_MS) return;
  if ([...redeemJobs.values()].some((j) => j.status === 'running')) { autoXpLog('esperando: um resgate manual está rodando'); return; }
  const cost = POKE_REDEEM_META.xp.cost;
  const rich = [...new Set(config.channels)]
    .map((slug) => [slug, status.get(slug) || {}])
    .filter(([, st]) => (st.points || 0) >= cost)
    // Canais ao vivo primeiro: com a live desligada, muitos canais pausam as recompensas.
    .sort((a, b) => (!!b[1].live - !!a[1].live) || (b[1].points - a[1].points));
  autoXpLog(`bônus acaba em ${Math.round((end - now) / 60000)} min; canais com ${cost}+: ${rich.map(([sl, st]) => `${sl}=${st.points}`).join(', ') || 'nenhum'}`);
  if (!rich.length) {
    // Sem saldo em nenhum canal: avisa uma vez por fim de bônus e espera os pontos subirem.
    if (autoXpWarned !== end) {
      autoXpWarned = end;
      notify('+15% XP: sem pontos para renovar', `Nenhum canal desta conta tem ${cost} pontos. Tento de novo quando algum tiver.`, showMain);
    }
    autoXpWaitUntil = now + 5 * 60 * 1000;
    return;
  }
  autoXpBusy = true;
  try {
    for (const [slug, st] of rich.slice(0, 8)) {
      const name = st.displayName || nameOf(slug);
      autoXpLog(`tentando em ${slug}`);
      const r = await withTimeout(redeemPokeBonusInChannel(slug, 'xp'), 3 * 60 * 1000).catch((e) => ({ status: 'failed', message: `demorou demais (${e && e.message || e})` }));
      autoXpLog(`${slug}: ${r.status} — ${r.message || ''}${r.panel ? ` | painel: ${r.panel}` : ''}`);
      if (r.status === 'redeemed' || r.status === 'submitted') {
        // Se a compra ainda não apareceu (a loja não confirmou a tempo), anota a 1 h para não comprar de novo.
        if (xpEndsAt() - Date.now() < 30 * 60 * 1000) addKnownPurchase(slug, cost, 1, 'auto');
        autoXpWaitUntil = Date.now() + 10 * 60 * 1000;
        const msg = `Renovei o +15% XP por 1 h no canal ${name} (${platformOf(slug) === 'kick' ? 'Kick' : 'Twitch'}).`;
        send('toast', '🎁 ' + msg);
        notify('+15% XP renovado', msg, showMain);
        return;
      }
      if (r.reason === 'login-required') continue;
    }
    // Nenhum dos canais com saldo deu certo: tenta de novo daqui a 10 min.
    autoXpWaitUntil = Date.now() + 10 * 60 * 1000;
    if (autoXpWarned !== end) {
      autoXpWarned = end;
      notify('+15% XP: não consegui renovar', 'A loja não aceitou o resgate nos canais com mais pontos. Tento de novo em 10 min.', showMain);
    }
  } finally {
    autoXpBusy = false;
  }
}
ipcMain.handle('autoxp:set', (_e, on) => { config.autoXp = !!on; saveConfig(); autoXpWaitUntil = 0; setTimeout(() => checkAutoXp().catch(() => {}), 2000); return snapshot(); });

// ---------- Janela do PokeIdle ----------
// O jogo só aceita UMA sessão por conta: o app não abre o jogo escondido (derrubaria o seu).
// Ele abre o jogo numa janela normal, onde a pessoa joga, e lê os bônus das mensagens que o
// próprio jogo recebe pelo WebSocket dele.
const POKEIDLE_URL = 'https://pokeidle.io/app';
const POKEIDLE_PARTITION = 'persist:pokeidle';

const POKE_REDEEM_META = {
  xp: { cost: 300, name: '+15% XP' },
  captura: { cost: 500, name: '+15% Capture Boost' },
  shiny: { cost: 1000, name: '+15% Secret Lure' },
};

// A janela da loja é o chat oficial da plataforma. Primeiro abrimos o seletor de pontos;
// só enviamos o formulário da recompensa depois de validar o bônus e o preço escolhidos.
function pokeRedeemOpenScript(platform) {
  return `(() => {
    const platform = ${JSON.stringify(platform)};
    const norm = (s) => String(s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const kickPanel = document.querySelector('#rewards-panel');
    const twitchRewardPanel = [...document.querySelectorAll('[role="dialog"],dialog,[class*="modal" i],[class*="confirm" i]')]
      .some((e) => e.getClientRects().length && /(pokeidle|\\+\\s*15\\s*%|15\\s*%)/.test(norm(e.innerText || '')));
    if ((platform === 'kick' && kickPanel && kickPanel.getClientRects().length)
      || (platform === 'twitch' && twitchRewardPanel)) return { ready: true, clicked: false };
    const pathname = location.pathname || '';
    const hostname = location.hostname || '';
    if ((platform === 'kick' && /\\/login(?:\\/|$)/i.test(pathname))
      || (platform === 'twitch' && /^(id|passport)\\.twitch\\.tv$/i.test(hostname))) {
      return { ready: false, clicked: false, loginRequired: true };
    }
    const loading = platform === 'kick' ? document.querySelector('[data-testid="channel-points-loading-button"]') : null;
    if (loading) return { ready: false, clicked: false, loading: true };
    const known = platform === 'kick'
      ? document.querySelector('[data-testid="channel-points-button"],[data-testid="channel-points-error-button"]')
      : document.querySelector('[data-test-selector="community-points-summary"],[data-a-target="community-points-summary"]');
    const all = [...document.querySelectorAll('button,[role="button"],[aria-label],[title],[data-testid],[data-test-selector],[data-a-target]')];
    const control = known || all.find((e) => {
      const t = norm((e.innerText || e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '') + ' ' + (e.getAttribute('data-test-selector') || '') + ' ' + (e.getAttribute('data-a-target') || '') + ' ' + (e.getAttribute('data-testid') || ''));
      return /community points|channel points|points balance|\\bpoints\\b|pontos do canal|pontos da comunidade|\\bpontos\\b|saldo de pontos|rewards|recompensas/.test(t);
    });
    if (!control) return { ready: false, clicked: false, loading: false };
    const button = control.closest('button,[role="button"]') || control;
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return { ready: false, clicked: false, loading: true };
    button.click();
    return { ready: false, clicked: true };
  })()`;
}

function pokeRedeemSelectScript(tipo) {
  return `(() => {
    const tipo = ${JSON.stringify(tipo)};
    const base = { xp: 300, captura: 500, shiny: 1000 }[tipo];
    const norm = (s) => String(s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, ' ').replace(/\\s+/g, ' ').trim().toLowerCase();
    const textOf = (e) => String(e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim();
    const matches = (s) => {
      const t = norm(s);
      if (!/(pokeidle|\\+\\s*15\\s*%|15\\s*%)/.test(t)) return false;
      if (tipo === 'xp') return /\\bxp\\b/.test(t) && !/capture|captura|lure/.test(t);
      if (tipo === 'captura') return /capture\\s*boost|captura\\s*boost/.test(t);
      return /secret\\s*lure|lure\\s*secreta/.test(t);
    };
    const numberValues = (s) => {
      const values = [];
      for (const m of String(s || '').matchAll(/\\d{1,3}(?:[.,\\s]\\d{3})+|\\d{1,5}/g)) {
        const n = Number(m[0].replace(/\\D/g, ''));
        if (Number.isSafeInteger(n) && n >= base && n <= base * 10 && n % base === 0) values.push(n);
      }
      for (const m of String(s || '').matchAll(/(\\d+(?:[.,]\\d+)?)\\s*k\\b/gi)) {
        const n = Math.round(Number(m[1].replace(',', '.')) * 1000);
        if (Number.isSafeInteger(n) && n >= base && n <= base * 10 && n % base === 0) values.push(n);
      }
      return [...new Set(values)];
    };
    const panelText = norm(document.querySelector('#rewards-panel')?.innerText || '');
    const pausedNotice = /(?:^|\\b)(?:rewards?|recompensas?|resgates?)\\b.{0,60}\\b(?:temporarily\\s+)?paused\\b/.test(panelText)
      || /(?:^|\\b)(?:rewards?|recompensas?|resgates?)\\b.{0,60}\\bpausad[ao]s?\\b/.test(panelText);
    const clickables = [...document.querySelectorAll('button,[role="button"]')].filter((el) => el.getClientRects().length);
    const allMatches = clickables.map((el) => {
      const text = textOf(el);
      const prices = numberValues(text);
      // Resgata só o pacote básico de 1h: XP custa 300, Capture Boost 500 e Secret Lure 1.000.
      // Não clicar em um botão pai que agrupe várias recompensas/preços.
      const price = prices.length === 1 ? prices[0] : 0;
      const duration = /\\b(\\d{1,2})\\s*(?:h|hours?|horas?)\\b/i.exec(text);
      const hours = duration ? Number(duration[1]) : (price && base ? price / base : 0);
      const disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true' || /disabled|is-disabled/.test(String(el.className || '').toLowerCase());
      return { el, text, price, hours, disabled };
    }).filter((x) => matches(x.text));
    if (!allMatches.length) return pausedNotice ? { action: 'paused', panel: panelText.slice(0, 400) } : { action: 'waiting' };
    const exactPackage = allMatches.filter((x) => x.price === base && x.hours === 1);
    if (!exactPackage.length) return pausedNotice ? { action: 'paused' } : { action: 'target-missing', cost: base };
    const available = exactPackage.filter((x) => !x.disabled);
    if (!available.length) return pausedNotice ? { action: 'paused' } : { action: 'no-eligible' };
    available.sort((a, b) => a.text.length - b.text.length);
    const chosen = available[0];
    chosen.el.click();
    return { action: 'selected', cost: base, hours: 1 };
  })()`;
}

function pokeRedeemConfirmScript(tipo, price, platform) {
  return `(() => {
    const tipo = ${JSON.stringify(tipo)};
    const price = ${Number(price) || 0};
    const platform = ${JSON.stringify(platform)};
    const norm = (s) => String(s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, ' ').replace(/\\s+/g, ' ').trim().toLowerCase();
    const matches = (s) => {
      const t = norm(s);
      if (!/(pokeidle|\\+\\s*15\\s*%|15\\s*%)/.test(t)) return false;
      if (tipo === 'xp') return /\\bxp\\b/.test(t) && !/capture|captura|lure/.test(t);
      if (tipo === 'captura') return /capture\\s*boost|captura\\s*boost/.test(t);
      return /secret\\s*lure|lure\\s*secreta/.test(t);
    };
    const isDisabled = (e) => !!e.disabled || e.getAttribute('aria-disabled') === 'true';
    const textOf = (e) => String(e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim();
    // Kick abre os detalhes como uma tela de formulário dentro do painel #rewards-panel,
    // não como um diálogo/modal. O submit do formulário é a ação que confirma o resgate.
    const kickPanel = document.querySelector('#rewards-panel');
    const scopes = platform === 'kick'
      ? (kickPanel ? [kickPanel] : [])
      : [...document.querySelectorAll('[role="dialog"],dialog,[class*="modal" i],[class*="confirm" i]')];
    const scope = scopes.find((e) => matches(textOf(e)) && (platform !== 'kick' || e.querySelector('form')));
    if (!scope) return { action: 'waiting' };
    const form = scope.querySelector('form');
    const confirmationArea = platform === 'kick' ? form : scope;
    const body = norm(textOf(confirmationArea));
    if (!matches(body)) return { action: 'mismatch-bonus' };
    if (/insufficient|not enough points|pontos insuficientes|pontos necessarios|saldo insuficiente/.test(body)) return { action: 'insufficient' };
    const buttonArea = confirmationArea;
    const buttons = [...buttonArea.querySelectorAll('button,[role="button"]')];
    const confirm = buttons.find((e) => {
      const t = norm((e.innerText || e.textContent || '') + ' ' + (e.getAttribute('aria-label') || ''));
      const isSubmit = e.matches('button[type="submit"],input[type="submit"]');
      return (isSubmit || /^(confirm|confirmar|redeem|resgatar|buy|comprar|claim|resgatar bonus)(?:\\b|\\s)/.test(t))
        && /confirm|confirmar|redeem|resgatar|buy|comprar|claim/.test(t)
        && !/cancel|close|back|voltar|nao|no\\b/.test(t) && !isDisabled(e);
    });
    if (!confirm) return { action: 'waiting' };
    if (price) {
      const values = [...body.matchAll(/\\d{1,3}(?:[.,\\s]\\d{3})+|\\d{1,5}/g)].map((m) => Number(m[0].replace(/\\D/g, '')));
      for (const m of body.matchAll(/(\\d+(?:[.,]\\d+)?)\\s*(?:k|mil|thousand)\\b/gi)) {
        const n = Math.round(Number(m[1].replace(',', '.')) * 1000);
        if (Number.isSafeInteger(n)) values.push(n);
      }
      const prices = values.filter((n) => n >= 300 && n <= 10000);
      if (!prices.includes(price)) return { action: 'mismatch' };
    }
    confirm.click();
    return { action: 'confirmed' };
  })()`;
}

// ---------- Resgate na Twitch (estrutura real da loja do chat popout) ----------
// Na Twitch a loja é o painel "Power-ups e recompensas" do chat: cada recompensa é um item
// (rewardListItem) com um botão que só tem o ícone e o preço; o nome fica fora do botão. Clicar
// no botão abre a confirmação DENTRO do mesmo painel (reward-center), com "Voltar", "Fechar" e o
// botão de resgatar (ou "Saldo necessário", desativado, quando não há pontos).
// Modo ensaio (KT_REDEEM_DRYRUN=1): faz tudo, menos o clique final em resgatar.
const REDEEM_DRYRUN = !!process.env.KT_REDEEM_DRYRUN;

function twitchRedeemOpenScript() {
  return `(() => {
    if (/^(id|passport)\\.twitch\\.tv$/i.test(location.hostname) || /\\/login/.test(location.pathname)) return { loginRequired: true };
    if (document.querySelector('[class*="rewardListItem"], .reward-center__content')) return { ready: true };
    const box = document.querySelector('[data-test-selector="community-points-summary"]');
    if (!box) return { waiting: true };
    const buttons = [...box.querySelectorAll('button')];
    const btn = buttons.find((b) => /pontos|points|bits|saldo|balance/i.test(b.getAttribute('aria-label') || '')) || buttons[0];
    if (!btn) return { waiting: true };
    btn.click();
    return { clicked: true };
  })()`;
}

// Escolhe a recompensa de 1h do bônus pedido (o nome sem "(3h)", "(5h)"...) e abre a confirmação.
function twitchRedeemSelectScript(tipo, balance) {
  return `(() => {
    const tipo = ${JSON.stringify(tipo)};
    const balance = ${typeof balance === 'number' ? balance : 'null'};
    const norm = (s) => String(s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const isType = (t) => {
      if (!/pokeidle|15\\s*%/.test(t)) return false;
      if (tipo === 'xp') return /\\bxp\\b/.test(t) && !/capture|lure/.test(t);
      if (tipo === 'captura') return /capture\\s*boost/.test(t);
      return /secret\\s*lure/.test(t);
    };
    const items = [...document.querySelectorAll('[class*="rewardListItem"]')];
    if (!items.length) {
      // Ainda na tela de confirmação/sucesso de um resgate anterior: volta para a lista.
      const back = [...document.querySelectorAll('.reward-center__content button')].find((b) => /voltar|back/i.test(b.getAttribute('aria-label') || ''));
      if (back) { back.click(); return { action: 'waiting', back: true }; }
      return { action: 'waiting' };
    }
    const found = items.map((it) => {
      const costEl = it.querySelector('[data-test-selector="cost"]');
      const cost = Number(String(costEl ? costEl.innerText : '').replace(/\\D/g, '')) || 0;
      const title = String(it.innerText || '').replace(costEl ? costEl.innerText : '', '').replace(/\\s+/g, ' ').trim();
      const h = /\\((\\d{1,2})\\s*h\\)/i.exec(title);
      return { it, cost, title, hours: h ? Number(h[1]) : 1 };
    }).filter((x) => isType(norm(x.title)));
    if (!found.length) return { action: 'target-missing' };
    // O maior pacote que o saldo paga (o preço por hora é o mesmo; menos cliques). Sem saldo
    // conhecido, só o de 1h. Alguns canais não vendem 1h (só 5h e 10h, por exemplo).
    const affordable = found.filter((x) => x.cost > 0 && (balance == null ? x.hours === 1 : x.cost <= balance));
    affordable.sort((a, b) => b.hours - a.hours);
    const one = affordable[0];
    if (!one) {
      const cheapest = found.slice().sort((a, b) => a.cost - b.cost)[0];
      return { action: 'too-expensive', cheapest: cheapest.cost, hours: cheapest.hours };
    }
    const btn = one.it.querySelector('button');
    if (!btn || btn.disabled) return { action: 'no-eligible' };
    btn.click();
    return { action: 'selected', cost: one.cost, hours: one.hours, title: one.title };
  })()`;
}

// Na confirmação: confere o bônus e o preço, e clica no botão de resgatar (nunca em Voltar/Fechar).
function twitchRedeemConfirmScript(tipo, price, dryRun) {
  return `(() => {
    const tipo = ${JSON.stringify(tipo)};
    const price = ${Number(price) || 0};
    const norm = (s) => String(s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const scope = document.querySelector('.reward-center__content');
    if (!scope || document.querySelector('[class*="rewardListItem"]')) return { action: 'waiting' };
    const body = norm(scope.innerText);
    const okType = tipo === 'xp' ? /\\bxp\\b/.test(body) && !/capture boost|secret lure/.test(body)
      : tipo === 'captura' ? /capture boost/.test(body) : /secret lure/.test(body);
    if (!okType) return { action: 'mismatch-bonus' };
    const buttons = [...scope.querySelectorAll('button')].filter((b) => {
      const aria = norm(b.getAttribute('aria-label'));
      return !/voltar|back|fechar|close|mais opcoes|more options|voce tem|you have/.test(aria);
    });
    const withPrice = buttons.filter((b) => norm(b.innerText).replace(/\\D/g, '').includes(String(price)));
    if (!withPrice.length) return { action: 'waiting' };
    const btn = withPrice[0];
    const label = String(btn.innerText || '').replace(/\\s+/g, ' ').trim();
    if (/temporarily unavailable|temporariamente indisponivel|indisponivel|unavailable|paused|pausad/.test(body)) return { action: 'paused', label };
    if (/saldo necessario|not enough|insufficient/.test(norm(label) + ' ' + body)) return { action: 'insufficient', label };
    // Desativado sem falta de saldo: limite de resgates, tempo de espera ou fila do streamer.
    if (btn.disabled) return { action: 'blocked', label, motivo: body.slice(-160) };
    if (!/resgat|redeem|obter|get/.test(norm(label))) return { action: 'unknown-button', label };
    if (${dryRun ? 'true' : 'false'}) return { action: 'dry-run', label };
    btn.click();
    return { action: 'confirmed', label };
  })()`;
}

const redeemJobs = new Map();
let redeemJobSeq = 0;

function redeemJobSnapshot(job) {
  return {
    id: job.id, type: job.type, platform: job.platform, status: job.status, total: job.total, done: job.done,
    current: job.current, cancelRequested: job.cancelRequested, results: job.results, error: job.error || null,
  };
}

function rememberRedeemJob(job) {
  redeemJobs.set(job.id, job);
  while (redeemJobs.size > 20) {
    const oldest = redeemJobs.keys().next().value;
    if (redeemJobs.get(oldest).status === 'running') break;
    redeemJobs.delete(oldest);
  }
}

async function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function openAutoStore(slug) {
  const displayName = (status.get(slug) || {}).displayName || nameOf(slug);
  const win = new BrowserWindow({
    width: 420, height: 720, x: 0, y: 0, show: false, title: `Pontos — ${displayName}`, autoHideMenuBar: true,
    type: 'toolbar', skipTaskbar: true, focusable: false, opacity: 0,
    backgroundColor: '#0b0e0f', webPreferences: { partition: partitionOf(slug), backgroundThrottling: false },
  });
  win.setIgnoreMouseEvents(true);
  win.webContents.setAudioMuted(true);
  const visibleStore = storeWindows.get(slug);
  const flush = platformOf(slug) === 'twitch' && (!visibleStore || visibleStore.isDestroyed())
    ? watchStoreRedemptions(slug, win) : null;
  await withTimeout(win.loadURL(storeChatUrl(slug)), 30 * 1000);
  // A loja fica "aberta" para a página (como as lives escondidas), mas invisível e sem foco:
  // o resgate roda por trás, sem janelas pulando na frente de quem está jogando.
  if (!win.isDestroyed()) { if (isLinux) win.hide(); else win.showInactive(); }
  return { win, flush };
}

async function redeemPokeBonusInChannel(slug, tipo, balanceBefore = null, sharedStore = null) {
  const meta = POKE_REDEEM_META[tipo];
  let win = sharedStore && sharedStore.win;
  let flush = sharedStore && sharedStore.flush;
  let ownsWindow = false;
  const twitchBefore = config.purchases.length;
  let kickBefore = typeof balanceBefore === 'number' ? balanceBefore : (status.get(slug) || {}).points;
  try {
    if (platformOf(slug) === 'kick' && kickBefore == null) {
      await refreshChannel(slug).catch(() => {});
      kickBefore = (status.get(slug) || {}).points;
    }
    if (!win || win.isDestroyed()) {
      ({ win, flush } = await openAutoStore(slug));
      ownsWindow = true;
      await delay(1800);
    }
    let opened = null;
    for (let i = 0; i < 12; i++) {
      opened = await withTimeout(win.webContents.executeJavaScript(platformOf(slug) === 'twitch' ? twitchRedeemOpenScript() : pokeRedeemOpenScript('kick')), 8 * 1000).catch(() => null);
      if (opened && opened.loginRequired) {
        const platform = platformOf(slug);
        return {
          slug, status: 'skipped', reason: 'login-required',
          message: `${platform === 'kick' ? 'Kick' : 'Twitch'} desconectada nesta conta. Faça login pelo botão correspondente e tente novamente.`,
        };
      }
      if (opened && (opened.ready || opened.clicked)) break;
      await delay(500);
    }
    if (!opened || (!opened.ready && !opened.clicked)) {
      return { slug, status: 'skipped', message: 'Não encontrei o botão de pontos/recompensas.' };
    }
    let selected = null;
    for (let i = 0; i < 10 && !selected; i++) {
      await delay(i ? 500 : 900);
      const choice = await withTimeout(win.webContents.executeJavaScript(platformOf(slug) === 'twitch' ? twitchRedeemSelectScript(tipo, kickBefore) : pokeRedeemSelectScript(tipo)), 8 * 1000).catch(() => null);
      if (choice && choice.action === 'selected') selected = choice;
      else if (choice && choice.action === 'no-eligible') {
        return { slug, status: 'skipped', message: `O pacote de 1h por ${meta.cost.toLocaleString('pt-BR')} pontos não está disponível com o saldo atual.` };
      }
      else if (choice && choice.action === 'target-missing') {
        return { slug, status: 'skipped', message: `Não encontrei o pacote de 1h por ${meta.cost.toLocaleString('pt-BR')} pontos; não cliquei em pacotes maiores.` };
      }
      else if (choice && choice.action === 'too-expensive') {
        return { slug, status: 'skipped', message: `O pacote mais barato deste canal é de ${choice.hours} h por ${choice.cheapest.toLocaleString('pt-BR')} pontos; o saldo ainda não cobre.` };
      }
      else if (choice && choice.action === 'paused') {
        return { slug, status: 'skipped', reason: 'paused', panel: choice.panel || '', message: 'As recompensas deste canal estão pausadas pela Kick; passei para o próximo canal.' };
      }
    }
    if (!selected) return { slug, status: 'skipped', message: 'Não achei uma recompensa PokeIdle disponível.' };

    let confirmed = null;
    for (let i = 0; i < 8; i++) {
      await delay(i ? 500 : 350);
      const answer = platformOf(slug) === 'twitch'
        ? await withTimeout(win.webContents.executeJavaScript(twitchRedeemConfirmScript(tipo, selected.cost, REDEEM_DRYRUN)), 8 * 1000).catch(() => null)
        : REDEEM_DRYRUN ? { action: 'dry-run', label: '(Kick: o ensaio para antes de confirmar)' }
          : await withTimeout(win.webContents.executeJavaScript(pokeRedeemConfirmScript(tipo, selected.cost, 'kick')), 8 * 1000).catch(() => null);
      if (answer && answer.action !== 'waiting') { confirmed = answer; break; }
    }
    if (!confirmed || confirmed.action !== 'confirmed') {
      if (confirmed && confirmed.action === 'blocked') return { slug, status: 'skipped', message: 'A Twitch não deixa resgatar agora neste canal (limite de resgates ou tempo de espera).' };
      if (confirmed && confirmed.action === 'paused') return { slug, status: 'skipped', message: 'A recompensa está pausada ou temporariamente indisponível neste canal.' };
      if (confirmed && confirmed.action === 'dry-run') return { slug, status: 'skipped', reason: 'dry-run', message: `Ensaio: clicaria em "${confirmed.label}" (${selected.title || 'pacote de 1h'}, ${selected.cost} pts).` };
      if (confirmed && confirmed.action === 'unknown-button') return { slug, status: 'skipped', message: `Botão de resgate não reconhecido ("${confirmed.label}"); não cliquei.` };
      const message = confirmed && confirmed.action === 'insufficient'
        ? 'A loja indicou saldo insuficiente.'
        : confirmed && confirmed.action === 'mismatch-bonus'
          ? 'A confirmação aberta é de outro bônus; não enviei o resgate.'
        : confirmed && confirmed.action === 'mismatch'
          ? 'O preço exibido não bate com o pacote escolhido; não enviei o resgate.'
          : 'Não encontrei o formulário de resgate do bônus escolhido; não enviei o resgate.';
      return { slug, status: 'skipped', message };
    }

    let verified = false;
    let balanceAfter = null;
    if (platformOf(slug) === 'twitch') {
      // A Twitch confirma o resgate no chat. A janela fica aberta até a linha ser processada.
      for (let i = 0; i < 8 && !verified; i++) {
        await delay(1000);
        if (flush) await flush();
        verified = config.purchases.slice(twitchBefore).filter((p) => p.slug === slug && p.platform === 'twitch' && p.cost === meta.cost).length >= selected.hours;
      }
      if (!verified && storeWindows.has(slug)) {
        verified = config.purchases.slice(twitchBefore).filter((p) => p.slug === slug && p.platform === 'twitch' && p.cost === meta.cost).length >= selected.hours;
      }
    } else {
      pendingAutoKickPurchases.set(slug, {
        cost: selected.cost, costPerHour: meta.cost, hours: selected.hours, expiresAt: Date.now() + 5 * 60 * 1000,
      });
      for (let i = 0; i < 3 && !verified; i++) {
        await delay(i ? 1500 : 800);
        await refreshChannel(slug).catch(() => {});
        const after = (status.get(slug) || {}).points;
        if (after != null) balanceAfter = after;
        verified = kickBefore != null && after != null && kickBefore - after + 25 >= selected.cost;
      }
    }
    return {
      slug, status: verified ? 'redeemed' : 'submitted', cost: selected.cost, hours: selected.hours, balanceAfter,
      message: verified ? `Resgatado (${selected.hours} h).` : `Confirmação enviada (${selected.hours} h); a loja ainda não confirmou o resultado.`,
    };
  } catch (error) {
    return { slug, status: 'failed', message: String(error && error.message || error).slice(0, 180) };
  } finally {
    if (ownsWindow && win && !win.isDestroyed()) win.close();
  }
}

async function redeemPokeBonusSeries(job, slug, initialBalance) {
  const meta = POKE_REDEEM_META[job.type];
  const platform = platformOf(slug);
  const maxAttempts = Math.floor(initialBalance / meta.cost);
  let store = null;
  let balance = initialBalance;
  let redeemed = 0;
  let stopped = null;
  try {
    store = await openAutoStore(slug);
    await delay(1800);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (platform === 'kick' && balance == null) {
        const refreshed = await refreshChannel(slug).catch(() => null);
        balance = refreshed && refreshed.pointsRefreshed ? refreshed.points : null;
      }
      if (typeof balance !== 'number' || balance < meta.cost) break;
      job.current = {
        slug, label: (status.get(slug) || {}).displayName || nameOf(slug), platform,
        phase: 'redeeming', attempt: attempt + 1, attempts: maxAttempts,
      };
      send('status', snapshot());
      const result = await redeemPokeBonusInChannel(slug, job.type, balance, store);
      if (result.status !== 'redeemed') { stopped = result; break; }
      redeemed += result.hours || 1;
      balance = typeof result.balanceAfter === 'number' ? result.balanceAfter : Math.max(0, balance - (result.cost || meta.cost));
    }
  } catch (error) {
    stopped = { slug, status: 'failed', message: String(error && error.message || error).slice(0, 180) };
  } finally {
    if (store && store.win && !store.win.isDestroyed()) store.win.close();
  }
  if (!redeemed) return stopped || { slug, status: 'skipped', message: 'O saldo não cobre outro pacote de 1h.' };
  const reason = stopped && stopped.message ? ` Parei: ${stopped.message}` : '';
  return {
    slug, status: 'redeemed', cost: meta.cost, hours: redeemed,
    message: `Resgatado ${redeemed}x (${redeemed} h).${reason}`,
  };
}

async function runRedeemJob(job) {
  const blockedPlatforms = new Set();
  const minimum = POKE_REDEEM_META[job.type].cost;
  for (const slug of job.queue) {
    if (job.cancelRequested) break;
    const platform = platformOf(slug);
    let st = status.get(slug) || {};
    job.current = { slug, label: st.displayName || nameOf(slug), platform, phase: 'checking-points' };
    let result;
    if (blockedPlatforms.has(platform)) {
      result = { slug, status: 'skipped', reason: 'login-required', message: `Pulado: faça login na ${platform === 'kick' ? 'Kick' : 'Twitch'} desta conta para acessar as recompensas.` };
    } else {
      let balance = st.points;
      let balanceKnown = typeof balance === 'number';
      if (platform === 'kick') {
        const refreshed = await refreshChannel(slug).catch(() => null);
        st = status.get(slug) || st;
        balance = refreshed && refreshed.pointsRefreshed ? refreshed.points : null;
        balanceKnown = typeof balance === 'number';
      }
      if (!balanceKnown) {
        result = { slug, status: 'skipped', reason: 'points-unknown', message: 'Não consegui confirmar o saldo; não abri o chat deste canal.' };
      } else if (balance < minimum) {
        result = { slug, status: 'skipped', reason: 'insufficient-points', message: `Saldo ${balance.toLocaleString('pt-BR')}; precisa ter pelo menos ${minimum.toLocaleString('pt-BR')}. Não abri o chat.` };
      } else {
        job.current = { slug, label: st.displayName || nameOf(slug), platform, phase: 'opening-chat' };
        send('status', snapshot());
        result = await redeemPokeBonusSeries(job, slug, balance);
      }
    }
    if (result.reason === 'login-required') blockedPlatforms.add(platform);
    job.results.push({ ...result, label: st.displayName || nameOf(slug), platform: platformOf(slug) });
    job.done++;
    send('status', snapshot());
  }
  job.current = null;
  job.status = job.cancelRequested ? 'cancelled' : 'done';
  job.finishedAt = Date.now();
  const bought = job.results.filter((r) => r.status === 'redeemed').length;
  const units = job.results.reduce((sum, r) => sum + (r.status === 'redeemed' ? (r.hours || 1) : 0), 0);
  send('toast', `🎁 Resgate automático concluído: ${units} resgate(s) confirmado(s) em ${bought} canal(is).`);
}

function startRedeemJob(tipo, platform) {
  if (!POKE_REDEEM_META[tipo]) return { error: 'Escolha XP, Capture Boost ou Secret Lure.' };
  if (!['twitch', 'kick'].includes(platform)) return { error: 'Escolha Twitch ou Kick.' };
  if ([...redeemJobs.values()].some((j) => j.status === 'running' && j.platform === platform)) return { error: `Já existe um resgate automático da ${platform === 'twitch' ? 'Twitch' : 'Kick'} em andamento.` };
  const queue = [...new Set(config.channels)].filter((slug) => typeof slug === 'string' && platformOf(slug) === platform);
  if (!queue.length) return { error: `Esta conta não tem canais da ${platform === 'twitch' ? 'Twitch' : 'Kick'}.` };
  const job = {
    id: `redeem-${Date.now()}-${++redeemJobSeq}`, type: tipo, platform, status: 'running', queue,
    total: queue.length, done: 0, current: null, cancelRequested: false, results: [],
  };
  rememberRedeemJob(job);
  setImmediate(() => runRedeemJob(job).catch((error) => {
    job.status = 'failed'; job.error = String(error && error.message || error).slice(0, 180); job.current = null;
    send('status', snapshot());
    send('toast', 'O resgate automático parou por um erro.');
  }));
  return redeemJobSnapshot(job);
}

function getRedeemJob(id) {
  const job = redeemJobs.get(String(id || ''));
  return job ? redeemJobSnapshot(job) : { error: 'Resgate não encontrado.' };
}

function cancelRedeemJob(id) {
  const job = redeemJobs.get(String(id || ''));
  if (!job) return { error: 'Resgate não encontrado.' };
  if (job.status === 'running') job.cancelRequested = true;
  return redeemJobSnapshot(job);
}

// Procura, em qualquer lugar da mensagem, um bloco { twitch: { bonus } } ou { kick: { bonus } }.
function findPokeBonus(obj, depth = 0, out = {}) {
  if (!obj || typeof obj !== 'object' || depth > 6) return out;
  for (const platform of PLATFORMS) {
    const blk = obj[platform];
    if (blk && typeof blk === 'object' && blk.bonus && typeof blk.bonus === 'object' && !out[platform]) {
      const vals = {};
      for (const tipo of POKE_TIPOS) if (tipo in blk.bonus) vals[tipo] = Number(blk.bonus[tipo]) || 0;
      if (Object.keys(vals).length) out[platform] = vals;
    }
  }
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) {
    if (v && typeof v === 'object') findPokeBonus(v, depth + 1, out);
  }
  return out;
}

// O jogo fica DENTRO da janela do app, no lugar do chat, numa aba por conta do PokeIdle
// ("🎮 Principal", "🎮 alt1"...). Cada conta tem a própria sessão (login separado, uma não derruba a
// outra), como num navegador multiconta. Trocar para um canal só esconde o jogo, que continua
// rodando; o ✕ da aba encerra a sessão daquela conta no app.
const POKE_MAIN = 'principal';
// Regra do PokeIdle: no máximo 4 contas por pessoa (identificadas pelo IP). O app não deixa passar disso.
const POKE_MAX_ACCOUNTS = 4;
const POKEIDLE_FIX_CSS = `
  #mk-corpo .mk-grade > .mk-card { min-height: max-content; }
  #mk-corpo .mk-grade { grid-auto-rows: max-content; grid-template-rows: none; }
`;
const pokePartition = (id) => (id === POKE_MAIN ? POKEIDLE_PARTITION : `persist:pokeidle-${id}`);
const pokeLabel = (id) => (id === POKE_MAIN ? 'Principal' : id);
const pokeAccountIds = () => [POKE_MAIN, ...(config.pokeAccounts || []).filter((id) => /^[a-z0-9_-]{1,20}$/.test(id))];
const pokeViews = new Map(); // id -> WebContentsView
let pokeActive = null;        // conta do PokeIdle na tela (null = chat)
let pokeBounds = null;

const pokeIsOpen = (id) => { const v = pokeViews.get(id); return !!v && !v.webContents.isDestroyed(); };
const pokeOpen = () => pokeIsOpen(POKE_MAIN);

// Os bônus lidos do jogo vão para o painel quando a conta é a principal (é ela que farma aqui).
// As outras contas guardam o que foi lido para mostrar quando a aba delas estiver na tela.
function attachPokeReader(wc, id) {
  const dbg = wc.debugger;
  try { dbg.attach('1.3'); } catch {}
  dbg.on('message', (_e, method, p) => {
    if (method !== 'Network.webSocketFrameReceived') return;
    const text = p.response && p.response.payloadData;
    // Só mensagens que falam de twitch/kick (o jogo manda muita coisa por segundo).
    if (!text || text.length > 2_000_000 || !/"(twitch|kick)"/.test(text) || !text.includes('"bonus"')) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const found = findPokeBonus(msg);
    if (!Object.keys(found).length) return;
    if (id === POKE_MAIN) {
      for (const platform of Object.keys(found)) setPokeBonus(platform, found[platform], 'jogo');
      config.pokeReadAt = Date.now();
    } else {
      // A conta alt roda por trás: o bônus vai para o painel dela.
      if ((altCores.get(id) || {}).connected) proxy(id, 'poke:bonus', [found]).catch(() => {});
      const prev = (config.pokeBonusOthers || {})[id] || {};
      config.pokeBonusOthers = { ...(config.pokeBonusOthers || {}), [id]: { ...prev, ...found, readAt: Date.now() } };
    }
    saveConfig(); configDirty = false;
    send('status', snapshot());
    updateTray();
  });
  dbg.sendCommand('Network.enable').catch(() => {});
}

// Cada sessão de conta recebe as mesmas regras de segurança e as extensões do Chrome.
const preparedPokeSessions = new Map(); // partição -> Promise
function preparePokeSession(id) {
  const part = pokePartition(id);
  if (!preparedPokeSessions.has(part)) {
    if (id !== POKE_MAIN) setupPartition(part);
    preparedPokeSessions.set(part, loadPokeExtensionsInto(part));
  }
  return preparedPokeSessions.get(part);
}

async function ensurePokeView(id) {
  if (pokeIsOpen(id)) return pokeViews.get(id);
  await preparePokeSession(id).catch(() => {});
  if (pokeIsOpen(id)) return pokeViews.get(id);
  const view = new WebContentsView({ webPreferences: { partition: pokePartition(id), backgroundThrottling: false } });
  view.setBackgroundColor('#1b1b1b');
  if (!mainWin) return null;
  mainWin.contentView.addChildView(view);
  attachPokeReader(view.webContents, id);
  // Página do jogo que caiu: abre de novo (e o vigia avisa).
  view.webContents.on('render-process-gone', () => setImmediate(() => {
    if (pokeViews.get(id) === view && !app.isQuitting) reopenPokeAccount(id, 'caiu').catch(() => {}); // fechada de propósito: não reabre
  }));
  // Na área do app o Market espremia os cartões para caber na altura: o nome e o botão Comprar
  // ficavam cortados embaixo. Os cartões ficam com a altura deles e a grade rola.
  view.webContents.on('dom-ready', () => { view.webContents.insertCSS(POKEIDLE_FIX_CSS).catch(() => {}); });
  // F11 com o jogo em foco: liga/desliga o modo só o jogo (a tecla iria para o jogo).
  view.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'F11') { e.preventDefault(); send('focus-toggle'); } });
  view.webContents.loadURL(POKEIDLE_URL);
  view.setVisible(false);
  pokeViews.set(id, view);
  return view;
}

// Modo grade: os PokeIdle de todas as contas abertas lado a lado (2x2 com 4 contas), cada um com
// zoom reduzido para caber. Fora dele, só o da conta escolhida, em tamanho normal.
let pokeGrid = false;
const POKE_FULL_WIDTH = 1400; // largura em que o jogo fica confortável sem zoom
function applyPokeBounds() {
  if (!pokeActive || !pokeBounds) return;
  const r = pokeBounds;
  const box = (x, y, w, h) => ({ x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) });
  if (!pokeGrid) {
    if (!pokeIsOpen(pokeActive)) return;
    const v = pokeViews.get(pokeActive);
    v.setBounds(box(r.x, r.y, r.width, r.height));
    v.webContents.setZoomFactor(1);
    return;
  }
  const ids = pokeAccountIds().filter(pokeIsOpen);
  const cols = Math.ceil(Math.sqrt(ids.length)), rows = Math.ceil(ids.length / cols);
  const gap = 4, w = (r.width - gap * (cols - 1)) / cols, h = (r.height - gap * (rows - 1)) / rows;
  const zoom = Math.max(0.35, Math.min(1, w / POKE_FULL_WIDTH));
  ids.forEach((id, i) => {
    const v = pokeViews.get(id);
    v.setBounds(box(r.x + (i % cols) * (w + gap), r.y + Math.floor(i / cols) * (h + gap), w, h));
    v.webContents.setZoomFactor(zoom);
    v.setVisible(true);
  });
}

async function showPokeIdle(id = POKE_MAIN, bounds) {
  if (!pokeAccountIds().includes(id)) return;
  if (bounds) pokeBounds = bounds;
  if (!pokeGrid) for (const [other, v] of pokeViews) if (other !== id && !v.webContents.isDestroyed()) v.setVisible(false);
  const view = await ensurePokeView(id);
  pokeActive = id;
  applyPokeBounds();
  view.setVisible(true);
  view.webContents.focus();
  // Voltou para a tela: sai do ULTRA do fundo e volta ao modo escolhido.
  pokeHiddenSince.delete(id);
  applyPokeMode(id).catch(() => {});
}

function hidePokeIdle() {
  for (const v of pokeViews.values()) if (!v.webContents.isDestroyed()) v.setVisible(false);
  pokeActive = null;
}

function closePokeIdle(id = POKE_MAIN) {
  const view = pokeViews.get(id);
  pokeViews.delete(id);
  if (pokeActive === id) pokeActive = null;
  // Na grade, as contas que sobraram ocupam o espaço da que fechou.
  if (pokeGrid && pokeActive) setImmediate(applyPokeBounds);
  if (view) {
    try { if (mainWin) mainWin.contentView.removeChildView(view); } catch {}
    try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch {}
  }
  send('status', snapshot());
}

function pokeIdleSnapshot() {
  const others = config.pokeBonusOthers || {};
  return {
    open: pokeOpen(), visible: !!pokeActive, active: pokeActive, grid: pokeGrid,
    accounts: pokeAccountIds().map((id) => ({ id, label: pokeLabel(id), open: pokeIsOpen(id), bonus: id === POKE_MAIN ? null : (others[id] || null) })),
    readAt: config.pokeReadAt || null,
    source: { twitch: pokeBase('twitch').source || null, kick: pokeBase('kick').source || null },
    contas: pokeAccountsSummary(), settings: pokeSettings(), max: POKE_MAX_ACCOUNTS,
  };
}

// ---------- Contas do PokeIdle: modo, leitura, vigia e reabrir ----------
// A cada minuto o app passa pelas contas do PokeIdle abertas no app:
// - lê do jogo nick, nível, ouro e o placar da sessão de caça (o mesmo que o jogo grava);
// - ajusta o modo de tela do próprio jogo (Cena, Otimizado, Economia, ULTRA). As contas que estão
//   fora da tela há alguns minutos vão para o ULTRA, se a pessoa ligar isso (bem menos memória e CPU);
// - vigia: avisa (no PC e, se configurado, no celular pelo ntfy ou no Discord) quando a conta
//   deslogou, travou ou está logada sem ganhar XP;
// - reabre sozinha a página que travou e, se pedido, recarrega as contas de tempos em tempos.
const POKE_MODES = {
  cena: { 'cfg-otimizado': '0', 'cfg-economia': '0', 'cfg-ultra': '0' },
  otimizado: { 'cfg-otimizado': '1', 'cfg-economia': '0', 'cfg-ultra': '0' },
  economia: { 'cfg-otimizado': '0', 'cfg-economia': '1', 'cfg-ultra': '0' },
  ultra: { 'cfg-otimizado': '0', 'cfg-economia': '0', 'cfg-ultra': '1' },
};
const POKE_MODE_NAMES = { cena: 'Cena', otimizado: 'Otimizado', economia: 'Economia', ultra: 'ULTRA' };
const POKE_WATCH_MS = 60 * 1000;
const pokeInfo = new Map();        // id -> última leitura { at, logged, nick, level, gold, xpH, sessXp, mode, problem }
const pokeHiddenSince = new Map(); // id -> desde quando a conta está fora da tela
const pokeXpSince = new Map();     // id -> { xp, at }: último momento em que o XP da sessão subiu
const pokeAlerted = new Map();     // id -> problema já avisado (um aviso por problema, até resolver)
const pokeLastReload = new Map();  // id -> última vez que a conta foi recarregada (otimizar)
const pokeFails = new Map();       // id -> leituras seguidas sem resposta

const pokeSettings = () => ({
  autoUltra: config.pokeAutoUltra !== false, // ligado por padrão (menos memória e CPU)
  ultraDelayMin: config.pokeUltraDelayMin || 3,
  optimizeMin: config.pokeOptimizeMin ?? 240, // a cada 4 h por padrão
  startGrid: config.pokeStartGrid !== false, // ao abrir o app, todos os PokeIdle em grade
  vigia: { on: config.pokeVigia !== false, paradaMin: config.pokeParadaMin || 10, ntfy: config.pokeNtfy || '', discord: config.pokeDiscord || '' },
});
const pokeChosenMode = (id) => ((config.pokeModes || {})[id] in POKE_MODES ? config.pokeModes[id] : 'cena');
const pokeOnScreen = (id) => pokeIsOpen(id) && pokeViews.get(id).getVisible();

function pokeWantedMode(id) {
  if (pokeOnScreen(id)) return pokeChosenMode(id);
  if (config.pokeAutoUltra === false) return pokeChosenMode(id);
  const since = pokeHiddenSince.get(id);
  return since && Date.now() - since >= (config.pokeUltraDelayMin || 3) * 60 * 1000 ? 'ultra' : pokeChosenMode(id);
}

// Grava as preferências do jogo e recarrega a página só quando elas mudaram.
async function applyPokeMode(id) {
  if (!pokeIsOpen(id)) return;
  const want = POKE_MODES[pokeWantedMode(id)];
  const wc = pokeViews.get(id).webContents;
  const changed = await withTimeout(wc.executeJavaScript(`(() => { const p = ${JSON.stringify(want)}; let c = false;
    for (const k in p) if (localStorage.getItem(k) !== p[k]) { localStorage.setItem(k, p[k]); c = true; } return c; })()`), 10 * 1000).catch(() => false);
  if (changed) { pokeLastReload.set(id, Date.now()); wc.reload(); }
}

const POKE_READ_SCRIPT = `(() => {
  const q = (s) => document.querySelector(s);
  const txt = (s) => { const e = q(s); const t = e ? e.textContent.trim().replace(/\\s+/g, ' ') : ''; return t && t !== '—' ? t : null; };
  let token = false; try { const x = JSON.parse(localStorage.getItem('sessao') || 'null'); token = !!(x && x.token); } catch {}
  const app = q('#app');
  const nick = txt('#tr-nick');
  let sess = null;
  try { const o = nick && JSON.parse(localStorage.getItem('sessao-hunt:' + nick.toLowerCase()) || 'null'); if (o && o.ms > 0) sess = { ms: o.ms, xp: +o.xpTreinador || 0, gold: +o.gold || 0, abates: +o.abates || 0, capturas: +o.capturas || 0 }; } catch {}
  return {
    logged: (!!app && !app.classList.contains('hidden')) || token,
    loginScreen: !token && !!q('input[type="password"]'),
    nick, level: txt('#tr-level'), gold: txt('#tr-gold'), xp: txt('#tr-xp-txt'), sess,
    mode: document.documentElement.classList.contains('modo-ultra') ? 'ultra'
      : localStorage.getItem('cfg-economia') === '1' ? 'economia' : localStorage.getItem('cfg-otimizado') === '1' ? 'otimizado' : 'cena',
  };
})()`;

async function pokeAlert(id, problem, text) {
  if (pokeAlerted.get(id) === problem) return; // já avisado; volta a avisar quando resolver e acontecer de novo
  pokeAlerted.set(id, problem);
  const vig = pokeSettings().vigia;
  if (!vig.on) return;
  const title = `PokeIdle — ${pokeLabel(id)}`;
  notify(title, text, () => { showMain(); });
  if (vig.ntfy) net.fetch(`https://ntfy.sh/${encodeURIComponent(vig.ntfy)}`, { method: 'POST', body: `${title}: ${text}`, headers: { Title: 'TK MultiStream' } }).catch(() => {});
  if (/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(vig.discord)) {
    net.fetch(vig.discord, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${title}**: ${text}` }) }).catch(() => {});
  }
}
const pokeResolved = (id) => pokeAlerted.delete(id);

// Página que não responde (travou): fecha e abre de novo, no mesmo lugar.
async function reopenPokeAccount(id, motivo) {
  const wasOnScreen = pokeOnScreen(id);
  closePokeIdle(id);
  await ensurePokeView(id).catch(() => {});
  pokeFails.delete(id);
  pokeLastReload.set(id, Date.now());
  if (wasOnScreen && pokeBounds) await showPokeIdle(id, pokeBounds).catch(() => {});
  else applyPokeBounds();
  pokeAlert(id, 'reaberta', `A página da conta ${motivo}; o app abriu de novo.`);
}

async function watchPokeAccount(id) {
  if (!pokeIsOpen(id)) { pokeInfo.delete(id); pokeHiddenSince.delete(id); return; }
  const now = Date.now();
  if (pokeOnScreen(id)) pokeHiddenSince.delete(id); else if (!pokeHiddenSince.has(id)) pokeHiddenSince.set(id, now);
  const wc = pokeViews.get(id).webContents;
  const r = await withTimeout(wc.executeJavaScript(POKE_READ_SCRIPT), 15 * 1000).catch(() => null);
  if (!r) {
    const n = (pokeFails.get(id) || 0) + 1;
    pokeFails.set(id, n);
    if (n >= 2 && !wc.isLoading()) return reopenPokeAccount(id, 'travou (não respondia)');
    return;
  }
  pokeFails.delete(id);
  const prev = pokeInfo.get(id) || {};
  const info = { at: now, logged: !!r.logged, nick: r.logged ? (r.nick || prev.nick || null) : null, level: r.logged ? (r.level || prev.level || null) : null, gold: r.logged ? (r.gold || prev.gold || null) : null,
    mode: r.mode, xpH: r.sess && r.sess.ms > 60000 ? Math.round(r.sess.xp / r.sess.ms * 3600e3) : null, sessXp: r.sess ? r.sess.xp : null,
    abates: r.sess ? r.sess.abates : null, capturas: r.sess ? r.sess.capturas : null, problem: null };
  // XP parado: o placar da sessão não sobe há X minutos (com a conta logada).
  if (info.sessXp != null) {
    const last = pokeXpSince.get(id);
    if (!last || info.sessXp !== last.xp) pokeXpSince.set(id, { xp: info.sessXp, at: now });
  }
  const parada = pokeXpSince.get(id);
  const paradaMin = pokeSettings().vigia.paradaMin;
  if (prev.logged && !info.logged) info.problem = 'deslogou';
  else if (info.logged && parada && now - parada.at >= paradaMin * 60 * 1000) info.problem = 'parada';
  pokeInfo.set(id, info);
  if (info.problem === 'deslogou') pokeAlert(id, 'deslogou', 'A conta saiu do jogo (deslogou ou caiu). Abra o PokeIdle dela e entre de novo.');
  else if (info.problem === 'parada') pokeAlert(id, 'parada', `Logada, mas sem ganhar XP há ${paradaMin} min. Confira se está numa hunt.`);
  else pokeResolved(id);
  await applyPokeMode(id);
  // Otimizar: recarrega a conta de tempos em tempos (só fora da tela), para liberar memória.
  const every = (config.pokeOptimizeMin ?? 240) * 60 * 1000;
  if (every && !pokeOnScreen(id) && now - (pokeLastReload.get(id) || now - every) >= every && info.logged) {
    pokeLastReload.set(id, now);
    wc.reload();
  }
}

let pokeWatching = false;
async function watchPokeAccounts() {
  if (pokeWatching || ACCOUNT) return;
  pokeWatching = true;
  try { for (const id of pokeAccountIds()) await watchPokeAccount(id).catch(() => {}); } finally { pokeWatching = false; }
  send('status', snapshot());
}

function pokeAccountsSummary() {
  return pokeAccountIds().map((id) => {
    const i = pokeInfo.get(id) || {};
    return { id, label: pokeLabel(id), open: pokeIsOpen(id), mode: pokeChosenMode(id), modeNow: i.mode || null,
      nick: i.nick || null, level: i.level || null, gold: i.gold || null, xpH: i.xpH, abates: i.abates, capturas: i.capturas,
      logged: i.logged ?? null, problem: i.problem || null, readAt: i.at || null };
  });
}

ipcMain.handle('poke:setMode', async (_e, id, mode) => {
  if (pokeAccountIds().includes(id) && POKE_MODES[mode]) {
    config.pokeModes = { ...(config.pokeModes || {}), [id]: mode };
    saveConfig();
    await applyPokeMode(id);
  }
  return snapshot();
});
ipcMain.handle('poke:settings', (_e, patch = {}) => {
  if ('autoUltra' in patch) config.pokeAutoUltra = !!patch.autoUltra;
  if ('startGrid' in patch) config.pokeStartGrid = !!patch.startGrid;
  if ('optimizeMin' in patch) config.pokeOptimizeMin = [0, 60, 120, 240, 360].includes(Number(patch.optimizeMin)) ? Number(patch.optimizeMin) : 0;
  if ('vigiaOn' in patch) config.pokeVigia = !!patch.vigiaOn;
  if ('paradaMin' in patch) config.pokeParadaMin = [5, 10, 15, 30].includes(Number(patch.paradaMin)) ? Number(patch.paradaMin) : 10;
  if ('ntfy' in patch) config.pokeNtfy = String(patch.ntfy || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if ('discord' in patch) { const d = String(patch.discord || '').trim(); config.pokeDiscord = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[\w/-]+$/.test(d) ? d : ''; }
  saveConfig();
  for (const id of pokeAccountIds()) applyPokeMode(id).catch(() => {});
  return snapshot();
});
ipcMain.handle('poke:testAlert', () => {
  pokeAlerted.delete('teste');
  const saved = config.pokeVigia;
  config.pokeVigia = true;
  pokeAlert('teste', 'teste', 'Teste do vigia: os avisos estão chegando.');
  config.pokeVigia = saved;
  pokeAlerted.delete('teste');
  return true;
});

// ---------- Extensões do Chrome no PokeIdle ----------
// Extensões que a pessoa já usa no Chrome para o PokeIdle rodam também no jogo aberto no app.
// O app lê a versão mais nova direto da pasta do Chrome (quando o Chrome atualiza, o app pega na
// próxima vez que abrir) e carrega em cada sessão de conta do PokeIdle.
const POKE_EXTENSIONS = [
  { id: 'mhnplloljgchpfpcpbhmcokmnefodjnh', name: '/hunt for PokeIdle' },
  { id: 'olccbpdjdkbfgondiiaicmlifhbcggmk', name: 'Rotom Sniper', cockpit: 'cockpit.html' },
];
const loadedPokeExtensions = []; // { id, name, cockpit, extId, version } (da conta principal)

function chromeExtensionDir(id) {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  let profiles = [];
  try { profiles = fs.readdirSync(base).filter((d) => d === 'Default' || /^Profile \d+$/.test(d)); } catch { return null; }
  for (const prof of profiles) {
    const dir = path.join(base, prof, 'Extensions', id);
    let versions = [];
    try { versions = fs.readdirSync(dir).filter((v) => fs.existsSync(path.join(dir, v, 'manifest.json'))); } catch { continue; }
    // "1.5.2_0" > "1.10.0_0" errado em ordem de texto: compara número por número.
    const num = (v) => v.split(/[._]/).map(Number);
    versions.sort((a, b) => { const x = num(a), y = num(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; });
    if (versions[0]) return path.join(dir, versions[0]);
  }
  return null;
}

async function loadPokeExtensionsInto(partition) {
  const ses = session.fromPartition(partition);
  const api = ses.extensions || ses; // Electron novo: ses.extensions; antigo: na própria sessão
  for (const ext of POKE_EXTENSIONS) {
    const dir = chromeExtensionDir(ext.id);
    if (!dir) continue;
    try {
      const loaded = await api.loadExtension(dir, { allowFileAccess: false });
      if (partition === POKEIDLE_PARTITION) loadedPokeExtensions.push({ ...ext, extId: loaded.id, version: loaded.version });
    } catch (e) {
      if (process.env.KICKTERINO_DEBUG) console.log(`EXT falhou ${ext.name} em ${partition}: ${e.message}`);
    }
  }
  send('status', snapshot());
}
const loadPokeExtensions = () => preparePokeSession(POKE_MAIN);

// O Cockpit do Rotom Sniper: no Chrome abre pelo ícone da extensão; aqui, pelo botão do painel.
// Abre na sessão da conta do PokeIdle que estiver na tela (ou da principal).
let cockpitWin = null;
let cockpitAccount = null;
async function openCockpit(id) {
  const ext = loadedPokeExtensions.find((e) => e.id === id && e.cockpit);
  if (!ext) return;
  const account = pokeActive || POKE_MAIN;
  if (cockpitWin && !cockpitWin.isDestroyed()) {
    if (cockpitAccount === account) { cockpitWin.show(); cockpitWin.focus(); return; }
    cockpitWin.destroy();
  }
  await preparePokeSession(account).catch(() => {});
  cockpitAccount = account;
  cockpitWin = new BrowserWindow({
    width: 1160, height: 760, title: `${ext.name} — Cockpit (${pokeLabel(account)})`, autoHideMenuBar: true, backgroundColor: '#111',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { partition: pokePartition(account) },
  });
  cockpitWin.loadURL(`chrome-extension://${ext.extId}/${ext.cockpit}`);
  cockpitWin.on('page-title-updated', (e) => e.preventDefault());
  cockpitWin.on('closed', () => { cockpitWin = null; cockpitAccount = null; });
}

// Relatório dos últimos 7 dias: pontos por dia, compras e tempo com bônus ativo por período.
const PERIODS = [['Madrugada', 0, 6], ['Dia', 6, 18], ['Noite', 18, 24]];
function weeklyReport(now = Date.now()) {
  const from = now - 7 * DAY_MS;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const t = now - i * DAY_MS, k = dayKey(t);
    const bought = config.purchases.filter((p) => dayKey(p.t) === k);
    days.push({ day: k, weekday: new Date(t).toLocaleDateString('pt-BR', { weekday: 'short' }), gained: config.daily[k] || 0,
      bought: BONUSES.map((b) => bought.filter((p) => p.cost === b.cost).length) });
  }
  // Minuto a minuto: há algum bônus ativo? (qualquer um dos três)
  const all = Object.values(bonusIntervals()).flat();
  const isOn = (t) => all.some((i) => i.start <= t && i.end > t);
  const per = PERIODS.map(([name]) => ({ name, on: 0, total: 0 }));
  let on = 0, total = 0;
  for (let t = Math.ceil(from / 60000) * 60000; t < now; t += 60000) {
    const h = new Date(t).getHours();
    const p = per[PERIODS.findIndex(([, a, b]) => h >= a && h < b)];
    const active = isOn(t);
    p.total++; total++;
    if (active) { p.on++; on++; }
  }
  // Últimas 24 h em blocos de 30 min, para a linha do tempo.
  const timeline = [];
  for (let i = 47; i >= 0; i--) timeline.push(isOn(now - i * 30 * 60000 - 15 * 60000));
  const recent = config.purchases.filter((p) => p.t >= from);
  return {
    days, timeline, timelineStart: now - DAY_MS,
    gained: days.reduce((t, d) => t + d.gained, 0),
    bought: BONUSES.map((b) => ({ name: b.name, cost: b.cost, count: recent.filter((p) => p.cost === b.cost).length })),
    bonusHours: Math.round(on / 60),
    coverage: total ? Math.round((on / total) * 100) : 0,
    periods: per.map((p) => ({ name: p.name, pct: p.total ? Math.round((p.on / p.total) * 100) : 0 })),
    channels: new Set(recent.map((p) => p.slug).filter(Boolean)).size,
  };
}

// Lista de parceiros no site: parceiro novo entra para todos sem precisar de versão nova.
// Quem a pessoa removeu não volta (mesma regra dos canais padrão).
const PARTNERS_URL = 'https://viinnisantoos.github.io/kickterino/parceiros.json';
async function syncPartners() {
  try {
    const res = await net.fetch(PARTNERS_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const list = ((await res.json()).channels || []).map(String).filter((s) => /^[a-z0-9_-]{2,30}$/.test(s)).slice(0, 60);
    const seen = new Set(config.seenDefaults || []);
    const fresh = list.filter((slug) => !seen.has(slug) && !config.channels.includes(slug));
    config.seenDefaults = [...new Set([...seen, ...list])];
    if (fresh.length) { config.channels.push(...fresh); poll(); }
    saveConfig();
  } catch {}
}

// ---------- Twitch ----------
// Chat: IRC oficial (só leitura sem token; com o token da pessoa, também envia).
const twitchChat = new twitch.TwitchChat({
  onMessage: (login, data) => send('chat', { slug: `twitch:${login}`, kind: 'message', data }),
  onNotice: (login, text) => {
    if (login) send('chat', { slug: `twitch:${login}`, kind: 'notice', data: { text } });
    else send('toast', text);
  },
  onState: () => send('status', snapshot()),
});
let twitchUser = null;       // login da conta conectada ao chat (token OAuth)
let twitchLoggedIn = false;  // sessão do site (as lives ocultas contam pontos para essa conta)
let twitchStatusError = null;
// Toda chamada à API da Twitch tem prazo: sem isso, uma resposta que nunca chega prendia a rodada
// de atualização inteira (o app parava de atualizar lives e pontos).
const TWITCH_TIMEOUT_MS = 15 * 1000;
const twitchFetch = (url, opts = {}) => withTimeout(net.fetch(url, { ...opts, signal: AbortSignal.timeout(TWITCH_TIMEOUT_MS) }), TWITCH_TIMEOUT_MS + 2000);
const twitchKeys =() => config.channels.filter((k) => platformOf(k) === 'twitch');
const hasTwitchApi = () => !!(config.twitchClientId && config.twitchClientSecret);

function syncTwitchChat() {
  if (HEADLESS) return; // o chat da Twitch é da janela principal (os canais são os mesmos)
  twitchChat.setChannels(twitchKeys().map(nameOf));
}

async function syncTwitchAuth() {
  if (!config.twitchToken) { twitchUser = null; twitchChat.setAuth(null); return; }
  try {
    const info = await twitch.validateUserToken(twitchFetch, config.twitchToken);
    if (!info) { config.twitchToken = ''; saveConfig(); twitchUser = null; twitchChat.setAuth(null); return; }
    twitchUser = info.login;
    twitchChat.setAuth({ login: info.login, token: config.twitchToken });
  } catch {} // sem internet: mantém o que tinha
}

async function twitchSessionLoggedIn() {
  const cookies = await session.fromPartition(TWITCH_PARTITION).cookies.get({ url: TWITCH, name: 'auth-token' });
  return !!(cookies[0] && cookies[0].value);
}

// Quem está ao vivo, pela API Helix (precisa do app da pessoa no Developer Console).
async function refreshTwitch() {
  const keys = twitchKeys();
  for (const key of keys) {
    const s = status.get(key) || { watchedMs: 0 };
    s.displayName = s.displayName || nameOf(key);
    s.chatroomId = key; // a interface usa isso para liberar o campo de mensagem
    status.set(key, s);
  }
  if (!keys.length) return;
  if (!hasTwitchApi()) {
    twitchStatusError = 'Configure a API da Twitch para saber quem está ao vivo';
    for (const key of keys) { const s = status.get(key); s.live = undefined; s.error = null; }
    return;
  }
  try {
    const live = await twitch.fetchLive(twitchFetch, { clientId: config.twitchClientId, clientSecret: config.twitchClientSecret }, keys.map(nameOf));
    twitchStatusError = null;
    for (const key of keys) {
      const s = status.get(key);
      const info = live[nameOf(key).toLowerCase()];
      const wasLive = s.live;
      s.live = !!info;
      if (wasLive === false && s.live && config.favorites.includes(key)) {
        notify(`★ ${info.displayName} entrou ao vivo`, info.title || 'Clique para abrir o chat.', () => { showMain(); send('select', key); });
      }
      s.viewers = info ? info.viewers : 0;
      s.title = info ? info.title : '';
      if (info) s.displayName = info.displayName;
      s.error = null;
    }
  } catch (e) {
    twitchStatusError = `API da Twitch: ${e.message || e}`;
    for (const key of keys) status.get(key).error = twitchStatusError;
  }
}

async function refreshChannel(slug) {
  if (platformOf(slug) === 'twitch') return { points: (status.get(slug) || {}).points ?? null, pointsRefreshed: false }; // a Twitch é consultada em lote (refreshTwitch)
  const s = status.get(slug) || { watchedMs: 0 };
  let pointsRefreshed = false;
  try {
    const { status: code, json } = await kickFetch(`/api/v2/channels/${slug}`);
    if (code !== 200 || !json) throw new Error(`HTTP ${code}`);
    s.chatroomId = json.chatroom && json.chatroom.id;
    const wasLive = s.live;
    s.live = !!json.livestream;
    // Favorito que acabou de entrar ao vivo (no primeiro carregamento não avisa).
    if (wasLive === false && s.live && config.favorites.includes(slug)) {
      const name = (json.user && json.user.username) || slug;
      notify(`★ ${name} entrou ao vivo`, json.livestream.session_title || 'Clique para abrir o chat.', () => { showMain(); send('select', slug); });
    }
    s.viewers = json.livestream ? json.livestream.viewer_count : 0;
    s.title = json.livestream ? json.livestream.session_title : '';
    s.displayName = (json.user && json.user.username) || slug;
    s.error = null;
  } catch (e) {
    s.error = String(e.message || e);
  }
  // Se a conta segue o canal (só logado) — para conferir se seguir influencia nos pontos.
  try {
    const { status: code, json } = await kickFetch(`/api/v2/channels/${slug}/me`);
    if (code === 200 && json && typeof json.is_following === 'boolean') s.following = json.is_following;
    // Quem é sub ganha o dobro de pontos naquele canal (20 a cada 5 min).
    if (code === 200 && json && 'subscription' in json) s.subscribed = !!json.subscription;
  } catch {}
  // Saldo de pontos — endpoint não documentado; se falhar, só mostramos "—".
  try {
    const { status: code, json } = await kickFetch(`/api/v2/channels/${slug}/points`);
    if (code === 200 && json) {
      const p = json.data ? json.data.points : json.points;
      if (typeof p === 'number') {
        // Ganho de assistir (gastos na loja fazem o saldo cair e não contam).
        if (s.points != null && p > s.points) {
          s.gainedTotal = (s.gainedTotal || 0) + (p - s.points);
          if (watchers.has(slug)) s.lastGainAt = Date.now();
          addDaily(p - s.points);
        }
        if (s.points != null && p < s.points) {
          const drop = s.points - p;
          const pending = pendingAutoKickPurchases.get(slug);
          if (pending && pending.expiresAt > Date.now() && drop + 25 >= pending.cost) {
            addKnownPurchase(slug, pending.costPerHour, pending.hours, 'auto');
            pendingAutoKickPurchases.delete(slug);
            const unexplained = drop - pending.cost;
            if (unexplained > 25) registerPurchases(slug, unexplained);
          } else {
            if (pending) pendingAutoKickPurchases.delete(slug);
            registerPurchases(slug, drop);
          }
        }
        s.points = p;
        pointsRefreshed = true;
        checkBonus(slug, s);
      }
    }
  } catch {}
  status.set(slug, s);
  return { points: s.points ?? null, pointsRefreshed };
}

// Confere cada live oculta: aviso +18 (só a pessoa pode confirmar) e estado do player, para o
// histórico. O tempo do vídeo NÃO indica se a live conta: no player da Kick ele fica em 0–1 s
// mesmo com os pontos subindo, então quem diz se está valendo é o saldo (ver lastGainAt).
// ---------- Twitch: saldo e baú de bônus na página da live ----------
// A cada rodada o app olha o resumo de pontos do chat da live (a mesma página que está tocando):
// lê o saldo e, se o baú de bônus (+50) estiver disponível, clica nele, como a pessoa faria.
const TWITCH_PAGE_SCRIPT = `(() => {
  const q = (sel) => document.querySelector(sel);
  // Chat recolhido: abre (é nele que ficam o saldo e o baú).
  let expanded = false;
  const toggle = q('[data-a-target="right-column__toggle-collapse-btn"]');
  if (toggle && !q('[data-a-target="chat-input"], .chat-input, [data-a-target="chat-scroller"]')
    && /expand|expandir|mostrar/i.test(toggle.getAttribute('aria-label') || '')) { toggle.click(); expanded = true; }
  let btn = null;
  const icon = q('.claimable-bonus__icon');
  if (icon) btn = icon.closest('button');
  if (!btn) btn = [...document.querySelectorAll('button[aria-label]')]
    .find((b) => /claim bonus|resgatar b[oô]nus|coletar b[oô]nus|obter b[oô]nus/i.test(b.getAttribute('aria-label') || ''));
  let claimed = false;
  if (btn && !btn.disabled) { btn.click(); claimed = true; }
  // "copo" = community points (nome atual na Twitch); "balance-string" era o antigo.
  const bal = q('[data-test-selector="copo-balance-string"]') || q('[data-test-selector="balance-string"]');
  return {
    claimed,
    balance: bal ? bal.textContent.trim() : null,
    summary: !!q('[data-test-selector="community-points-summary"], .community-points-summary'),
    expanded,
    // Diagnóstico curto (vai para o histórico): ajuda a ver por que o saldo não apareceu.
    diag: {
      w: innerWidth, h: innerHeight,
      chat: !!q('[data-a-target="chat-input"], .chat-input, [data-a-target="chat-scroller"]'),
      toggle: (q('[data-a-target="right-column__toggle-collapse-btn"]') || {}).ariaLabel || null,
      logged: !!q('[data-a-target="user-menu-toggle"]'),
      cp: [...document.querySelectorAll('[class*="community-points"], [data-test-selector*="points"]')].slice(0, 4).map((e) => (e.getAttribute('data-test-selector') || e.className || '').toString().slice(0, 50)),
      btns: [...document.querySelectorAll('.chat-input button, [class*="chat-input"] button, .right-column button')].map((b) => (b.getAttribute('aria-label') || b.getAttribute('data-a-target') || b.textContent || '').trim().slice(0, 40)).filter(Boolean).slice(0, 25),
      sels: [...new Set([...document.querySelectorAll('.chat-input [data-test-selector], [class*="chat-input"] [data-test-selector]')].map((e) => e.getAttribute('data-test-selector')))].slice(0, 20),
    },
  };
})()`;

// "850" -> 850 (exato); "1,2 mil" / "1.2K" -> 1200 (aproximado); "3,4 mi" / "3.4M" -> 3.400.000.
function parseTwitchPoints(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().replace(/\s+/g, '');
  const mult = /(mi|m)$/.test(t) && !/mil$/.test(t) ? 1e6 : /(mil|k)$/.test(t) ? 1e3 : 1;
  if (mult === 1) {
    const n = Number(t.replace(/[^\d]/g, ''));
    return Number.isFinite(n) && /\d/.test(t) ? { value: n, approx: false } : null;
  }
  const n = Number(t.replace(/[a-z]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? { value: Math.round(n * mult), approx: true } : null;
}

async function checkTwitchPage(slug, win, s) {
  const info = await withTimeout(win.webContents.executeJavaScript(TWITCH_PAGE_SCRIPT), 10 * 1000).catch(() => null);
  if (!info) return;
  s.chatVisible = info.summary;
  s.twitchDiag = { ...info.diag, expanded: info.expanded, balance: info.balance };
  if (info.claimed) {
    s.bonusClaims = (s.bonusClaims || 0) + 1;
    s.lastClaimAt = Date.now();
    if (process.env.KICKTERINO_DEBUG) console.log(`BAU ${slug}`);
  }
  const p = parseTwitchPoints(info.balance);
  if (!p) return;
  // Só conta ganho com número exato dos dois lados (o arredondado sobe e desce sozinho).
  if (!p.approx && s.points != null && !s.pointsApprox && p.value > s.points) {
    s.gainedTotal = (s.gainedTotal || 0) + (p.value - s.points);
    s.lastGainAt = Date.now();
    addDaily(p.value - s.points);
  }
  // Saldo caiu (bônus comprado na loja da Twitch): entra no cronômetro, como na Kick. Com número
  // arredondado (acima de 1.000) só vale queda grande, e a combinação de bônus tem de bater.
  if (s.points != null && p.value < s.points) {
    // O que a janela de pontos já registrou (resgate lido do chat) não conta de novo.
    const drop = s.points - p.value - (s.expectedDrop || 0);
    s.expectedDrop = 0;
    // Sem o resgate lido, só dá para ter certeza de 1 h de um bônus (300, 500 ou 1.000): pacotes de
    // horas têm várias combinações possíveis, e aí o app avisa em vez de chutar.
    const single = BONUSES.find((b) => drop >= b.cost && drop <= b.cost + 25);
    if (single && !p.approx && !s.pointsApprox) { registerPurchases(slug, drop); updateTray(); }
    else if (drop >= 280) {
      notify(`${s.displayName || nameOf(slug)}: -${drop.toLocaleString('pt-BR')} pontos na Twitch`,
        'Não deu para saber quais bônus foram comprados. Clique no tempo do bônus no painel e digite quanto falta.', showMain);
    }
  }
  s.points = p.value;
  s.pointsReadAt = Date.now();
  s.pointsApprox = p.approx;
}

async function checkPlayers() {
  for (const [slug, win] of watchers) {
    const s = status.get(slug);
    if (!s || win.isDestroyed() || userOpened.has(win)) continue;
    const gateSelector = platformOf(slug) === 'twitch'
      ? '[data-a-target="player-overlay-mature-accept"], [data-a-target="content-classification-gate-overlay-start-watching-button"]'
      : '[data-testid="mature"]';
    const info = await withTimeout(win.webContents.executeJavaScript(`(() => {
      const v = document.querySelector('video');
      return {
        gate: !!document.querySelector(${JSON.stringify(gateSelector)}),
        visibility: document.visibilityState,
        video: v ? { paused: v.paused, time: Math.round(v.currentTime), height: v.videoHeight, ready: v.readyState } : null,
      };
    })()`), PLAYER_CHECK_MS).catch((err) => {
      // Página congelada não responde nunca: fecha, e a próxima rodada abre de novo (ou põe outra live).
      if (err.message === 'timeout' && watchers.get(slug) === win) stopWatcher(slug);
      return null;
    });
    if (!info) continue;
    s.ageGate = info.gate;
    s.visibility = info.visibility;
    s.video = info.video;
  }
}

// "Ganhando": o saldo subiu nos últimos minutos enquanto a live tocava. A primeira contagem
// leva ~6–7 min depois que a live abre; depois, +10 a cada ~5–6 min.
const EARN_WINDOW_MS = 13 * 60 * 1000;
function earningState(slug, now) {
  const s = status.get(slug) || {};
  if (!watchers.has(slug)) return null;
  // Na Twitch o saldo acima de 1.000 vem arredondado ("1,2 mil"): sem ver o número subir, fica
  // "assistindo" (nunca "sem pontos", que tiraria a live da vaga).
  if (platformOf(slug) === 'twitch') return s.lastGainAt && now - s.lastGainAt < EARN_WINDOW_MS ? 'earning' : 'watching';
  if (s.lastGainAt && now - s.lastGainAt < EARN_WINDOW_MS) return 'earning';
  if (now - (s.watchingSince || now) < EARN_WINDOW_MS) return 'warming';
  return 'idle';
}

// Histórico em points-log.jsonl (pasta de dados do app): uma linha por minuto com pontos e
// estado de cada live. Serve para conferir se os pontos sobem com o app minimizado.
// Memória de cada janela (MB), para achar o que pesa: 'main' é a interface, o resto é a página aberta.
function memoryByWindow() {
  const byPid = new Map(app.getAppMetrics().map((m) => [m.pid, Math.round(m.memory.workingSetSize / 1024)]));
  return webContents.getAllWebContents().filter((wc) => !wc.isDestroyed()).map((wc) => {
    let what = 'outra';
    try {
      const u = new URL(wc.getURL());
      what = u.protocol === 'file:' ? 'main' : (u.hostname.replace(/^www./, '') + u.pathname).slice(0, 40);
    } catch {}
    return [what, byPid.get(wc.getOSProcessId()) || 0];
  });
}
function logHistory() {
  const now = Date.now();
  const channels = {};
  for (const slug of config.channels) {
    const s = status.get(slug) || {};
    if (!s.live && s.points == null) continue;
    channels[slug] = {
      live: !!s.live, watching: watchers.has(slug), points: s.points ?? null, following: s.following ?? null,
      subscribed: !!s.subscribed, earning: earningState(slug, now), video: s.video || null, visibility: s.visibility || null,
      gate: !!s.ageGate, watchedMin: Math.floor(totalWatched(slug, now) / 60000),
      ...(s.twitchDiag ? { twitch: s.twitchDiag, claims: s.bonusClaims || 0 } : {}),
    };
  }
  const line = JSON.stringify({
    t: new Date(now).toISOString(), mainMinimized: !!mainWin && mainWin.isMinimized(),
    mainFocused: !!mainWin && mainWin.isFocused(), loggedIn, memoryMB: snapshot().memoryMB,
    maxWatchers: config.maxWatchers, limitTest: limitTestSnapshot(), channels, windows: memoryByWindow(),
  });
  const file = path.join(app.getPath('userData'), 'points-log.jsonl');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.old');
    fs.appendFileSync(file, line + '\n');
  } catch {}
}

// Foco em bônus: o saldo é separado por canal, então espalhar pontos atrasa as compras. As vagas
// vão para quem está mais perto do próximo bônus, e todos os canais ao vivo chegam a 300 antes
// de alguém buscar 500, depois 1.000 e cada milhar seguinte. Cada troca perde ~6–7 min até a primeira contagem, por isso só troca
// quando o canal bateu a meta ou quando a diferença compensa (SWITCH_MARGIN).
// Canal com sub rende o dobro: entra na frente de todos e fica enquanto estiver ao vivo, sem meta.
const SWITCH_MARGIN = 50;
const IDLE_COOLDOWN_MS = 30 * 60 * 1000;

function goalRank(points) {
  const p = points || 0;
  // Bônus escolhido: junta pontos até o custo dele; quem já chegou cede a vaga para o próximo canal.
  if (config.bonusTarget) {
    const tier = Math.floor(p / config.bonusTarget);
    const goal = (tier + 1) * config.bonusTarget;
    return { tier, goal, left: goal - p };
  }
  // Passou de 1.000: cada milhar é uma meta nova, então ninguém dispara na frente dos outros.
  const thousands = Math.floor(p / 1000);
  const tier = thousands ? BONUSES.length - 1 + thousands : BONUSES.filter((b) => p >= b.cost).length;
  const goal = thousands ? (thousands + 1) * 1000 : BONUSES[tier].cost;
  return { tier, goal, left: goal - p };
}

const compareGoal = (a, b) => {
  const ra = goalRank(a.points), rb = goalRank(b.points);
  return !!a.cooling - !!b.cooling || !!b.sub - !!a.sub || ra.tier - rb.tier || ra.left - rb.left;
};

function worthSwitching(candidate, current) {
  if (candidate.cooling || current.sub) return false;
  if (candidate.sub) return true;
  const c = goalRank(candidate.points), w = goalRank(current.points);
  return c.tier < w.tier || (c.tier === w.tier && c.left + SWITCH_MARGIN < w.left);
}

const totalWatched = (slug, now) => {
  const s = status.get(slug) || {};
  return (s.watchedMs || 0) + (s.watchingSince ? now - s.watchingSince : 0);
};
const turnTime = (slug, now) => now - ((status.get(slug) || {}).watchingSince || now);
const isShown = (slug) => { const w = watchers.get(slug); return !!w && !w.isDestroyed() && userOpened.has(w); };

// Rodando direto, a página da Kick vai acumulando memória: renova a live de tempos em tempos.
const RECYCLE_MS = 6 * 60 * 60 * 1000;

// Kick e Twitch têm contas e limites separados: cada plataforma tem as próprias vagas.
function reconcileWatchers() {
  for (const platform of ['kick', 'twitch']) reconcilePlatform(platform);
}

function reconcilePlatform(platform) {
  const now = Date.now();
  const mine = (slug) => platformOf(slug) === platform;
  const watchers = new Map([...allWatchers].filter(([slug]) => mine(slug)));
  // Sem login a plataforma não dá pontos: abrir live só gastaria memória.
  const logged = platform === 'twitch' ? twitchLoggedIn : loggedIn;
  const canFarm = config.farming && (logged || process.env.KICKTERINO_ALLOW_ANON);
  for (const slug of [...watchers.keys()]) {
    const s = status.get(slug);
    if (isShown(slug)) continue;
    if (!canFarm || !config.channels.includes(slug) || (s && s.live === false)) { stopWatcher(slug); watchers.delete(slug); }
  }
  if (!canFarm) return;
  // O teste de limite mexe só nas vagas da Kick.
  const max = platform === 'twitch' && limitTest ? limitTest.prev.maxWatchers : config.maxWatchers;
  const startWatcherHere = (slug) => { startWatcher(slug); watchers.set(slug, allWatchers.get(slug)); };
  const stopWatcherHere = (slug) => { stopWatcher(slug); watchers.delete(slug); };

  // Vaga não pode ficar parada: com o limite de 2 lives, quem não rende cede o lugar.
  // Com mais vagas que isso, ficar sem ganhar é esperado, então não mexe.
  for (const slug of [...watchers.keys()]) {
    if (isShown(slug)) continue;
    const idle = logged && !limitTest && max <= 2 && earningState(slug, now) === 'idle';
    const s = status.get(slug);
    if (idle && s) s.cooldownUntil = now + IDLE_COOLDOWN_MS; // senão voltaria na mesma hora
    if (idle || turnTime(slug, now) >= RECYCLE_MS) stopWatcherHere(slug);
  }

  // Limite reduzido: libera primeiro quem está há mais tempo na vez.
  const rotatable = () => [...watchers.keys()].filter((slug) => !isShown(slug))
    .sort((a, b) => turnTime(b, now) - turnTime(a, now));
  while (watchers.size > max && rotatable().length) stopWatcherHere(rotatable()[0]);

  // Sem foco, as vagas seguem a ordem da lista de canais e ninguém troca de lugar.
  const focusInfo = (slug) => {
    const s = status.get(slug) || {};
    const cooling = (s.cooldownUntil || 0) > now;
    return { points: s.points, cooling, sub: !!s.subscribed && !cooling };
  };
  const byGoal = (a, b) => compareGoal(focusInfo(a), focusInfo(b));
  const waiting = config.channels.filter((slug) => mine(slug) && !watchers.has(slug) && (status.get(slug) || {}).live);
  if (config.rotation) waiting.sort(byGoal);
  while (watchers.size < max && waiting.length) startWatcherHere(waiting.shift());
  if (!config.rotation) return;

  for (const slug of rotatable().sort((a, b) => byGoal(b, a))) {
    if (!waiting.length || !worthSwitching(focusInfo(waiting[0]), focusInfo(slug))) break;
    stopWatcherHere(slug);
    startWatcherHere(waiting.shift());
  }
}

// Teste de limite: descobre quantas lives a Kick conta ao mesmo tempo. Em cada etapa abre N
// lives (sem rodízio), ignora o aquecimento e mede quantos pontos entraram no resto da etapa.
// Uma live no ritmo cheio rende 10 pts a cada 5 min, então "lives contando" ≈ pts / (min × 2).
// A 1ª etapa abre TODAS as lives ao vivo: se todas contarem, acaba ali. Senão, testa só os
// números até um pouco acima do que contou, para achar o menor que rende o máximo.
const LIMIT_LADDER = [2, 3, 4, 6, 8, 10, 13, 16, 20];
const LIMIT_STEP_MS = (Number(process.env.KICKTERINO_LIMIT_STEP_MIN) || 20) * 60 * 1000;
const LIMIT_WARMUP_MS = (Number(process.env.KICKTERINO_LIMIT_WARMUP_MIN) || 8) * 60 * 1000;
let limitTest = null;

const sumGained = () => [...status.values()].reduce((t, s) => t + (s.gainedTotal || 0), 0);
const liveCount = () => config.channels.filter((slug) => platformOf(slug) === 'kick' && (status.get(slug) || {}).live).length;

function startLimitTest() {
  const all = Math.max(2, liveCount());
  limitTest = {
    i: 0, steps: [all, ...LIMIT_LADDER.filter((n) => n < all)],
    stepStart: Date.now(), baseline: null, results: [],
    prev: { maxWatchers: config.maxWatchers, rotation: config.rotation },
  };
  config.maxWatchers = all;
  config.rotation = false;
}

function stopLimitTest() {
  if (!limitTest) return;
  config.maxWatchers = limitTest.prev.maxWatchers;
  config.rotation = limitTest.prev.rotation;
  limitTest = null;
  saveConfig();
}

function advanceLimitTest() {
  if (!limitTest) return;
  const now = Date.now();
  const elapsed = now - limitTest.stepStart;
  if (limitTest.baseline == null && elapsed >= LIMIT_WARMUP_MS) {
    limitTest.baseline = sumGained();
    limitTest.baselineAt = now;
  }
  if (elapsed < LIMIT_STEP_MS || limitTest.baseline == null) return;

  const minutes = (now - limitTest.baselineAt) / 60000;
  const pts = sumGained() - limitTest.baseline;
  const result = {
    lives: limitTest.steps[limitTest.i], playing: [...watchers.keys()].filter((k) => platformOf(k) === 'kick').length, minutes: Math.round(minutes),
    pts, counting: Math.round((pts / (minutes * 2)) * 10) / 10,
  };
  limitTest.results.push(result);
  if (limitTest.i === 0) {
    // Todas contaram (≥ 85%)? Então não há limite para achar. Senão, só testa até um pouco
    // acima do que contou.
    const cap = result.counting >= result.playing * 0.85 ? 0 : Math.ceil(result.counting) + 2;
    limitTest.steps = [limitTest.steps[0], ...limitTest.steps.slice(1).filter((n) => n <= Math.max(cap, 3) && cap > 0)];
  }
  limitTest.i++;
  if (limitTest.i < limitTest.steps.length) {
    Object.assign(limitTest, { stepStart: now, baseline: null });
    config.maxWatchers = limitTest.steps[limitTest.i];
    return;
  }
  // Fim: fica com o menor número de lives que rendeu pelo menos 90% do melhor resultado.
  const best = Math.max(...limitTest.results.map((r) => r.pts));
  const chosen = [...limitTest.results].sort((a, b) => a.lives - b.lives).find((r) => r.pts >= best * 0.9)
    || limitTest.results[0];
  config.limitResult = { at: new Date(now).toISOString(), results: limitTest.results, chosen: chosen.lives };
  config.maxWatchers = chosen.lives;
  config.rotation = true;
  limitTest = null;
  saveConfig();
}

function limitTestSnapshot() {
  if (!limitTest) return null;
  const elapsed = Date.now() - limitTest.stepStart;
  return {
    step: limitTest.i + 1, steps: limitTest.steps.length, lives: limitTest.steps[limitTest.i],
    warming: limitTest.baseline == null, leftMin: Math.max(0, Math.ceil((LIMIT_STEP_MS - elapsed) / 60000)),
    totalLeftMin: Math.ceil(((limitTest.steps.length - limitTest.i) * LIMIT_STEP_MS - elapsed) / 60000),
    results: limitTest.results,
  };
}

function snapshot() {
  const now = Date.now();
  return {
    farming: config.farming,
    maxWatchers: config.maxWatchers,
    lowQuality: config.lowQuality,
    rotation: config.rotation,
    bonusTarget: config.bonusTarget,
    limitTest: limitTestSnapshot(),
    limitResult: config.limitResult || null,
    openAtLogin: isOpenAtLogin(),
    platform: process.platform,
    notifyBonus: config.notifyBonus,
    autoXp: !!config.autoXp,
    notifyChat: config.notifyChat,
    sleepMode: config.sleepMode,
    favorites: config.favorites,
    username,
    account: ACCOUNT,
    version: app.getVersion(),
    intro: config.lastSeenVersion === app.getVersion() ? null : (firstRun ? 'welcome' : 'news'),
    bonuses: activeBonuses(now, 'kick'),
    twitchBonuses: activeBonuses(now, 'twitch'),
    pokeExtensions: loadedPokeExtensions.map((e) => ({ id: e.id, name: e.name, version: e.version, cockpit: !!e.cockpit })),
    pokeIdle: pokeIdleSnapshot(),
    purchases: [...config.purchases].sort((a, b) => b.t - a.t).slice(0, 6),
    storeSequence: storeSequence ? { done: storeSequence.done, total: storeSequence.total } : null,
    twitch: {
      loggedIn: twitchLoggedIn, chatUser: twitchUser, chatConnected: twitchChat.connected,
      api: hasTwitchApi(), clientId: config.twitchClientId, statusError: twitchStatusError,
    },
    channels: config.channels.map((slug) => {
      const s = status.get(slug) || {};
      const watchedMs = (s.watchedMs || 0) + (s.watchingSince ? now - s.watchingSince : 0);
      return {
        slug, platform: platformOf(slug), name: nameOf(slug),
        displayName: s.displayName || nameOf(slug), live: !!s.live, liveUnknown: s.live === undefined && platformOf(slug) === 'twitch',
        viewers: s.viewers || 0,
        title: s.title || '', chatroomId: s.chatroomId || null, points: s.points ?? null, pointsApprox: !!s.pointsApprox, bonusClaims: s.bonusClaims || 0, lastClaimAt: s.lastClaimAt || null,
        watching: watchers.has(slug), ageGate: !!s.ageGate, earning: earningState(slug, now),
        following: s.following ?? null, subscribed: !!s.subscribed,
        gained: s.gainedTotal || 0,
        goal: s.points != null ? goalRank(s.points).goal : null,
        goalLeft: s.points != null ? goalRank(s.points).left : null,
        watchedMin: Math.floor(watchedMs / 60000), error: s.error || null,
      };
    }),
    memoryMB: Math.round(app.getAppMetrics().reduce((t, m) => t + m.memory.workingSetSize, 0) / 1024),
    loggedIn,
  };
}

// Uma rodada presa não pode parar o app: passado esse tempo, a seguinte começa mesmo assim.
const POLL_STUCK_MS = 5 * 60 * 1000;
let polling = false;
let pollStartedAt = 0;
let loggedIn = false;
// Nome da conta logada: o chat destaca quando alguém menciona você.
let username = null;
async function fetchUsername() {
  for (const p of ['/api/v1/user', '/api/v2/user']) {
    try {
      const { status: code, json } = await kickFetch(p);
      const name = code === 200 && json && (json.username || (json.user && json.user.username));
      if (name) return String(name);
    } catch {}
  }
  return null;
}
async function poll() {
  if (polling && Date.now() - pollStartedAt < POLL_STUCK_MS) return;
  const startedAt = Date.now();
  polling = true;
  pollStartedAt = startedAt;
  try {
    // Twitch primeiro: não depende da página da Kick estar no ar.
    try {
      twitchLoggedIn = await twitchSessionLoggedIn();
      syncTwitchChat();
      await refreshTwitch();
    } catch {}
    loggedIn = !!(await sessionToken());
    await withTimeout(apiReady, 5 * 1000).catch(() => {
      // Kick fora do ar: as lives da Twitch seguem sendo organizadas mesmo assim.
      reconcilePlatform('twitch');
      send('status', snapshot());
      throw new Error('kick indisponível');
    });
    if (!loggedIn) username = null;
    else if (!username) username = await fetchUsername();
    const kickKeys = config.channels.filter((slug) => platformOf(slug) === 'kick');
    for (const slug of kickKeys) await refreshChannel(slug);
    if (configDirty) { configDirty = false; saveConfig(); }
    // Nenhum canal respondeu: a página de consulta pode ter ficado velha, então renova.
    if (kickKeys.length && kickKeys.every((slug) => (status.get(slug) || {}).error) && !apiWin.isVisible()) {
      loadApi(LIGHT_URL);
    }
    advanceLimitTest();
    reconcileWatchers();
    await checkPlayers();
    logHistory();
    send('status', snapshot());
    updateTray();
    if (process.env.KICKTERINO_DEBUG) {
      console.log(JSON.stringify(snapshot()));
      for (const [slug, win] of watchers) {
        const h = await win.webContents.executeJavaScript(`(document.querySelector('video') || {}).videoHeight`).catch(() => '?');
        const mem = app.getAppMetrics().find((m) => m.pid === win.webContents.getOSProcessId());
        console.log(`VIDEO ${slug} ${h}p ${mem ? Math.round(mem.memory.workingSetSize / 1024) : '?'}MB`);
      }
      for (const m of app.getAppMetrics()) console.log(`PROC ${m.type} ${Math.round(m.memory.workingSetSize / 1024)}MB`);
    }
  } catch {
    // Kick ou internet fora do ar: a próxima rodada tenta de novo.
  } finally { if (pollStartedAt === startedAt) polling = false; }
}

// ---------- Modo 24/7 ----------
// Impede o PC de suspender enquanto farma. O monitor pode apagar normalmente.
let awakeBlocker = null;
function syncKeepAwake() {
  if (config.farming && awakeBlocker == null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!config.farming && awakeBlocker != null) { powerSaveBlocker.stop(awakeBlocker); awakeBlocker = null; }
}

function setFarming(on) {
  config.farming = !!on;
  saveConfig();
  syncKeepAwake();
  reconcileWatchers();
  updateTray();
  send('status', snapshot());
}

// O app portátil roda de uma pasta temporária: o que abre com o Windows é o .exe original.
const LOGIN_ITEM = { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ['--hidden', ...(ACCOUNT ? [`--conta=${ACCOUNT}`] : [])] };
// No Linux, abrir com o sistema é um atalho na pasta autostart (o AppImage informa o próprio caminho).
const autostartFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config'), 'autostart', 'kickterino.desktop');
const isOpenAtLogin = () => (isLinux ? fs.existsSync(autostartFile()) : app.getLoginItemSettings(LOGIN_ITEM).openAtLogin);
function setOpenAtLogin(on) {
  if (!isLinux) return app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: on });
  const file = autostartFile();
  if (!on) return fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exe = process.env.APPIMAGE || process.execPath;
  fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=TK MultiStream\nExec="${exe}" --hidden\nIcon=kickterino\nX-GNOME-Autostart-enabled=true\n`);
}

function showMain() {
  if (HEADLESS) { controlBroadcast({ ev: 'show-me' }); return; } // a principal mostra esta conta
  // Abrir o atalho enquanto o app ainda está fechando chama isto com a janela já destruída.
  if (!mainWin || mainWin.isDestroyed() || app.isQuitting) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function quitApp() {
  app.isQuitting = true;
  app.quit();
}

let tray = null;
const clock = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };
function updateTray() {
  if (!tray) return;
  const gained = sumGained();
  const now = Date.now();
  const active = PLATFORMS.flatMap((pl) => activeBonuses(now, pl).filter((b) => b.endsAt)
    .map((b) => `${pl === 'twitch' ? 'T' : 'K'} ${b.name.replace('+15% ', '')} ${clock(b.endsAt - now)}`));
  tray.setToolTip(`${APP_TITLE} — ${config.farming ? `${watchers.size} assistindo` : 'farm pausado'}${gained ? ` · +${gained} pts` : ''}`
    + (active.length ? `\nBônus ativo: ${active.join(' · ')}` : ''));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Abrir ${APP_TITLE}`, click: showMain },
    { label: 'Farmar pontos', type: 'checkbox', checked: config.farming, click: (item) => setFarming(item.checked) },
    { type: 'separator' },
    { label: 'Sair', click: quitApp },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.on('click', showMain);
  updateTray();
}

// Depois de suspender ou ficar sem rede, as lives abertas não voltam sozinhas: reabre tudo.
function recoverAfterResume() {
  for (const slug of [...watchers.keys()]) if (!isShown(slug)) stopWatcher(slug);
  if (!apiWin.isVisible()) loadApi(LIGHT_URL);
  setTimeout(poll, 15 * 1000);
}

// Atualização automática pelo GitHub Releases. A versão portátil não se atualiza sozinha.
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
function setupAutoUpdate() {
  // No Linux só o AppImage se atualiza sozinho; o .deb é atualizado baixando de novo.
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE || (isLinux && !process.env.APPIMAGE)) return;
  const check = () => autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  autoUpdater.on('error', () => {}); // sem internet: tenta de novo na próxima rodada
  check();
  setInterval(check, UPDATE_CHECK_MS);
}

// ---------- Contas (principal + alts) ----------
// Cada conta é uma cópia do app com pasta própria (Kickterino-NOME). O botão "Contas" lista as que
// existem, abre qualquer uma e cria novas, com atalho na área de trabalho se a pessoa quiser.
const ACCOUNT_RE = /^[a-z0-9_-]{1,20}$/;
const cleanAccount = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 20);

function listAccounts() {
  let dirs = [];
  try { dirs = fs.readdirSync(app.getPath('appData')); } catch {}
  const alts = dirs.filter((d) => d.startsWith('Kickterino-')).map((d) => d.slice('Kickterino-'.length))
    .filter((n) => ACCOUNT_RE.test(n)).sort();
  return [{ name: null, label: 'Principal', current: !ACCOUNT }, ...alts.map((n) => ({ name: n, label: n, current: ACCOUNT === n }))];
}

function accountArgs(name) {
  const extra = name ? [`--conta=${name}`] : [];
  return app.isPackaged ? extra : [app.getAppPath(), ...extra];
}

function launchAccount(name) {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const { spawn } = require('child_process');
  // A conta nova usa a pasta dela: sem herdar a pasta de testes (KICKTERINO_DATA) desta janela.
  const env = { ...process.env };
  delete env.KICKTERINO_DATA;
  spawn(exe, accountArgs(name), { detached: true, stdio: 'ignore', env }).unref();
}

// Atalho na área de trabalho e no menu Iniciar (só no Windows), com o ícone do app.
function createAccountShortcut(name) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const args = accountArgs(name).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  const ico = path.join(__dirname, 'build', 'terino-atomo.ico');
  const title = `TK MultiStream ${name}`;
  const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const script = [
    '$sh = New-Object -ComObject WScript.Shell',
    `foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {`,
    `  $s = $sh.CreateShortcut((Join-Path $dir ${ps(title + '.lnk')}))`,
    `  $s.TargetPath = ${ps(exe)}`,
    `  $s.Arguments = ${ps(args)}`,
    `  $s.WorkingDirectory = ${ps(path.dirname(app.isPackaged ? exe : app.getAppPath()))}`,
    `  $s.IconLocation = ${ps(ico + ',0')}`,
    `  $s.Description = ${ps(`TK MultiStream — conta ${name}`)}`,
    '  $s.Save()',
    '}',
  ].join('\n');
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err) => resolve(!err));
  });
}

ipcMain.handle('accounts:list', () => listAccounts());
ipcMain.handle('accounts:open', (_e, name) => {
  const n = name ? cleanAccount(name) : null;
  if (n === (ACCOUNT || null)) { showMain(); return { ok: true }; }
  if (n && !ACCOUNT_RE.test(n)) return { ok: false, message: 'Nome inválido.' };
  launchAccount(n);
  return { ok: true };
});
ipcMain.handle('accounts:create', async (_e, { name, shortcut } = {}) => {
  const n = cleanAccount(name);
  if (!ACCOUNT_RE.test(n)) return { ok: false, message: 'Use só letras, números, - ou _ (até 20).' };
  if (listAccounts().some((a) => a.name === n)) return { ok: false, message: `A conta "${n}" já existe: use Abrir.` };
  launchAccount(n); // abre já; o atalho leva alguns segundos para ficar pronto
  const made = shortcut ? await createAccountShortcut(n) : false;
  return { ok: true, name: n, shortcut: made, accounts: listAccounts() };
});

// ---------- Canal de controle da conta alt (lado da cópia que roda por trás) ----------
// A principal se conecta pelo pipe e chama os mesmos comandos da interface; o que a alt mandaria
// para a interface (status, avisos) vai pelo mesmo pipe.
const controlClients = new Set();
function controlBroadcast(obj) {
  if (!controlClients.size) return;
  let line;
  try { line = JSON.stringify(obj) + '\n'; } catch { return; }
  for (const s of controlClients) { try { s.write(line); } catch {} }
}
function startControlServer() {
  const srv = nodeNet.createServer((sock) => {
    controlClients.add(sock);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        handleControl(sock, m);
      }
    });
    sock.on('close', () => controlClients.delete(sock));
    sock.on('error', () => controlClients.delete(sock));
  });
  srv.on('error', () => {});
  srv.listen(pipeName(ACCOUNT));
}
async function handleControl(sock, m) {
  const fn = HANDLERS.get(m.ch);
  let reply;
  try {
    const value = fn ? await fn({ sender: null, fromControl: true }, ...(m.args || [])) : undefined;
    reply = { id: m.id, ok: true, value: value === undefined ? null : value };
  } catch (e) {
    reply = { id: m.id, ok: false, error: String((e && e.message) || e) };
  }
  try { sock.write(JSON.stringify(reply) + '\n'); } catch {}
}
// Bônus lidos do PokeIdle desta conta (o jogo roda na janela da principal).
ipcMain.handle('poke:bonus', (_e, found) => {
  for (const platform of Object.keys(found || {})) setPokeBonus(platform, found[platform], 'jogo');
  config.pokeReadAt = Date.now();
  saveConfig(); configDirty = false;
  send('status', snapshot());
  return true;
});

// ---------- Contas alt (lado da principal) ----------
const altCores = new Map(); // id -> { id, sock, connected, pending, seq, proc, retry }
let activeAlt = null;       // conta alt na tela (null = principal)
const altLast = new Map();  // id -> último status recebido da alt (para a tabela de bônus de todas as contas)
const altFull = new Map();  // id -> último estado completo da alt (para responder comandos da principal)
// Comandos que são sempre da principal (o PokeIdle e as contas moram na janela dela).
const LOCAL_CHANNELS = new Set([
  'tk:switch', 'tk:add', 'tk:remove', 'pokeidle:openAll', 'pokeidle:grid', 'pokeidle:show', 'pokeidle:hide', 'pokeidle:close', 'pokeidle:add',
  'pokeidle:remove', 'cockpit:open', 'report:save', 'poke:setMode', 'poke:settings', 'poke:testAlert', 'extras:info', 'extras:set', 'extras:backup', 'extras:restore', 'extras:openBackups', 'extras:copy', 'accounts:list', 'accounts:open', 'accounts:create', 'app:quit',
]);

// Fim de cada bônus (XP, Capture, Lure) por plataforma, para a tabela com todas as contas.
const bonusEnds = (list) => (list || []).map((b) => b.endsAt || null);
function tkSnapshot() {
  const now = Date.now();
  return {
    active: activeAlt || POKE_MAIN,
    accounts: pokeAccountIds().map((id) => {
      const last = id === POKE_MAIN ? null : altLast.get(id);
      return {
        id, label: pokeLabel(id),
        connected: id === POKE_MAIN || !!(altCores.get(id) || {}).connected,
        bonus: id === POKE_MAIN
          ? { twitch: bonusEnds(activeBonuses(now, 'twitch')), kick: bonusEnds(activeBonuses(now, 'kick')) }
          : last ? { twitch: bonusEnds(last.twitchBonuses), kick: bonusEnds(last.bonuses) } : null,
      };
    }),
  };
}

// O status de uma alt chega sem as partes que moram na principal: completa.
function decorateState(s) {
  return {
    ...s,
    pokeIdle: pokeIdleSnapshot(),
    pokeExtensions: loadedPokeExtensions.map((e) => ({ id: e.id, name: e.name, version: e.version, cockpit: !!e.cockpit })),
    tk: tkSnapshot(),
  };
}
const decorateIfState = (v) => {
  if (!(v && typeof v === 'object' && Array.isArray(v.channels))) return v;
  if (activeAlt) { altLast.set(activeAlt, { bonuses: v.bonuses, twitchBonuses: v.twitchBonuses }); altFull.set(activeAlt, v); }
  return decorateState(v);
};

function spawnCore(id) {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const env = { ...process.env };
  delete env.KICKTERINO_DATA;
  const { spawn } = require('child_process');
  try {
    return spawn(exe, [...accountArgs(id), '--tk-fundo'], { detached: true, stdio: 'ignore', env, windowsHide: true });
  } catch { return null; }
}

function connectCore(id) {
  let core = altCores.get(id);
  if (!core) {
    core = { id, sock: null, connected: false, pending: new Map(), seq: 0, proc: null, tries: 0 };
    altCores.set(id, core);
  }
  if (core.connected || core.connecting) return core;
  core.connecting = true;
  const sock = nodeNet.connect(pipeName(id));
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('connect', () => {
    core.connecting = false;
    core.connected = true;
    core.sock = sock;
    core.tries = 0;
    send('status', snapshot()); // a barra de contas mostra a alt pronta
    if (activeAlt === id) proxy(id, 'state:get', []).then((s) => pushAltStatus(id, s)).catch(() => {});
  });
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && core.pending.has(m.id)) {
        const p = core.pending.get(m.id);
        core.pending.delete(m.id);
        if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
      } else if (m.ev) onAltEvent(id, m.ev, m.payload);
    }
  });
  const lost = () => {
    const was = core.connected;
    core.connecting = false;
    core.connected = false;
    core.sock = null;
    for (const p of core.pending.values()) p.reject(new Error('conta desconectada'));
    core.pending.clear();
    if (was) send('status', snapshot());
    if (!altCores.has(id) || app.isQuitting) return;
    // A cópia ainda está abrindo (ou caiu): tenta de novo; depois de um tempo, abre outra.
    core.tries++;
    if (core.tries === 15) core.proc = spawnCore(id);
    setTimeout(() => { if (altCores.has(id)) connectCore(id); }, core.tries < 30 ? 2000 : 15000);
  };
  sock.on('error', lost);
  sock.on('close', () => { if (core.connected) lost(); });
  return core;
}

function startCore(id) {
  const core = connectCore(id);
  if (!core.proc) core.proc = spawnCore(id); // se já estiver rodando, a cópia nova sai sozinha (trava da pasta)
  return core;
}

function proxy(id, ch, args) {
  const core = altCores.get(id);
  if (!core || !core.connected || !core.sock) return Promise.reject(new Error('A conta ainda está abrindo, tente de novo em alguns segundos.'));
  const reqId = ++core.seq;
  return new Promise((resolve, reject) => {
    core.pending.set(reqId, { resolve, reject });
    try { core.sock.write(JSON.stringify({ id: reqId, ch, args }) + '\n'); } catch (e) { core.pending.delete(reqId); reject(e); }
    setTimeout(() => { if (core.pending.has(reqId)) { core.pending.delete(reqId); reject(new Error('A conta não respondeu.')); } }, 60 * 1000);
  });
}

function pushAltStatus(id, payload) {
  if (payload && Array.isArray(payload.channels)) { altLast.set(id, { bonuses: payload.bonuses, twitchBonuses: payload.twitchBonuses }); altFull.set(id, payload); }
  if (activeAlt !== id || !payload || !mainWin || mainWin.isDestroyed()) return;
  mainWin.webContents.send('status', decorateState(payload));
}

function onAltEvent(id, ev, payload) {
  if (ev === 'status') return pushAltStatus(id, payload);
  if (ev === 'toast') { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('toast', `[${id}] ${payload}`); return; }
  if (ev === 'show-me') { switchAccount(id).then(() => showMain()).catch(() => {}); return; }
  if (ev === 'select' && activeAlt === id && mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('select', payload);
}

async function waitConnected(id, ms = 25 * 1000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const core = altCores.get(id);
    if (core && core.connected) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function switchAccount(id) {
  if (!id || id === POKE_MAIN) { activeAlt = null; return snapshotForUi(); }
  if (!pokeAccountIds().includes(id)) return snapshotForUi();
  startCore(id);
  if (!(await waitConnected(id))) return { ...snapshotForUi(), error: `A conta ${id} ainda está abrindo. Tente de novo em alguns segundos.` };
  activeAlt = id;
  const st = await proxy(id, 'state:get', []);
  altFull.set(id, st);
  if (st) altLast.set(id, { bonuses: st.bonuses, twitchBonuses: st.twitchBonuses });
  return decorateState(st);
}
const snapshotForUi = () => ({ ...snapshot(), tk: tkSnapshot() });

// Comandos da principal (PokeIdle, contas) devolvem estado: com uma alt na tela, devolve o dela.
localResult = (v) => {
  if (ACCOUNT || !activeAlt || !(v && typeof v === 'object' && Array.isArray(v.channels))) return v;
  const alt = altFull.get(activeAlt);
  return alt ? decorateState({ ...alt, ...(v.error ? { error: v.error } : {}), ...(v.added ? { added: v.added } : {}) }) : v;
};
routeHandler = (channel, args) => {
  if (ACCOUNT || !activeAlt || LOCAL_CHANNELS.has(channel)) return undefined;
  return proxy(activeAlt, channel, args).then(decorateIfState);
};

ipcMain.handle('tk:switch', (_e, id) => switchAccount(id));
ipcMain.handle('tk:add', async (_e, name) => {
  const id = String(name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 20);
  if (!id || id === POKE_MAIN) return { ...snapshotForUi(), error: 'Use só letras, números, - ou _ (até 20).' };
  if (!pokeAccountIds().includes(id) && pokeAccountIds().length >= POKE_MAX_ACCOUNTS) return { ...snapshot(), error: `O PokeIdle permite no máximo ${POKE_MAX_ACCOUNTS} contas por pessoa (a principal e mais ${POKE_MAX_ACCOUNTS - 1}). Tire uma conta antes de criar outra.` };
  if (!pokeAccountIds().includes(id)) { config.pokeAccounts = [...(config.pokeAccounts || []), id]; saveConfig(); }
  const res = await switchAccount(id);
  return { ...res, added: id };
});
// Tirar uma conta da barra: a cópia dela fecha; logins e dados ficam guardados no PC.
ipcMain.handle('tk:remove', async (_e, id) => {
  if (!id || id === POKE_MAIN) return snapshotForUi();
  if (activeAlt === id) activeAlt = null;
  closePokeIdle(id);
  const core = altCores.get(id);
  altCores.delete(id);
  if (core && core.connected) {
    try { core.sock.write(JSON.stringify({ id: 0, ch: 'app:quit', args: [] }) + '\n'); } catch {}
    try { core.sock.end(); } catch {}
  }
  config.pokeAccounts = (config.pokeAccounts || []).filter((x) => x !== id);
  saveConfig();
  return snapshotForUi();
});

function quitAltCores() {
  for (const core of altCores.values()) {
    if (core.sock) { try { core.sock.write(JSON.stringify({ id: 0, ch: 'app:quit', args: [] }) + '\n'); } catch {} }
  }
}

// ---------- Extras: overlay do OBS, painel no celular e backups (extras.js) ----------
let extras = null;
// O que o overlay e o painel mostram: cada conta com o que foi lido do jogo e o fim de cada bônus.
function extrasData(kind, conta) {
  const tk = tkSnapshot();
  const summary = pokeAccountsSummary();
  const contas = tk.accounts.map((a) => ({ ...(summary.find((s) => s.id === a.id) || {}), ...a }));
  if (kind === 'overlay') {
    const id = contas.some((x) => x.id === conta) ? conta : (activeAlt || POKE_MAIN);
    return contas.find((x) => x.id === id) || {};
  }
  return { farming: !!config.farming, assistindo: watchers.size, contas };
}
// Pasta de dados de cada conta (para o backup).
const extrasDataDirs = () => [[POKE_MAIN, app.getPath('userData')], ...pokeAccountIds().filter((id) => id !== POKE_MAIN).map((id) => [id, `${MAIN_DATA}-${id}`])];
function relaunchAll() {
  quitAltCores();
  app.isQuitting = true;
  app.relaunch();
  setTimeout(() => app.quit(), 500);
}
function startExtras() {
  extras = require('./extras')({
    app, getConfig: () => config, saveConfig, data: extrasData, dataDirs: extrasDataDirs, relaunch: relaunchAll,
  });
  extras.sync();
  extras.autoBackup();
  setInterval(() => extras.autoBackup(), 6 * 60 * 60 * 1000);
}
ipcMain.handle('extras:info', () => (extras ? extras.info() : null));
ipcMain.handle('extras:set', (_e, patch = {}) => {
  if ('overlayOn' in patch) config.overlayOn = !!patch.overlayOn;
  if ('mobileOn' in patch) config.mobileOn = !!patch.mobileOn;
  saveConfig();
  if (extras) extras.sync();
  return extras ? extras.info() : null;
});
ipcMain.handle('extras:backup', () => { try { return { ...extras.backupNow(), info: extras.info() }; } catch (e) { return { error: String(e.message || e) }; } });
ipcMain.handle('extras:restore', (_e, name) => { try { return extras.restore(name); } catch (e) { return { error: String(e.message || e) }; } });
ipcMain.handle('extras:openBackups', () => { const d = extras && extras.info().backupDir; if (d) { fs.mkdirSync(d, { recursive: true }); shell.openPath(d); } });
ipcMain.handle('extras:copy', (_e, text) => { clipboard.writeText(String(text || '')); return true; });

ipcMain.handle('state:get', () => (ACCOUNT ? snapshot() : snapshotForUi()));
// Aceita "canal" ou kick.com/canal (Kick) e "twitch:canal" ou twitch.tv/canal (Twitch).
function parseChannelInput(input) {
  const raw = String(input || '').trim().toLowerCase();
  const tw = /^(?:twitch:|(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/)([a-z0-9_]{2,25})/.exec(raw);
  if (tw) return `twitch:${tw[1]}`;
  return raw.replace(/^(kick:|https?:\/\/(www\.)?kick\.com\/)/, '').replace(/[^a-z0-9_-]/g, '');
}
ipcMain.handle('channels:add', async (_e, input) => {
  const slug = parseChannelInput(input);
  if (slug && !config.channels.includes(slug)) {
    config.channels.push(slug); saveConfig();
    if (platformOf(slug) === 'twitch') {
      syncTwitchChat();
      refreshTwitch().then(() => { reconcileWatchers(); send('status', snapshot()); });
    } else poll();
  }
  return { ...snapshot(), added: slug };
});
ipcMain.handle('channels:remove', (_e, slug) => {
  config.channels = config.channels.filter((c) => c !== slug);
  stopWatcher(slug); status.delete(slug); saveConfig(); syncTwitchChat();
  return snapshot();
});
ipcMain.handle('farming:set', (_e, on) => { setFarming(on); return snapshot(); });
ipcMain.handle('autostart:set', (_e, on) => { try { setOpenAtLogin(!!on); } catch {} return snapshot(); });
ipcMain.handle('app:quit', quitApp);
ipcMain.handle('notifyBonus:set', (_e, on) => { config.notifyBonus = !!on; saveConfig(); return snapshot(); });
ipcMain.handle('notifyChat:set', (_e, on) => { config.notifyChat = !!on; saveConfig(); return snapshot(); });
ipcMain.handle('sleepMode:set', (_e, on) => { config.sleepMode = !!on; saveConfig(); return snapshot(); });
ipcMain.handle('favorite:toggle', (_e, slug) => {
  if (!config.channels.includes(slug)) return snapshot();
  config.favorites = config.favorites.includes(slug) ? config.favorites.filter((s) => s !== slug) : [...config.favorites, slug];
  saveConfig();
  return snapshot();
});
ipcMain.handle('purchase:add', (_e, cost, platform = 'kick') => {
  if (BONUSES.some((b) => b.cost === cost) && PLATFORMS.includes(platform)) {
    config.purchases.push({ t: Date.now(), cost, slug: null, platform }); saveConfig();
  }
  updateTray();
  return snapshot();
});
// Tempo que falta digitado à mão (ms); 0 zera o bônus.
ipcMain.handle('bonus:set', (_e, platform, tipo, msLeft) => {
  const ms = Math.max(0, Math.min(60 * DAY_MS, Number(msLeft) || 0));
  if (PLATFORMS.includes(platform) && POKE_TIPOS.includes(tipo)) {
    setPokeBonus(platform, { [tipo]: ms ? Date.now() + ms : 0 }, 'manual');
    saveConfig(); configDirty = false;
  }
  updateTray();
  return snapshot();
});
ipcMain.handle('pokeidle:show', async (_e, id, bounds) => { await showPokeIdle(id || POKE_MAIN, bounds); return snapshot(); });
ipcMain.handle('pokeidle:hide', () => { hidePokeIdle(); return snapshot(); });
ipcMain.handle('redeem:start', (_e, tipo, platform) => startRedeemJob(tipo, platform));
ipcMain.handle('redeem:get', (_e, id) => getRedeemJob(id));
ipcMain.handle('redeem:cancel', (_e, id) => cancelRedeemJob(id));
// Abre o PokeIdle de todas as contas de uma vez (por trás) e mostra o da conta escolhida.
// Liga/desliga a grade (abre o PokeIdle das contas que ainda não estavam abertas).
ipcMain.handle('pokeidle:grid', async (_e, on, current, bounds) => {
  pokeGrid = !!on;
  if (bounds) pokeBounds = bounds;
  if (pokeGrid) for (const id of pokeAccountIds()) await ensurePokeView(id).catch(() => {});
  await showPokeIdle(pokeAccountIds().includes(current) ? current : (pokeActive || POKE_MAIN), bounds);
  return snapshot();
});
ipcMain.handle('pokeidle:openAll', async (_e, current, bounds) => {
  for (const id of pokeAccountIds()) await ensurePokeView(id).catch(() => {});
  await showPokeIdle(pokeAccountIds().includes(current) ? current : POKE_MAIN, bounds);
  return snapshot();
});
ipcMain.handle('cockpit:open', (_e, id) => { openCockpit(id); });
ipcMain.handle('pokeidle:close', (_e, id) => { closePokeIdle(id || POKE_MAIN); return snapshot(); });
// Conta nova do PokeIdle: só um nome; o login é feito na aba dela.
ipcMain.handle('pokeidle:add', async (_e, name, bounds) => {
  const id = String(name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 20);
  if (!id || id === POKE_MAIN) return { ...snapshot(), error: 'Use só letras, números, - ou _ (até 20).' };
  if (!pokeAccountIds().includes(id) && pokeAccountIds().length >= POKE_MAX_ACCOUNTS) return { ...snapshot(), error: `O PokeIdle permite no máximo ${POKE_MAX_ACCOUNTS} contas por pessoa (a principal e mais ${POKE_MAX_ACCOUNTS - 1}). Tire uma conta antes de criar outra.` };
  if (!pokeAccountIds().includes(id)) { config.pokeAccounts = [...(config.pokeAccounts || []), id]; saveConfig(); }
  await showPokeIdle(id, bounds);
  return { ...snapshot(), added: id };
});
// Tirar a aba de uma conta (o login dela fica guardado e volta se a conta for adicionada de novo).
ipcMain.handle('pokeidle:remove', (_e, id) => {
  if (id === POKE_MAIN) return snapshot();
  closePokeIdle(id);
  config.pokeAccounts = (config.pokeAccounts || []).filter((x) => x !== id);
  saveConfig();
  return snapshot();
});
ipcMain.on('pokeidle:bounds', (_e, bounds) => { pokeBounds = bounds; applyPokeBounds(); });
ipcMain.handle('purchase:remove', (_e, t) => { config.purchases = config.purchases.filter((p) => p.t !== t); saveConfig(); updateTray(); return snapshot(); });
ipcMain.handle('stores:sequence', (_e, slugs) => {
  const queue = (Array.isArray(slugs) ? slugs : []).filter((s) => config.channels.includes(s));
  if (!queue.length) return snapshot();
  storeSequence = { queue, total: queue.length, done: 0, current: null };
  openNextStore();
  return snapshot();
});
ipcMain.handle('stores:cancel', () => { if (storeSequence) storeSequence.queue = []; return snapshot(); });
ipcMain.handle('report:get', () => weeklyReport());
// Salva o card do relatório como imagem (o recorte é a área do card na janela).
ipcMain.handle('report:save', async (_e, rect) => {
  const r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  if (!mainWin) return { canceled: true };
  const image = await mainWin.webContents.capturePage(r);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Salvar resumo da semana',
    defaultPath: path.join(app.getPath('pictures'), `kickterino-semana-${dayKey(Date.now())}.png`),
    filters: [{ name: 'Imagem PNG', extensions: ['png'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, image.toPNG());
  return filePath;
});
ipcMain.handle('intro:done', () => { config.lastSeenVersion = app.getVersion(); firstRun = false; saveConfig(); return snapshot(); });
ipcMain.handle('maxWatchers:set', (_e, n) => {
  limitTest = null; // mexer na mão cancela o teste de limite
  config.maxWatchers = Math.max(1, Math.min(30, Number(n) || 1)); saveConfig(); reconcileWatchers(); return snapshot();
});
ipcMain.handle('rotation:set', (_e, on) => { limitTest = null; config.rotation = !!on; saveConfig(); reconcileWatchers(); return snapshot(); });
ipcMain.handle('bonusTarget:set', (_e, cost) => {
  config.bonusTarget = BONUSES.some((b) => b.cost === cost) ? cost : 0;
  saveConfig();
  reconcileWatchers();
  return snapshot();
});
ipcMain.handle('limitTest:start', () => {
  if (!loggedIn && !process.env.KICKTERINO_LIMIT_AUTOSTART) return snapshot(); // sem login a Kick não dá pontos: o teste não mediria nada
  startLimitTest(); reconcileWatchers(); return snapshot(); });
ipcMain.handle('limitTest:stop', () => { stopLimitTest(); reconcileWatchers(); return snapshot(); });
ipcMain.handle('lowQuality:set', (_e, on) => {
  config.lowQuality = !!on; saveConfig();
  for (const [slug, win] of watchers) if (!win.isDestroyed() && !userOpened.has(win)) win.loadURL(watchUrl(slug));
  return snapshot();
});
ipcMain.handle('refresh', async () => { await poll(); return snapshot(); });
ipcMain.handle('login:show', async (_e, platform) => {
  if (platform === 'twitch') return showTwitchLogin();
  apiWin.show(); apiWin.focus();
  await loadApi(`${KICK}/login`);
});

// Login no site da Twitch (sessão própria): é a conta que ganha os pontos das lives ocultas.
let twitchLoginWin = null;
function showTwitchLogin() {
  if (twitchLoginWin && !twitchLoginWin.isDestroyed()) { twitchLoginWin.show(); twitchLoginWin.focus(); return; }
  twitchLoginWin = new BrowserWindow({
    width: 520, height: 760, title: 'Twitch — login', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { partition: TWITCH_PARTITION },
  });
  twitchLoginWin.loadURL(`${TWITCH}/login`);
  twitchLoginWin.on('closed', () => { twitchLoginWin = null; poll(); });
}

// Conectar o chat: fluxo OAuth implícito da Twitch com o app da própria pessoa
// (redirect http://localhost cadastrado no Developer Console). O token só fica neste PC.
const TWITCH_REDIRECT = 'http://localhost';
let twitchAuthWin = null;
function connectTwitchChat() {
  if (!config.twitchClientId) return Promise.resolve({ ok: false, message: 'Informe o Client ID do seu app da Twitch primeiro.' });
  if (twitchAuthWin && !twitchAuthWin.isDestroyed()) { twitchAuthWin.focus(); return Promise.resolve({ ok: false, message: 'Janela de autorização já aberta.' }); }
  const state = require('crypto').randomBytes(16).toString('hex');
  const url = 'https://id.twitch.tv/oauth2/authorize?' + new URLSearchParams({
    client_id: config.twitchClientId, redirect_uri: TWITCH_REDIRECT, response_type: 'token',
    scope: 'chat:read chat:edit', state, force_verify: 'true',
  });
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 520, height: 760, title: 'Twitch — autorizar chat', autoHideMenuBar: true,
      icon: path.join(__dirname, 'build', 'icon.png'),
      webPreferences: { partition: TWITCH_PARTITION },
    });
    twitchAuthWin = win;
    let done = false;
    const finish = (result) => { if (done) return; done = true; resolve(result); if (!win.isDestroyed()) win.close(); };
    const check = async (target) => {
      if (!target.startsWith(TWITCH_REDIRECT)) return;
      const u = new URL(target);
      const params = new URLSearchParams(u.hash.slice(1) || u.search.slice(1));
      if (params.get('state') !== state) return finish({ ok: false, message: 'Resposta da Twitch inválida.' });
      const token = params.get('access_token');
      if (!token) return finish({ ok: false, message: params.get('error_description') || 'Autorização cancelada.' });
      config.twitchToken = token;
      saveConfig();
      await syncTwitchAuth();
      finish({ ok: !!twitchUser, message: twitchUser ? `Chat conectado como ${twitchUser}.` : 'Token recusado pela Twitch.' });
    };
    win.webContents.on('will-redirect', (_e, target) => check(target));
    win.webContents.on('will-navigate', (_e, target) => check(target));
    win.on('closed', () => { twitchAuthWin = null; finish({ ok: false, message: 'Autorização cancelada.' }); send('status', snapshot()); });
    win.loadURL(url);
  });
}

ipcMain.handle('twitch:setApi', async (_e, { clientId, clientSecret } = {}) => {
  const id = String(clientId || '').trim();
  // Client ID e Client Secret da Twitch têm 30 letras/números: mais que isso costuma ser duas colagens juntas.
  if (id && !/^[a-z0-9]{30}$/i.test(id)) return { ...snapshot(), error: `O Client ID deve ter 30 letras e números (este tem ${id.length}). Apague o campo inteiro e cole de novo só o Client ID.` };
  const sec = String(clientSecret || '').trim();
  if (sec && !/^[a-z0-9]{30}$/i.test(sec)) return { ...snapshot(), error: `O Client Secret deve ter 30 letras e números (este tem ${sec.length}). Apague o campo e cole de novo só o segredo.` };
  if (id !== config.twitchClientId) config.twitchToken = ''; // o token é do app antigo
  config.twitchClientId = id;
  if (clientSecret != null && String(clientSecret).trim()) config.twitchClientSecret = String(clientSecret).trim();
  if (!id) config.twitchClientSecret = '';
  saveConfig();
  await syncTwitchAuth();
  await refreshTwitch();
  reconcileWatchers();
  return snapshot();
});
ipcMain.handle('twitch:connectChat', async () => ({ ...(await connectTwitchChat()), state: snapshot() }));
ipcMain.handle('twitch:disconnectChat', async () => {
  config.twitchToken = ''; saveConfig();
  await syncTwitchAuth();
  return snapshot();
});

// Sair da conta: apaga cookies, cache e tudo que as páginas guardaram, inclusive o login do
// Google, Apple ou Discord. A lista de canais e as preferências ficam.
ipcMain.handle('logout', async () => {
  const { response } = await (HEADLESS ? dialog.showMessageBox : (o) => dialog.showMessageBox(mainWin, o))({
    type: 'question', buttons: ['Sair da Kick', 'Sair da Twitch', 'Cancelar'], defaultId: 2, cancelId: 2,
    title: 'Sair da conta', message: 'De qual conta você quer sair neste PC?',
    detail: 'Os dados de login salvos no app para essa plataforma serão apagados. Para farmar de novo, será preciso entrar outra vez.',
  });
  if (response === 2) return snapshot();
  const platform = response === 0 ? 'kick' : 'twitch';
  for (const slug of [...watchers.keys()]) if (platformOf(slug) === platform) stopWatcher(slug);
  for (const [slug, win] of storeWindows) if (platformOf(slug) === platform && !win.isDestroyed()) win.close();
  const ses = session.fromPartition(platform === 'kick' ? PARTITION : TWITCH_PARTITION);
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
  ses.flushStorageData();
  for (const key of [...status.keys()]) if (platformOf(key) === platform) status.delete(key);
  if (platform === 'twitch') { config.twitchToken = ''; saveConfig(); await syncTwitchAuth(); }
  else await loadApi(LIGHT_URL);
  await poll();
  return snapshot();
});
ipcMain.handle('store:open', (_e, slug) => openStore(slug));
// Mostra a live de verdade, com imagem, som e qualidade normal (e o aviso +18, se houver, para a pessoa confirmar).
ipcMain.handle('channel:show', (_e, slug) => {
  let win = watchers.get(slug);
  if (!win) { startWatcher(slug); win = watchers.get(slug); }
  userOpened.add(win);
  win.webContents.setAudioMuted(false);
  win.setOpacity(1);
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  win.setSize(960, 600); win.center();
  win.show(); win.focus();
  win.loadURL(channelUrl(slug)); // à vista: a página inteira do canal, com chat e tudo
  const s = status.get(slug);
  if (s) s.ageGate = false;
  send('status', snapshot());
});
ipcMain.handle('chat:send', async (_e, { chatroomId, content }) => {
  if (platformOf(chatroomId) === 'twitch') return twitchChat.send(nameOf(chatroomId), content);
  const { status: code, json } = await kickFetch(`/api/v2/messages/send/${chatroomId}`, {
    method: 'POST', body: { content, type: 'message' },
  });
  return { ok: code >= 200 && code < 300, status: code, message: json && (json.message || (json.status && json.status.message)) };
});

// Só uma instância: abrir o atalho de novo traz a janela existente para frente.
if (!app.requestSingleInstanceLock()) app.quit();
// Abrir de novo traz a janela; a principal religando uma alt que já roda por trás não mostra nada.
app.on('second-instance', (_e, argv) => { if (HEADLESS && (argv || []).includes('--tk-fundo')) return; showMain(); });
// Identificador próprio: a barra de tarefas usa o ícone do TK MultiStream, não o do Kickterino instalado.
app.setAppUserModelId(ACCOUNT ? `com.streamterino.app.${ACCOUNT}` : 'com.streamterino.app');

app.whenReady().then(() => {
  loadConfig();
  setupSession();
  loadPokeExtensions();
  // Conta alt por trás: sem janela nenhuma (quem mostra é a janela da principal).
  if (!HEADLESS) {
    mainWin = new BrowserWindow({
      width: 1100, height: 760, backgroundColor: '#1a1a1a', title: APP_TITLE,
      show: !process.argv.includes('--hidden'), // ao iniciar com o Windows, abre direto na bandeja
      icon: path.join(__dirname, 'build', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    mainWin.setMenuBarVisibility(false);
    // Sem isto o Windows mostra na barra de tarefas (e ao fixar) o ícone do electron.exe, um átomo.
    if (process.platform === 'win32') {
      const ico = path.join(__dirname, 'build', 'terino-atomo.ico');
      const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
      mainWin.setAppDetails({
        appId: ACCOUNT ? `com.streamterino.app.${ACCOUNT}` : 'com.streamterino.app',
        appIconPath: fs.existsSync(ico) ? ico : path.join(__dirname, 'build', 'icon.ico'),
        appIconIndex: 0,
        relaunchCommand: app.isPackaged ? `"${exe}"${ACCOUNT ? ` --conta=${ACCOUNT}` : ''}`
          : `"${exe}" "${app.getAppPath()}"${ACCOUNT ? ` --conta=${ACCOUNT}` : ''}`,
        relaunchDisplayName: APP_TITLE,
      });
    }
    mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    // Fechar a janela não para o farm: o app continua na bandeja, perto do relógio.
    mainWin.on('close', (e) => {
      if (app.isQuitting) return;
      e.preventDefault();
      mainWin.hide();
      if (!config.trayHintShown) {
        config.trayHintShown = true;
        saveConfig();
        notify('O TK MultiStream continua farmando', isLinux
          ? 'Ele fica na bandeja do sistema. Se o ícone não aparecer, abra o TK MultiStream de novo pelo menu de apps. Para sair de vez, use o botão Sair.'
          : 'Ele fica na bandeja, perto do relógio. Para sair de vez: botão direito no ícone > Sair.', showMain);
      }
    });
    // Desligar ou reiniciar o Windows não pode ficar preso na janela escondida.
    mainWin.on('query-session-end', () => { app.isQuitting = true; });
    mainWin.on('session-end', () => { app.isQuitting = true; });
  }
  if (ACCOUNT) startControlServer();

  if (!HEADLESS) createTray();
  syncKeepAwake();
  // Principal: liga as contas alt (cada uma roda por trás e farma com os logins dela).
  if (!ACCOUNT) for (const id of pokeAccountIds()) if (id !== POKE_MAIN) startCore(id);
  powerMonitor.on('resume', recoverAfterResume);
  setupAutoUpdate();
  createApiWindow();
  // O chat da Twitch não depende da página da Kick: conecta já.
  syncTwitchAuth().finally(() => {
    syncTwitchChat();
    refreshTwitch().then(() => send('status', snapshot())).catch(() => {});
  });
  apiReady.then(poll).then(() => {
    if (process.env.KICKTERINO_LIMIT_AUTOSTART) { startLimitTest(); reconcileWatchers(); }
  });
  if (!ACCOUNT) setInterval(watchPokeAccounts, POKE_WATCH_MS); // contas do PokeIdle: modo, leitura e vigia
  if (!ACCOUNT) startExtras(); // overlay do OBS, painel no celular e backups
  scheduleTwitchSweep(90 * 1000); // primeira passada pelos saldos da Twitch logo depois de abrir
  setInterval(poll, POLL_MS);
  setInterval(() => send('status', snapshot()), 15 * 1000);
  setInterval(() => { checkBonusEnding(); checkAutoXp().catch((e) => autoXpLog('erro: ' + (e && e.stack || e))); updateTray(); }, 30 * 1000);
  setTimeout(syncPartners, 30 * 1000);
  setInterval(syncPartners, 6 * 60 * 60 * 1000);
});

app.on('before-quit', () => { app.isQuitting = true; twitchChat.close(); if (!ACCOUNT) quitAltCores(); });
app.on('window-all-closed', () => { if (!HEADLESS) app.quit(); }); // a alt sai quando a principal manda
