// Streamterino (antigo Kickterino) — processo principal.
// Ideia: uma sessão de navegador persistente (você faz login na Kick uma vez),
// uma janela oculta "api" em kick.com para consultar status/pontos, e uma janela
// oculta e muda por canal AO VIVO tocando o player real — é isso que conta como "assistindo".
const {
  app, BrowserWindow, dialog, ipcMain, session, Tray, Menu, Notification, nativeImage, powerSaveBlocker, powerMonitor, net,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const twitch = require('./twitch');

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

// Pasta de dados alternativa (testes sem mexer na instalação de verdade).
if (process.env.KICKTERINO_DATA) app.setPath('userData', process.env.KICKTERINO_DATA);
// O app agora se chama Streamterino, mas login, canais e histórico continuam na pasta antiga.
else app.setPath('userData', path.join(app.getPath('appData'), 'Kickterino'));

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
  // O pop-up de login usa a mesma sessão da página que o abriu (Kick ou Twitch).
  wc.setWindowOpenHandler(({ url }) => (isTrustedUrl(url) ? {
    action: 'allow',
    overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { partition: wc.session === session.fromPartition(TWITCH_PARTITION) ? TWITCH_PARTITION
      : wc.session === session.fromPartition(POKEIDLE_PARTITION) ? POKEIDLE_PARTITION : PARTITION } },
  } : { action: 'deny' }));
  const guard = (details) => { if (details.isMainFrame && !isTrustedUrl(details.url)) details.preventDefault(); };
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
function openStore(slug, title = `Pontos — ${slug}`) {
  let win = storeWindows.get(slug);
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 420, height: 720, title, autoHideMenuBar: true, backgroundColor: '#0b0e0f',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { partition: partitionOf(slug) },
  });
  win.loadURL(platformOf(slug) === 'twitch' ? `${TWITCH}/popout/${nameOf(slug)}/chat` : `${KICK}/popout/${slug}/chat`);
  win.on('page-title-updated', (e) => e.preventDefault()); // mantém o "(2 de 4)" do modo antes de dormir
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
  win.loadURL(channelUrl(slug));
  makeInvisible(win);
  // Fechar a live aberta só a torna invisível de novo: volta para 160p, sem som e sem imagens.
  win.on('close', (e) => {
    if (app.isQuitting || watchers.get(slug) !== win) return;
    e.preventDefault();
    makeInvisible(win);
    win.webContents.setAudioMuted(true);
    win.webContents.reload();
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
  matchPurchase(drop).forEach((cost, i) => config.purchases.push({ t: now + i, cost, slug }));
  config.purchases = config.purchases.filter((p) => now - p.t < KEEP_PURCHASES_MS);
  configDirty = true;
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

// ---------- Janela do PokeIdle ----------
// O jogo só aceita UMA sessão por conta: o app não abre o jogo escondido (derrubaria o seu).
// Ele abre o jogo numa janela normal, onde a pessoa joga, e lê os bônus das mensagens que o
// próprio jogo recebe pelo WebSocket dele.
const POKEIDLE_URL = 'https://pokeidle.io/app';
const POKEIDLE_PARTITION = 'persist:pokeidle';
let pokeWin = null;

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

function openPokeIdle() {
  if (pokeWin && !pokeWin.isDestroyed()) { if (pokeWin.isMinimized()) pokeWin.restore(); pokeWin.show(); pokeWin.focus(); return; }
  pokeWin = new BrowserWindow({
    width: 1366, height: 820, title: 'PokeIdle', autoHideMenuBar: true, backgroundColor: '#1b1b1b',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { partition: POKEIDLE_PARTITION, backgroundThrottling: false },
  });
  const dbg = pokeWin.webContents.debugger;
  try { dbg.attach('1.3'); } catch {}
  dbg.on('message', (_e, method, p) => {
    if (method !== 'Network.webSocketFrameReceived') return;
    const text = p.response && p.response.payloadData;
    // Só mensagens que falam de twitch/kick (o jogo manda muita coisa por segundo).
    if (!text || text.length > 2_000_000 || !/"(twitch|kick)"/.test(text) || !text.includes('"bonus"')) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const found = findPokeBonus(msg);
    let changed = false;
    for (const platform of Object.keys(found)) { setPokeBonus(platform, found[platform], 'jogo'); changed = true; }
    if (changed) {
      config.pokeReadAt = Date.now();
      saveConfig(); configDirty = false;
      send('status', snapshot());
      updateTray();
    }
  });
  dbg.sendCommand('Network.enable').catch(() => {});
  pokeWin.loadURL(POKEIDLE_URL);
  pokeWin.on('page-title-updated', (e) => e.preventDefault());
  pokeWin.on('closed', () => { pokeWin = null; send('status', snapshot()); });
  send('status', snapshot());
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
const twitchKeys = () => config.channels.filter((k) => platformOf(k) === 'twitch');
const hasTwitchApi = () => !!(config.twitchClientId && config.twitchClientSecret);

function syncTwitchChat() {
  twitchChat.setChannels(twitchKeys().map(nameOf));
}

async function syncTwitchAuth() {
  if (!config.twitchToken) { twitchUser = null; twitchChat.setAuth(null); return; }
  try {
    const info = await twitch.validateUserToken(net.fetch, config.twitchToken);
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
    const live = await twitch.fetchLive(net.fetch, { clientId: config.twitchClientId, clientSecret: config.twitchClientSecret }, keys.map(nameOf));
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
  if (platformOf(slug) === 'twitch') return; // a Twitch é consultada em lote (refreshTwitch)
  const s = status.get(slug) || { watchedMs: 0 };
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
        if (s.points != null && p < s.points) registerPurchases(slug, s.points - p);
        s.points = p;
        checkBonus(slug, s);
      }
    }
  } catch {}
  status.set(slug, s);
}

// Confere cada live oculta: aviso +18 (só a pessoa pode confirmar) e estado do player, para o
// histórico. O tempo do vídeo NÃO indica se a live conta: no player da Kick ele fica em 0–1 s
// mesmo com os pontos subindo, então quem diz se está valendo é o saldo (ver lastGainAt).
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
  // Na Twitch o app não lê o saldo, então não dá para saber se está rendendo.
  if (platformOf(slug) === 'twitch') return 'watching';
  if (s.lastGainAt && now - s.lastGainAt < EARN_WINDOW_MS) return 'earning';
  if (now - (s.watchingSince || now) < EARN_WINDOW_MS) return 'warming';
  return 'idle';
}

// Histórico em points-log.jsonl (pasta de dados do app): uma linha por minuto com pontos e
// estado de cada live. Serve para conferir se os pontos sobem com o app minimizado.
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
    };
  }
  const line = JSON.stringify({
    t: new Date(now).toISOString(), mainMinimized: !!mainWin && mainWin.isMinimized(),
    mainFocused: !!mainWin && mainWin.isFocused(), loggedIn, memoryMB: snapshot().memoryMB,
    maxWatchers: config.maxWatchers, limitTest: limitTestSnapshot(), channels,
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
    notifyChat: config.notifyChat,
    sleepMode: config.sleepMode,
    favorites: config.favorites,
    username,
    version: app.getVersion(),
    intro: config.lastSeenVersion === app.getVersion() ? null : (firstRun ? 'welcome' : 'news'),
    bonuses: activeBonuses(now, 'kick'),
    twitchBonuses: activeBonuses(now, 'twitch'),
    pokeIdle: { open: !!pokeWin && !pokeWin.isDestroyed(), readAt: config.pokeReadAt || null,
      source: { twitch: pokeBase('twitch').source || null, kick: pokeBase('kick').source || null } },
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
        title: s.title || '', chatroomId: s.chatroomId || null, points: s.points ?? null,
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
const LOGIN_ITEM = { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ['--hidden'] };
// No Linux, abrir com o sistema é um atalho na pasta autostart (o AppImage informa o próprio caminho).
const autostartFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config'), 'autostart', 'kickterino.desktop');
const isOpenAtLogin = () => (isLinux ? fs.existsSync(autostartFile()) : app.getLoginItemSettings(LOGIN_ITEM).openAtLogin);
function setOpenAtLogin(on) {
  if (!isLinux) return app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: on });
  const file = autostartFile();
  if (!on) return fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exe = process.env.APPIMAGE || process.execPath;
  fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Streamterino\nExec="${exe}" --hidden\nIcon=kickterino\nX-GNOME-Autostart-enabled=true\n`);
}

function showMain() {
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
  tray.setToolTip(`Streamterino — ${config.farming ? `${watchers.size} assistindo` : 'farm pausado'}${gained ? ` · +${gained} pts` : ''}`
    + (active.length ? `\nBônus ativo: ${active.join(' · ')}` : ''));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Streamterino', click: showMain },
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

ipcMain.handle('state:get', () => snapshot());
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
ipcMain.handle('pokeidle:open', () => { openPokeIdle(); return snapshot(); });
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
  for (const win of watchers.values()) if (!win.isDestroyed() && !userOpened.has(win)) win.webContents.reload();
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
  const { response } = await dialog.showMessageBox(mainWin, {
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
  win.webContents.reload();
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
app.on('second-instance', showMain);
// Identificador próprio: a barra de tarefas usa o ícone do Streamterino, não o do Kickterino instalado.
app.setAppUserModelId('com.streamterino.app');

app.whenReady().then(() => {
  loadConfig();
  setupSession();
  mainWin = new BrowserWindow({
    width: 1100, height: 760, backgroundColor: '#1a1a1a', title: 'Streamterino',
    show: !process.argv.includes('--hidden'), // ao iniciar com o Windows, abre direto na bandeja
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Fechar a janela não para o farm: o app continua na bandeja, perto do relógio.
  mainWin.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    mainWin.hide();
    if (!config.trayHintShown) {
      config.trayHintShown = true;
      saveConfig();
      notify('O Streamterino continua farmando', isLinux
        ? 'Ele fica na bandeja do sistema. Se o ícone não aparecer, abra o Streamterino de novo pelo menu de apps. Para sair de vez, use o botão Sair.'
        : 'Ele fica na bandeja, perto do relógio. Para sair de vez: botão direito no ícone > Sair.', showMain);
    }
  });
  // Desligar ou reiniciar o Windows não pode ficar preso na janela escondida.
  mainWin.on('query-session-end', () => { app.isQuitting = true; });
  mainWin.on('session-end', () => { app.isQuitting = true; });

  createTray();
  syncKeepAwake();
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
  setInterval(poll, POLL_MS);
  setInterval(() => send('status', snapshot()), 15 * 1000);
  setInterval(() => { checkBonusEnding(); updateTray(); }, 30 * 1000);
  setTimeout(syncPartners, 30 * 1000);
  setInterval(syncPartners, 6 * 60 * 60 * 1000);
});

app.on('before-quit', () => { app.isQuitting = true; twitchChat.close(); });
app.on('window-all-closed', () => app.quit());
