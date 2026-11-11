// TK MultiStream — interface (abas por canal). O chat chega do processo principal,
// que o lê das janelas da live (só canais ao vivo que estão sendo assistidos).
const MAX_MESSAGES = 400;

const $ = (sel) => document.querySelector(sel);
let state = { channels: [], farming: true, maxWatchers: 10 };
let active = null;
const buffers = new Map();   // slug -> array de elementos .msg
const unread = new Set();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function timeStr(d = new Date()) {
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// Converte "[emote:123:nome]" (Kick) e "[temote:id:nome]" (Twitch) em imagens; o resto vira
// texto puro (sem innerHTML).
const EMOTE_RE = /\[(emote|temote):([\w-]+):([^\]]*)\]/g;
const emoteUrl = (kind, id) => (kind === 'temote'
  ? `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`
  : `https://files.kick.com/emotes/${id}/fullsize`);
function appendContent(parent, content) {
  const re = new RegExp(EMOTE_RE.source, 'g');
  let last = 0, m;
  while ((m = re.exec(content))) {
    if (m.index > last) parent.append(content.slice(last, m.index));
    const img = el('img', 'emote');
    img.src = emoteUrl(m[1], m[2]);
    img.alt = img.title = m[3];
    parent.append(img);
    last = re.lastIndex;
  }
  if (last < content.length) parent.append(content.slice(last));
}

// Menção ao seu nome e sorteios ganham destaque (e aviso, se a janela não estiver à vista).
const GIVEAWAY = /\b(sorteio|sorteando|giveaway|!sorteio|!giveaway|!sortear)\b/i;
function chatFlags(data, slug) {
  const text = String(data.content || '');
  const mine = String(slug).startsWith('twitch:') ? (state.twitch || {}).chatUser : state.username;
  const me = mine && mine.toLowerCase();
  const mention = !!me && (data.sender && data.sender.username || '').toLowerCase() !== me
    && new RegExp(`(^|[^a-z0-9_])@?${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`, 'i').test(text);
  return { mention, giveaway: GIVEAWAY.test(text) };
}

function renderChat(data, flags = {}) {
  const wrap = document.createDocumentFragment();
  const replyTo = data.metadata && data.metadata.original_sender;
  if (data.type === 'reply' && replyTo) {
    wrap.append(el('div', 'msg reply-to', `↪ respondendo @${replyTo.username}: ${(data.metadata.original_message || {}).content || ''}`));
  }
  const row = el('div', 'msg' + (flags.mention ? ' mention' : '') + (flags.giveaway ? ' giveaway' : ''));
  row.append(el('span', 'time', timeStr(new Date(data.created_at || Date.now()))));
  if (flags.giveaway) row.append(el('span', 'badge giveaway-tag', '🎉 SORTEIO'));
  const identity = (data.sender && data.sender.identity) || {};
  for (const b of identity.badges || []) row.append(el('span', `badge ${b.type}`, b.text || b.type));
  const user = el('span', 'user', data.sender ? data.sender.username : '?');
  user.style.color = identity.color || '#ccc';
  row.append(user, ': ');
  appendContent(row, data.content || '');
  wrap.append(row);
  return wrap;
}

function systemMessage(text) {
  const row = el('div', 'msg system');
  row.append(el('span', 'time', timeStr()), text);
  return row;
}

function pushMessage(slug, node) {
  const nodes = node instanceof DocumentFragment ? [...node.childNodes] : [node];
  const buf = buffers.get(slug) || [];
  buf.push(...nodes);
  while (buf.length > MAX_MESSAGES) { const old = buf.shift(); old.remove(); }
  buffers.set(slug, buf);
  if (slug === active) {
    const box = $('#messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.append(...nodes);
    if (atBottom) box.scrollTop = box.scrollHeight;
  } else if (!unread.has(slug)) {
    unread.add(slug);
    renderTabs();
  }
}

// Ícone de cada plataforma (logo da Kick e da Twitch), ao lado do nome do canal.
const PLAT_SVG = {
  twitch: 'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z',
  kick: 'M1.5 0h8v5.3h2.7V2.7h2.6V0h8v8h-2.6v2.7h-2.7v2.6h2.7V16h2.6v8h-8v-2.7h-2.6v-2.6H9.5V24h-8z',
};
function platIcon(platform) {
  const span = el('span', `plat ${platform}`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', PLAT_SVG[platform]);
  svg.append(p);
  span.append(svg);
  span.title = platform === 'twitch' ? 'Twitch' : 'Kick';
  return span;
}

// ---------- Abas ----------
function renderTabs() {
  const nav = $('#tabs');
  nav.replaceChildren();
  // Favoritos primeiro (só na tela: a ordem da lista, usada sem o foco em bônus, não muda).
  const favs = new Set(state.favorites || []);
  const ordered = [...state.channels.filter((c) => favs.has(c.slug)), ...state.channels.filter((c) => !favs.has(c.slug))];
  // O PokeIdle da conta escolhida (barra de contas) é a primeira aba: o jogo aparece no lugar do chat.
  const me = currentAccount();
  const myPoke = (((state.pokeIdle || {}).accounts) || []).find((a) => a.id === me) || {};
  if (myPoke.open) {
    const t = el('div', 'tab poke-tab' + (pokeMode ? ' active' : ''));
    t.append(el('span', null, '🎮 PokeIdle'));
    const x = el('span', 'poke-close', '✕');
    x.title = 'Fechar o PokeIdle desta conta (encerra a sessão do jogo no app)';
    x.onclick = async (e) => { e.stopPropagation(); pokeMode = false; setFocusMode(false); applyState(await window.kick.closePokeIdle(me)); };
    t.append(x);
    t.title = 'Jogo desta conta. Clique num canal para voltar ao chat; o jogo continua rodando.';
    t.onclick = () => showPoke(me);
    nav.append(t);
  }
  if (pokeMode) {
    const full = el('div', 'tab poke-full', '⛶ Só o jogo');
    full.title = 'Esconde o topo, as abas e o painel: o PokeIdle ocupa a janela (F11)';
    full.onclick = () => setFocusMode(true);
    nav.append(full);
    nav.append(gridButton('tab poke-grid'));
  }
  if (focusMode) renderFocusBar();
  // Lista de canais recolhível: fica uma linha só (o jogo/chat ganha altura).
  const toggle = el('div', 'tab tabs-toggle', tabsCollapsed ? `▾ Canais (${ordered.length})` : '▴');
  const watching = ordered.filter((c) => c.watching).length;
  toggle.title = tabsCollapsed ? `Mostrar os canais (${watching} assistindo agora)` : 'Recolher a lista de canais';
  toggle.onclick = () => {
    tabsCollapsed = !tabsCollapsed;
    try { localStorage.setItem('tabsCollapsed', tabsCollapsed ? '1' : '0'); } catch {}
    renderTabs();
  };
  nav.append(toggle);
  if (tabsCollapsed) {
    // Recolhida: só o canal aberto no chat (se não for o jogo na tela), para saber onde está.
    const cur = !pokeMode && ordered.find((c) => c.slug === active);
    if (cur) {
      const t = el('div', 'tab active' + (cur.watching ? ' watching' : ''));
      t.append(platIcon(cur.platform === 'twitch' ? 'twitch' : 'kick'), el('span', null, cur.displayName));
      nav.append(t);
    }
    return;
  }
  for (const ch of ordered) {
    const queued = ch.live && !ch.watching;
    const t = el('div', 'tab' + (ch.live ? ' live' : '') + (queued ? ' queued' : '') + (ch.ageGate ? ' age' : '') + (ch.slug === active && !pokeMode ? ' active' : '') + (ch.watching ? ' watching' : ''));
    if (favs.has(ch.slug)) t.append(el('span', 'fav-star', '★ '));
    const plat = platIcon(ch.platform === 'twitch' ? 'twitch' : 'kick');
    plat.title = ch.platform === 'twitch' ? 'Canal da Twitch' : 'Canal da Kick';
    t.append(plat);
    const name = el('span', unread.has(ch.slug) && ch.slug !== active ? 'unread' : '', ch.displayName);
    t.append(name);
    if (ch.subscribed) { const s = el('span', 'tab-sub', 'SUB'); s.title = 'Você é sub: pontos em dobro'; t.append(s); }
    if (ch.live) t.append(el('span', 'dot'));
    t.title = ch.liveUnknown ? 'Twitch: status ao vivo desconhecido (configure a API da Twitch)' : !ch.live ? 'offline'
      : `AO VIVO · ${ch.viewers} espectadores\n${ch.title}`
        + (queued ? (ch.platform === 'twitch' ? '\nNa fila: entra quando abrir uma vaga' : '\nNa fila: entra quando abrir uma vaga (o chat aparece quando estiver assistindo)') : '')
        + (ch.watching ? '\nAssistindo agora: o app está farmando pontos aqui' : '');
    t.onclick = () => select(ch.slug);
    nav.append(t);
  }
  const add = el('div', 'tab add', '+');
  add.title = 'Adicionar canal';
  add.onclick = () => {
    const input = el('input');
    input.placeholder = 'canal da Kick ou twitch:canal';
    add.replaceChildren(input);
    input.focus();
    const done = async (commit) => {
      if (commit && input.value.trim()) { const res = await window.kick.addChannel(input.value); applyState(res); if (res.added) select(res.added); }
      renderTabs();
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
    input.onblur = () => done(false);
  };
  nav.append(add);
}

let tabsCollapsed = false;
try { tabsCollapsed = localStorage.getItem('tabsCollapsed') === '1'; } catch {}

// ---------- PokeIdle no lugar do chat ----------
let pokeMode = false;
const chatRect = () => {
  const r = $('#chat-col').getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};
async function showPoke(id = currentAccount()) {
  pokeMode = id;
  renderTabs();
  applyState(await window.kick.showPokeIdle(id, chatRect()));
}
function leavePoke() {
  if (!pokeMode) return;
  setFocusMode(false);
  pokeMode = false;
  window.kick.hidePokeIdle();
}

// ---------- Grade: todos os PokeIdle lado a lado ----------
function gridButton(cls) {
  const on = !!(state.pokeIdle || {}).grid;
  const b = el(cls.startsWith('tab') ? 'div' : 'button', cls + (on ? ' on' : ''), on ? '▣ Um por vez' : '▦ Grade');
  b.title = on ? 'Volta a mostrar só o PokeIdle da conta escolhida' : 'Mostra o PokeIdle de todas as contas lado a lado (abre os que faltam)';
  b.onclick = async () => {
    if (!on) toast('Abrindo o PokeIdle de todas as contas na grade…');
    applyState(await window.kick.pokeGrid(!on, currentAccount(), chatRect()));
  };
  return b;
}

// ---------- Modo só o jogo ----------
// Esconde o topo, as abas dos canais e o painel: o PokeIdle ocupa a janela. O farm continua.
// Fica uma faixa fina com as contas do jogo e o botão de voltar; F11 liga e desliga.
let focusMode = false;
function setFocusMode(on) {
  on = !!on && !!pokeMode;
  if (on === focusMode) return;
  focusMode = on;
  document.body.classList.toggle('poke-focus', on);
  $('#focus-bar').hidden = !on;
  renderFocusBar();
  requestAnimationFrame(() => { if (pokeMode) window.kick.pokeIdleBounds(chatRect()); });
}
function renderFocusBar() {
  const bar = $('#focus-bar');
  bar.replaceChildren();
  if (!focusMode) return;
  // As contas, para trocar de jogo sem sair do modo: cada uma abre o PokeIdle dela.
  for (const acc of ((state.tk || {}).accounts || [{ id: 'principal', label: 'Principal' }])) {
    const b = el('button', 'focus-acc' + (currentAccount() === acc.id ? ' on' : ''), `🎮 ${acc.label}`);
    b.onclick = async () => { await switchAccount(acc.id); showPoke(acc.id); };
    bar.append(b);
  }
  bar.append(gridButton('focus-grid'));
  bar.append(el('span', 'focus-fill'));
  const sair = el('button', 'focus-exit', '⤢ Mostrar tudo (F11)');
  sair.title = 'Volta a mostrar o topo, as abas e o painel';
  sair.onclick = () => setFocusMode(false);
  bar.append(sair);
}
document.addEventListener('keydown', (e) => { if (e.key === 'F11') { e.preventDefault(); setFocusMode(!focusMode); } });

// ---------- Contas do PokeIdle (painel) ----------
// Um cartão por conta: o que o app leu do jogo (nick, nível, XP/h, ouro), o estado (vigia) e o modo
// de tela do jogo. Embaixo, os ajustes de economia e do vigia.
const POKE_MODE_LABELS = [['cena', 'Cena'], ['otimizado', 'Otimizado'], ['economia', 'Economia'], ['ultra', 'ULTRA']];
const fmtK = (n) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} mi` : n >= 1e3 ? `${Math.round(n / 1e3)} mil` : String(n));
let pokeSettingsOpen = false;

function renderPokeBox() {
  const box = $('#poke-box');
  if (!box) return;
  if (box.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName)) return; // editando
  const p = state.pokeIdle || {};
  const contas = p.contas || [];
  const set = p.settings || { vigia: {} };
  box.replaceChildren();
  for (const c of contas) {
    const card = el('div', 'pk-card' + (c.problem === 'semAbate' ? ' warn' : c.problem ? ' bad' : '') + (c.open ? '' : ' closed'));
    const top = el('div', 'pk-top');
    const st = !c.open ? ['fechada', 'off'] : c.problem === 'deslogou' ? ['deslogou', 'bad'] : c.problem === 'parada' ? ['sem XP', 'bad']
      : c.problem === 'semAbate' ? [`caçando · ${c.semXpMin || 10} min sem abate`, 'warn']
      : c.logged === false ? ['sem login', 'warn'] : c.logged ? ['caçando', 'ok'] : ['abrindo…', 'off'];
    top.append(el('b', null, c.label), el('span', `pk-chip ${st[1]}`, st[0]));
    const sel = el('select', 'pk-mode');
    for (const [v, t] of POKE_MODE_LABELS) { const o = el('option', null, t); o.value = v; sel.append(o); }
    sel.value = c.mode;
    sel.title = 'Modo de tela do jogo para esta conta (quando estiver na tela). ULTRA gasta bem menos memória e CPU.';
    sel.onchange = async () => applyState(await window.kick.pokeSetMode(c.id, sel.value));
    top.append(sel);
    card.append(top);
    if (c.open) {
      const linha = [c.nick, c.level ? `Nv ${c.level}` : null, c.xpH != null ? `${fmtK(c.xpH)} XP/h` : null, c.gold ? `💰 ${c.gold}` : null].filter(Boolean).join(' · ');
      card.append(el('div', 'pk-info', linha || 'Lendo o jogo…'));
      // Previsão de shiny da sessão da conta; as dicas aparecem ao passar o mouse.
      const sp = c.shinyPrev;
      if (sp) {
        const partes = [sp.ver ? `ver ~1 a cada ${sp.ver}` : null, sp.capturar ? `capturar ~1 a cada ${sp.capturar}` : null].filter(Boolean);
        const txt = sp.outland ? 'Na Outland não existe shiny' : sp.medindo ? 'Previsão de shiny: medindo a sessão…' : partes.length ? 'Shiny: ' + partes.join(' · ') : '';
        if (txt) { const n = el('div', 'pk-note', `✨ ${txt}${sp.mult > 1 ? ` (Lure ×${String(sp.mult).replace('.', ',')})` : ''}`); n.title = sp.dicas.join('\n'); card.append(n); }
      }
      if (c.modeNow && c.modeNow !== c.mode) card.append(el('div', 'pk-note', `Agora em ${POKE_MODE_LABELS.find((m) => m[0] === c.modeNow)?.[1] || c.modeNow} (fora da tela)`));
    } else {
      const open = el('button', 'pk-open', 'Abrir');
      open.onclick = async () => { await switchAccount(c.id).catch(() => {}); showPoke(c.id); };
      card.append(open);
    }
    card.onclick = (e) => { if (e.target === card || e.target.classList.contains('pk-info')) { switchAccount(c.id).then(() => showPoke(c.id)); } };
    box.append(card);
  }
  box.append(button('⚙ Vigia, avisos e economia', 'pk-test', () => openSettings('vigia')));
}

// Campos de Configurações → Vigia e avisos / Economia (antes ficavam escondidos no painel).
function buildPokeSettings(tab) {
  const set = (state.pokeIdle || {}).settings || { vigia: {} };
  const det = el('div', 'pk-settings-tab');
  const row = (label, input, hint) => { const r = el('label', 'pk-row'); r.append(input, el('span', null, label)); if (hint) r.title = hint; return r; };
  const chk = (on, fn) => { const i = el('input'); i.type = 'checkbox'; i.checked = !!on; i.onchange = () => fn(i.checked); return i; };
  const save = async (patch) => applyState(await window.kick.pokeSettings(patch));
  det.append(row('Ao abrir o app, abrir todos os PokeIdle em grade', chk(set.startGrid, (v) => save({ startGrid: v })),
    'Cada PokeIdle aberto gasta uns 600 MB de memória.'));
  det.append(row('ULTRA nas contas fora da tela', chk(set.autoUltra, (v) => save({ autoUltra: v })),
    `Depois de ${set.ultraDelayMin || 3} min fora da tela, a conta vai para o ULTRA (bem menos memória e CPU). Ao voltar para a tela, volta ao modo escolhido.`));
  const opt = el('select');
  for (const [v, t] of [[0, 'Nunca'], [60, 'A cada 1 h'], [120, 'A cada 2 h'], [240, 'A cada 4 h'], [360, 'A cada 6 h']]) { const o = el('option', null, t); o.value = v; opt.append(o); }
  opt.value = String(set.optimizeMin || 0);
  opt.onchange = () => save({ optimizeMin: Number(opt.value) });
  det.append(row('Recarregar as contas fora da tela (libera memória)', opt, 'O jogo vai acumulando memória com o tempo; recarregar a página resolve.'));
  const vig = set.vigia || {};
  det.append(row('Vigia: avisar quando uma conta cair, deslogar, travar ou parar de ganhar XP', chk(vig.on, (v) => save({ vigiaOn: v }))));
  const par = el('select');
  for (const v of [5, 10, 15, 30]) { const o = el('option', null, `${v} min`); o.value = v; par.append(o); }
  par.value = String(vig.paradaMin || 10);
  par.onchange = () => save({ paradaMin: Number(par.value) });
  det.append(row('Sem ganhar XP por', par));
  const ntfy = el('input'); ntfy.placeholder = 'tópico do ntfy (opcional)'; ntfy.value = vig.ntfy || '';
  ntfy.onchange = () => save({ ntfy: ntfy.value });
  det.append(row('Aviso no celular (app ntfy, assine o mesmo tópico)', ntfy, 'Instale o app ntfy no celular e assine um tópico com nome difícil de adivinhar. Os avisos chegam por ele.'));
  const disc = el('input'); disc.placeholder = 'webhook do Discord (opcional)'; disc.value = vig.discord || '';
  disc.onchange = () => save({ discord: disc.value });
  det.append(row('Aviso no Discord (webhook de um canal seu)', disc));
  const test = el('button', 'pk-test', 'Testar aviso');
  test.onclick = async () => { await window.kick.pokeTestAlert(); toast('Aviso de teste enviado.'); };
  det.append(test);
  if (tab === 'vigia') for (const n of [...det.children].slice(0, 3)) n.remove(); // grade ao abrir, ULTRA e recarregar ficam em Economia
  else for (const n of [...det.children].slice(3)) n.remove();
  return det;
}

// ---------- 🧰 Extras: overlay do OBS, painel no celular e backups ----------
async function renderExtrasModal(message = '') {
  const info = await window.kick.extrasInfo();
  if (!info) { toast('Os extras ainda estão iniciando.'); return; }
  const wrap = el('div', 'extras-modal');
  wrap.append(el('h3', null, '🧰 Extras'));
  const copyRow = (url) => {
    const r = el('div', 'ex-url');
    const i = el('input'); i.readOnly = true; i.value = url || '—';
    const b = button('Copiar', null, async () => { await window.kick.extrasCopy(url); toast('Link copiado.'); });
    b.disabled = !url;
    r.append(i, b);
    return r;
  };
  const toggle = (label, on, fn) => {
    const l = el('label', 'toggle ex-toggle');
    const c = el('input'); c.type = 'checkbox'; c.checked = !!on;
    c.onchange = async () => { await fn(c.checked); renderExtrasModal(); };
    l.append(c, ` ${label}`);
    return l;
  };

  const ov = el('section', 'ex-sec');
  ov.append(el('h4', null, '🎥 Overlay para o OBS'),
    el('p', null, 'Um card com o nick, o nível, o XP/h e o tempo dos bônus da Twitch e da Kick da conta na tela. No OBS: Fontes → + → Navegador, cole o link, largura 420 e altura 160. O fundo é transparente.'),
    toggle('Ligar o overlay', info.overlayOn, (v) => window.kick.extrasSet({ overlayOn: v })));
  if (info.overlayOn) {
    ov.append(copyRow(info.overlayUrl),
      el('p', 'ex-note', 'Para fixar uma conta no overlay, acrescente ?conta=NOME ao link (ex.: …/overlay?conta=alt-1). Sem isso, mostra a conta escolhida na barra.'));
  }
  wrap.append(ov);

  const cel = el('section', 'ex-sec');
  cel.append(el('h4', null, '📱 Painel no celular'),
    el('p', null, 'Abra o link no navegador do celular: todas as contas, o estado de cada uma, os bônus e o farm. Em cada conta, tocar num bônus compra 1 h dele na hora, e há dois botões para destravar quando ela para de caçar: Recarregar (o F5 do jogo) e Resetar /hunt. O link tem uma chave só sua: não compartilhe.'),
    toggle('Ligar o painel no celular', info.mobileOn, (v) => window.kick.extrasSet({ mobileOn: v })));
  if (info.mobileOn) {
    cel.append(el('h5', null, '🏠 Em casa (no mesmo Wi-Fi do PC)'),
      info.mobileUrl ? copyRow(info.mobileUrl) : el('p', 'ex-note', 'Não encontrei o PC na rede (sem Wi-Fi ou cabo?).'));
    cel.append(el('h5', null, '🌎 Fora de casa (5G, outro Wi-Fi)'));
    if (info.remoteUrl) {
      cel.append(copyRow(info.remoteUrl), el('p', 'ex-note', 'Pelo Tailscale: funciona em qualquer lugar com o Tailscale ligado no celular, na mesma conta do PC. Só os seus aparelhos chegam nele.'));
    } else {
      cel.append(el('p', 'ex-note', 'Instale o Tailscale (tailscale.com/download) no PC e no celular e entre com a mesma conta nos dois. Depois feche e abra esta tela: o link de fora de casa aparece aqui.'));
    }
    const send = button('📲 Mandar o link para o celular', null, async () => {
      const res = await window.kick.extrasSendLink();
      toast(res.error ? res.error : 'Link enviado: toque na notificação do ntfy no celular.');
    });
    const sendBar = el('div', 'ex-actions');
    sendBar.append(send);
    cel.append(sendBar, el('p', 'ex-note', 'O botão manda o link pelo ntfy (o mesmo dos avisos do vigia). Na primeira vez o Windows pode perguntar se o app pode usar a rede: permita.'));
  }
  wrap.append(cel);

  const bk = el('section', 'ex-sec');
  bk.append(el('h4', null, '💾 Backups'),
    el('p', null, 'Uma cópia das configurações de todas as contas (canais, bônus, preferências) é feita sozinha uma vez por dia, na pasta Documentos › TK MultiStream › backups. Os logins não entram no backup.'));
  const bar = el('div', 'ex-actions');
  bar.append(button('Fazer backup agora', 'primary', async () => {
    const r = await window.kick.extrasBackup();
    renderExtrasModal(r.error ? `Erro: ${r.error}` : `Backup feito (${r.files} arquivo(s)).`);
  }), button('Abrir a pasta', null, () => window.kick.extrasOpenBackups()));
  bk.append(bar);
  const list = el('div', 'ex-backups');
  for (const name of info.backups || []) {
    const row = el('div', 'ex-backup');
    const [d, h] = name.split('_');
    row.append(el('span', null, `${d.split('-').reverse().join('/')} ${h.slice(0, 2)}:${h.slice(2)}`));
    const rb = button('Restaurar', null, async () => {
      if (!rb.classList.contains('armed')) { rb.classList.add('armed'); rb.textContent = 'Restaurar e reiniciar?'; return; }
      const r = await window.kick.extrasRestore(name);
      if (r.error) renderExtrasModal(`Erro: ${r.error}`); else toast('Backup restaurado. O app vai reiniciar.');
    });
    row.append(rb);
    list.append(row);
  }
  if (!(info.backups || []).length) list.append(el('p', 'ex-note', 'Nenhum backup ainda.'));
  bk.append(list);
  wrap.append(bk);

  if (message) wrap.append(el('p', 'ex-msg', message));
  const actions = el('div', 'modal-actions');
  actions.append(button('Fechar', null, closeModal));
  wrap.append(actions);
  if (modalKind === 'settings') {
    // Dentro de Configurações: sem título e sem o Fechar próprios.
    wrap.querySelector('h3')?.remove();
    wrap.querySelector('.modal-actions')?.remove();
    const body = $('#settings-body');
    if (body && settingsTab === 'extras') body.replaceChildren(wrap);
  } else if (modalKind === 'extras') $('#modal-card').replaceChildren(wrap);
}
$('#btn-extras').onclick = () => openSettings('extras');

// Bônus sempre ligados (vale para a conta escolhida na barra): XP e Capture, na Twitch e na Kick,
// com o cálculo de quanto cada plataforma rende e quantas horas por dia isso paga.
const AUTO_BONUS_ROWS = [['xp', '+15% XP', 300], ['captura', '+15% Capture', 500]];
function buildAutoBonusSettings() {
  const acc = ((state.tk || {}).accounts || []).find((a) => a.id === currentAccount()) || {};
  const auto = state.autoBonus || {};
  const plan = state.autoPlan || {};
  const fmt = (v) => Math.round(v).toLocaleString('pt-BR');
  const dec = (v) => (Math.round(v * 10) / 10).toLocaleString('pt-BR');
  const det = el('div', 'pk-settings-tab');
  det.append(el('p', 'settings-intro', `Faltando 6 min para um bônus marcado acabar, o app compra 1 h no canal com mais pontos daquela plataforma (conta ${acc.label || 'Principal'}). Pontos da Twitch só compram bônus da Twitch, e os da Kick só da Kick. Na mesma plataforma o XP vem primeiro: o Capture só compra se sobrar saldo para a próxima hora de XP.`));
  const table = el('table', 'auto-bonus');
  const head = el('tr');
  head.append(el('th', null, 'Sempre ligado'), el('th', null, 'Twitch'), el('th', null, 'Kick'));
  table.append(head);
  for (const [tipo, name, cost] of AUTO_BONUS_ROWS) {
    const tr = el('tr');
    tr.append(el('td', null, `${name} · ${cost}/h`));
    for (const platform of ['twitch', 'kick']) {
      const td = el('td');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = !!(auto[tipo] && auto[tipo][platform]);
      c.onchange = async () => {
        applyState(await window.kick.setAutoBonus(tipo, platform, c.checked));
        toast(`${name} na ${platform === 'twitch' ? 'Twitch' : 'Kick'}: ${c.checked ? 'sempre ligado' : 'renovação automática desligada'}.`);
        det.replaceWith(buildAutoBonusSettings());
      };
      td.append(c);
      tr.append(td);
    }
    table.append(tr);
  }
  det.append(table);
  for (const platform of ['twitch', 'kick']) {
    const label = platform === 'twitch' ? 'Twitch' : 'Kick';
    const p = plan[platform];
    const want = AUTO_BONUS_ROWS.filter(([tipo]) => auto[tipo] && auto[tipo][platform]);
    if (!p || !p.inUse) {
      if (want.length) det.append(el('p', 'ex-note', `${label}: nenhum saldo lido nesta conta (faça login na ${label}).`));
      continue;
    }
    let line = `${label}: ${fmt(p.stock)} pontos guardados`;
    if (!p.earn) {
      line += '; ainda medindo quanto rende por dia.';
    } else {
      const per = p.earn.perDay;
      line += ` · rende ~${fmt(per)}/dia${p.earn.days ? '' : ` (pelas últimas ${p.earn.hours} h)`}`;
      if (want.length) {
        const need = want.reduce((sum, [, , cost]) => sum + cost * 24, 0);
        let left = per;
        const parts = want.map(([, name, cost]) => {
          const h = Math.min(24, left / cost);
          left -= h * cost;
          return `${name.replace('+15% ', '')} ${dec(h)} h`;
        });
        line += ` · ${want.map(([, name]) => name.replace('+15% ', '')).join(' + ')} 24 h custa ${fmt(need)}/dia → `;
        line += per >= need
          ? `dá para tudo, e sobram ${fmt(per - need)}/dia.`
          : `o ganho paga ${parts.join(' + ')} por dia; com o guardado, fica tudo ligado por mais ~${dec(p.stock / (need - per))} dia(s).`;
      }
    }
    det.append(el('p', 'ex-note', line));
  }
  return det;
}

// ---------- ⚙ Configurações ----------
// Tudo que é ajuste num lugar só, aberto pela engrenagem da barra de contas.
let settingsTab = 'vigia';
const SETTINGS_TABS = [['bonus', '🎁 Bônus'], ['vigia', '🚨 Vigia e avisos'], ['economia', '⚡ Economia'], ['extras', '🧰 Extras']];
function openSettings(tab = settingsTab) {
  settingsTab = tab;
  const wrap = el('div', 'settings-modal');
  wrap.append(el('h3', null, '⚙ Configurações'));
  const tabs = el('div', 'settings-tabs');
  for (const [id, label] of SETTINGS_TABS) {
    const b = button(label, 'settings-tab' + (id === tab ? ' on' : ''), () => openSettings(id));
    tabs.append(b);
  }
  wrap.append(tabs);
  const body = el('div', null); body.id = 'settings-body';
  wrap.append(body);
  const actions = el('div', 'modal-actions');
  actions.append(button('Fechar', null, closeModal));
  wrap.append(actions);
  openModal('settings', wrap);
  if (tab === 'extras') renderExtrasModal();
  else if (tab === 'bonus') body.append(buildAutoBonusSettings());
  else {
    body.append(el('p', 'settings-intro', tab === 'vigia'
      ? 'O vigia confere as contas do PokeIdle a cada minuto e avisa quando uma conta cai, desloga, trava ou fica sem ganhar XP. O aviso no PC é sempre feito; celular e Discord são opcionais.'
      : 'Para gastar menos memória e CPU com várias contas do PokeIdle abertas.'));
    body.append(buildPokeSettings(tab));
  }
}

// ---------- Barra de contas ----------
// Principal e alts lado a lado no topo. Escolher uma conta faz a janela inteira (canais, painel,
// logins, bônus e o PokeIdle) mostrar aquela conta; todas continuam farmando ao mesmo tempo.
const currentAccount = () => (state.tk && state.tk.active) || 'principal';
async function switchAccount(id) {
  if (id === currentAccount()) return;
  const wasPoke = !!pokeMode;
  const res = await window.kick.switchAccount(id);
  if (res.error) { toast(res.error); return; }
  applyState(res);
  // O jogo na tela acompanha a conta.
  if (wasPoke) {
    const acc = ((res.pokeIdle || {}).accounts || []).find((a) => a.id === id) || {};
    if (acc.open) showPoke(id); else { leavePoke(); }
  }
}
function renderAccountsBar() {
  const bar = $('#accounts-bar');
  const tk = state.tk || { active: 'principal', accounts: [{ id: 'principal', label: 'Principal', connected: true }] };
  bar.replaceChildren();
  for (const acc of tk.accounts) {
    const b = el('div', 'acc-tab' + (acc.id === tk.active ? ' on' : '') + (acc.connected ? '' : ' off'));
    b.append(el('span', 'acc-ico', acc.id === 'principal' ? '★' : '👤'), el('span', null, acc.label));
    b.title = acc.connected ? `Mostrar a conta ${acc.label}` : `A conta ${acc.label} está abrindo…`;
    b.onclick = () => switchAccount(acc.id);
    if (acc.id !== 'principal') {
      const x = el('span', 'acc-x', '✕');
      x.title = `Tirar a conta ${acc.label} da barra (o farm dela para; os logins ficam guardados)`;
      x.onclick = async (e) => {
        e.stopPropagation();
        if (!x.classList.contains('armed')) {
          x.classList.add('armed'); x.textContent = 'tirar?';
          setTimeout(() => { if (x.isConnected) { x.classList.remove('armed'); x.textContent = '✕'; } }, 4000);
          return;
        }
        if (currentAccount() === acc.id) leavePoke();
        applyState(await window.kick.removeTkAccount(acc.id));
      };
      b.append(x);
    }
    bar.append(b);
  }
  const add = el('div', 'acc-tab acc-add', '＋ conta');
  add.title = 'Nova conta: ela farma com a Kick e a Twitch dela e tem o PokeIdle dela';
  add.onclick = () => {
    const input = el('input');
    input.placeholder = 'nome (ex.: alt-4)';
    input.maxLength = 20;
    add.replaceChildren(input);
    input.focus();
    const done = async (commit) => {
      if (commit && input.value.trim()) {
        toast('Abrindo a conta nova…');
        const res = await window.kick.addTkAccount(input.value);
        if (res.error) toast(res.error);
        if (res.channels) applyState(res);
        if (res.added && !res.error) toast(`Conta ${res.added} pronta: faça o Login Kick e o Login Twitch dela.`);
      }
      renderAccountsBar();
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
    input.onblur = () => done(false);
  };
  bar.append(add);
  const all = el('div', 'acc-tab acc-all', '🎮 Abrir todos');
  all.title = 'Abre o PokeIdle de todas as contas de uma vez (cada um gasta uns 600 MB) e mostra o da conta escolhida';
  all.onclick = async () => {
    toast('Abrindo o PokeIdle de todas as contas…');
    const id = currentAccount();
    pokeMode = id;
    renderTabs();
    applyState(await window.kick.openAllPoke(id, chatRect()));
  };
  bar.append(all);
  const gear = el('div', 'acc-tab acc-gear', '⚙');
  gear.title = 'Configurações: vigia e avisos, economia, overlay, celular e backups';
  gear.onclick = () => openSettings();
  bar.append(gear);
}
window.kick.onFocusToggle(() => setFocusMode(!focusMode));
// A área do chat muda de tamanho (janela, painel de pontos, abas em mais linhas): o jogo acompanha.
new ResizeObserver(() => { if (pokeMode) window.kick.pokeIdleBounds(chatRect()); }).observe($('#chat-col'));
new ResizeObserver(() => { if (pokeMode) window.kick.pokeIdleBounds(chatRect()); }).observe($('#tabs'));

function select(slug) {
  leavePoke();
  active = slug;
  unread.delete(slug);
  const box = $('#messages');
  box.replaceChildren(...(buffers.get(slug) || []));
  box.scrollTop = box.scrollHeight;
  renderTabs();
  renderHeader();
  $('#input').focus();
}

function renderHeader() {
  const ch = state.channels.find((c) => c.slug === active);
  const title = $('#chat-title');
  title.replaceChildren();
  const fav = !!ch && (state.favorites || []).includes(ch.slug);
  $('#btn-fav').textContent = fav ? '★' : '☆';
  $('#btn-fav').classList.toggle('on', fav);
  if (!ch) return;
  title.append(el('b', null, ch.displayName), ch.platform === 'twitch' ? ' (Twitch)' : '',
    ch.liveUnknown ? ' · status desconhecido' : ch.live ? ` · AO VIVO · ${ch.viewers} · ${ch.title}` : ' · offline');
  if (ch.ageGate) {
    const warn = el('button', 'age-gate', '⚠ Canal +18: clique para confirmar a idade');
    warn.title = `A ${ch.platform === 'twitch' ? 'Twitch' : 'Kick'} pede confirmação de idade antes de tocar esta live. Sem isso, ela não conta pontos.`;
    warn.onclick = () => window.kick.showChannel(ch.slug);
    title.prepend(warn, ' ');
  }
  $('#input').placeholder = ch.platform === 'twitch' && !(state.twitch || {}).chatUser
    ? 'Só leitura: conecte o chat no botão "Twitch" para enviar mensagens'
    : ch.chatroomId ? `Enviar mensagem em ${ch.displayName}…` : 'Carregando canal…';
  const pts = $('#points-val');
  const text = ch.points != null ? `${ch.pointsApprox ? '≈' : ''}${ch.points.toLocaleString('pt-BR')}` : '—';
  if (pts.textContent !== text) {
    if (pts.textContent !== '—' && ch.points != null) {
      const btn = $('#btn-points');
      btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump');
    }
    pts.textContent = text;
  }
}

// ---------- Teste de limite ----------
function resultLines(results) {
  return results.map((r) => `${r.lives} lives → +${r.pts} pts em ${r.minutes} min (≈ ${r.counting} lives contando)`);
}

function renderLimitTest() {
  const t = state.limitTest;
  const info = $('#limit-info');
  const btn = $('#btn-limit');
  info.replaceChildren();
  if (t) {
    btn.textContent = 'Cancelar teste';
    info.append(el('div', 'limit-now',
      `Etapa ${t.step}/${t.steps}: ${t.lives} lives · ${t.warming ? 'aquecendo' : 'medindo'} · ${t.leftMin} min nesta etapa (~${t.totalLeftMin} min no total)`));
    for (const line of resultLines(t.results)) info.append(el('div', null, line));
    return;
  }
  btn.textContent = state.limitResult ? 'Refazer teste de limite' : 'Descobrir limite de lives';
  btn.disabled = !state.loggedIn;
  btn.title = state.loggedIn ? 'Abre todas as lives ao vivo e mede quantas a Kick conta; se não forem todas, testa números menores (~20 min por etapa) e ajusta o app para o que rende mais pontos' : 'Faça login na Kick para testar';
  const r = state.limitResult;
  if (!r) return;
  info.append(el('div', 'limit-now', `Último teste (${new Date(r.at).toLocaleString('pt-BR')}): usando ${r.chosen} lives`));
  for (const line of resultLines(r.results)) info.append(el('div', null, line));
}

// Selo de sub: estrela + "SUB ×2" (o sub ganha pontos em dobro no canal).
function subBadge() {
  const b = el('span', 'sub-badge');
  b.title = 'Você é sub: pontos em dobro aqui. Com o foco ligado, este canal vem primeiro enquanto estiver ao vivo.';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const star = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  star.setAttribute('d', 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3 6.1 20.6l1.3-6.6L2.5 9.4l6.6-.8z');
  svg.append(star);
  b.append(svg, el('span', null, 'SUB'), el('i', null, '×2'));
  return b;
}

// ---------- Painel / status ----------
function renderPanel() {
  let totalPts = 0, gained = 0, watching = 0, live = 0;
  const queued = state.channels.filter((c) => c.live && !c.watching).length;
  // Uma tabela por plataforma, lado a lado, cada uma com o título e o total dela.
  for (const platform of ['kick', 'twitch']) {
  const group = state.channels.filter((c) => (c.platform || 'kick') === platform);
  const table = $(`#pts-${platform}`);
  const rows = table.querySelector('tbody');
  rows.replaceChildren();
  table.hidden = !group.length;
  if (!group.length) continue;
  const groupPts = group.reduce((t, c) => t + (c.points || 0), 0);
  const groupLive = group.filter((c) => c.live).length;
  const th = table.querySelector('caption');
  th.replaceChildren();
  th.append(platIcon(platform),
    el('b', null, platform === 'twitch' ? 'Twitch' : 'Kick'),
    el('span', 'plat-sum', ` · ${groupLive}/${group.length} ao vivo · `
      + (platform === 'twitch' && !group.some((c) => c.points != null) ? 'saldo aparece ao assistir' : `${group.some((c) => c.pointsApprox) ? '≈' : ''}${groupPts.toLocaleString('pt-BR')} pts`)));
  if (platform === 'twitch') th.title = 'O saldo de cada canal da Twitch é lido da página da live enquanto ela está sendo assistida (acima de 1.000 vem arredondado).';
  for (const ch of group) {
    if (ch.points != null) totalPts += ch.points;
    if (ch.gained > 0) gained += ch.gained;
    if (ch.watching) watching++;
    if (ch.live) live++;
    const tr = el('tr');
    const st = ch.ageGate ? el('span', 'pill age', 'CONFIRMAR +18')
      : ch.earning === 'earning' ? el('span', 'pill watching', 'GANHANDO')
      : ch.earning === 'warming' ? el('span', 'pill warming', 'AQUECENDO')
      : ch.earning === 'idle' ? el('span', 'pill stalled', 'SEM PONTOS')
      : ch.earning === 'watching' ? el('span', 'pill watching', 'ASSISTINDO')
      : ch.liveUnknown ? el('span', 'pill', '?')
      : ch.live ? el('span', 'pill queue', state.rotation ? 'NA FILA' : 'SEM VAGA') : el('span', 'pill', 'offline');
    if (ch.earning === 'warming') st.title = 'A Kick dá a primeira contagem ~6–7 min depois que a live abre.';
    if (ch.earning === 'watching') st.title = 'Assistindo. O saldo da Twitch acima de 1.000 vem arredondado, então o app não mede o ganho; o baú de bônus é coletado sozinho.';
    if (ch.liveUnknown) st.title = 'Configure a API da Twitch para saber quem está ao vivo.';
    if (ch.earning === 'idle') st.title = 'Tocando há mais de 13 min sem o saldo subir. A Kick só conta ~2 lives por vez.';
    if (ch.live && ch.goalLeft != null && state.rotation) st.title = `${st.title || ''}\nFaltam ${ch.goalLeft} pts para ${ch.goal}`.trim();
    const tdStatus = el('td'); tdStatus.append(st);
    if (ch.error) tdStatus.title = ch.error;
    const tdPts = el('td', null, ch.points != null ? `${ch.pointsApprox ? '≈' : ''}${ch.points.toLocaleString('pt-BR')}` : '—');
    if (ch.bonusClaims) { const bz = el('span', 'claims', ` 🎁${ch.bonusClaims}`); bz.title = `Baús de bônus coletados nesta sessão: ${ch.bonusClaims}`; tdPts.append(bz); }
    if (ch.gained > 0) tdPts.append(' ', el('span', 'gain', `+${ch.gained}`));
    const eta = etaText(ch);
    if (eta) { const e = el('div', 'eta', eta); e.title = 'Previsão pelo ritmo da Kick: 10 pts a cada 5 min (20 para subs)'; tdPts.append(e); }
    const tdName = el('td', null, ch.displayName);
    if (ch.following) { const f = el('span', 'follow', '♥'); f.title = 'Você segue este canal'; tdName.append(' ', f); }
    if (ch.subscribed) tdName.append(' ', subBadge());
    tr.append(tdName, tdStatus, tdPts);
    tr.title = `Assistido: ${ch.watchedMin} min`;
    tr.style.cursor = 'pointer';
    tr.onclick = () => select(ch.slug);
    rows.append(tr);
  }
  }
  renderLimitTest();
  renderBonusBox();
  renderPokeBox();
  $('#sleep-box').hidden = !state.sleepMode;
  $('#summary').textContent = !state.loggedIn && !(state.twitch || {}).loggedIn ? `${live} ao vivo · Faça login para farmar pontos` : `${live} ao vivo · ${watching} assistindo`
    + (queued ? (state.rotation ? ` · ${queued} na fila (foco no próximo bônus)` : ` · ${queued} sem vaga`) : '')
    + ` · ${totalPts.toLocaleString('pt-BR')} pts`
    + (gained ? ` (+${gained.toLocaleString('pt-BR')} nesta sessão)` : '');
}

function applyState(s) {
  // Respostas que não trazem a barra de contas mantêm a que já estava.
  if (!s.tk && state.tk) s = { ...s, tk: state.tk };
  // Trocou de conta: nada de confete nem "entrou ao vivo" comparando contas diferentes.
  const sameAccount = ((state.tk || {}).active || 'principal') === ((s.tk || {}).active || 'principal');
  const prevLive = new Map(sameAccount ? state.channels.map((c) => [c.slug, c.live]) : []);
  if (sameAccount) celebrate(state, s);
  state = s;
  if (!sameAccount && modalKind === 'redeem') closeModal();
  if (active && !state.channels.some((c) => c.slug === active)) active = null;
  renderAccountsBar();
  for (const ch of state.channels) {
    const was = prevLive.get(ch.slug);
    if (was === false && ch.live) pushMessage(ch.slug, systemMessage(`${ch.displayName} entrou ao vivo.`));
    if (was === true && !ch.live) pushMessage(ch.slug, systemMessage(`${ch.displayName} está offline.`));
  }
  if (!active && state.channels.length) active = state.channels[0].slug;
  // A conta do PokeIdle na tela foi fechada (ou caiu): volta para o chat.
  if (pokeMode && !(((state.pokeIdle || {}).accounts || []).find((a) => a.id === pokeMode) || {}).open) { pokeMode = false; setFocusMode(false); }
  // Conta alt: o nome dela aparece na marca e no título, para não confundir as janelas.
  const appName = state.account ? `TK MultiStream · ${state.account}` : 'TK MultiStream';
  // No topo fica só o ícone; nas alts, um selinho com o nome da conta.
  const tag = state.account || '';
  if ($('.brand-name').textContent !== tag) { $('.brand-name').textContent = tag; $('.brand-name').hidden = !tag; }
  if (document.title !== appName) document.title = appName;
  $('#farming').checked = state.farming;
  $('#low-quality').checked = state.lowQuality;
  $('#rotation').checked = state.rotation;
  $('#bonus-target').value = String(state.bonusTarget || 0);
  $('#bonus-target').disabled = !state.rotation;
  $('#autostart').checked = !!state.openAtLogin;
  // No Linux a bandeja pode não aparecer (GNOME sem extensão), então o Sair fica também na janela.
  if (state.platform === 'linux') {
    $('#autostart-label span').textContent = 'Iniciar com o sistema';
    $('#autostart-label').title = 'Abre sozinho, direto na bandeja, quando você entra no computador';
    $('#btn-quit').hidden = false;
  }
  $('#notify-bonus').checked = !!state.notifyBonus;
  $('#notify-chat').checked = !!state.notifyChat;
  $('#sleep-mode').checked = !!state.sleepMode;
  if (state.intro && !introShown) { introShown = true; showIntro(state.intro); }
  if (!$('#modal').hidden && modalKind === 'sleep') renderSleepList();
  $('#memory').textContent = state.memoryMB ? `${state.memoryMB} MB` : '';
  $('#btn-login').textContent = state.loggedIn ? 'Conectado ✓' : 'Login Kick';
  $('#btn-login').classList.toggle('ok', !!state.loggedIn);
  const tw = state.twitch || {};
  $('#btn-login-twitch').textContent = tw.loggedIn ? 'Twitch ✓' : 'Login Twitch';
  $('#btn-login-twitch').classList.toggle('ok', !!tw.loggedIn);
  $('#btn-twitch').classList.toggle('warn', !tw.api);
  $('#btn-twitch').title = tw.api
    ? (tw.chatUser ? `API configurada · chat conectado como ${tw.chatUser}` : 'API configurada · chat só leitura')
    : 'Configure seu app da Twitch para ver quem está ao vivo e enviar mensagens';
  $('#btn-logout').hidden = !state.loggedIn && !tw.loggedIn;
  if (document.activeElement !== $('#max-watchers')) $('#max-watchers').value = state.maxWatchers;
  renderTabs();
  renderHeader();
  renderPanel();
}

// ---------- Bônus ativos e previsão ----------
const clock = (ms) => { const m = Math.max(0, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`; };
const shortName = (name) => name.replace('+15% ', '');

// Previsão do próximo bônus no ritmo da Kick (10 pts a cada 5 min; sub ganha 20).
function etaText(ch) {
  if (!ch.watching || ch.earning === 'idle' || ch.goalLeft == null || ch.goalLeft <= 0) return '';
  const min = Math.ceil(ch.goalLeft / (ch.subscribed ? 4 : 2));
  return `⏱ ${clock(min * 60000)} → ${ch.goal.toLocaleString('pt-BR')}`;
}

// Tempo de bônus com dias: "3d 14h", "5h 20m", "12 min".
const dclock = (ms) => {
  const m = Math.max(0, Math.ceil(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm} min`;
};
// Lê "3d 14h", "2h49m", "90m", "1d" ou "2:30" (h:mm) em milissegundos; null se não entender.
function parseDuration(text) {
  const s = String(text || '').trim().toLowerCase().replace(',', '.');
  if (!s) return null;
  const hm = /^(\d+):(\d{1,2})$/.exec(s);
  if (hm) return (Number(hm[1]) * 60 + Number(hm[2])) * 60000;
  let total = 0, any = false;
  const re = /(\d+(?:\.\d+)?)\s*(dias|dia|d|horas|hora|hrs|hr|h|minutos|minuto|mins|min|m)/g;
  let m;
  while ((m = re.exec(s))) {
    any = true;
    const n = Number(m[1]), u = m[2];
    total += u.startsWith('d') ? n * 1440 : u.startsWith('h') ? n * 60 : n;
  }
  if (!any && /^\d+(\.\d+)?$/.test(s)) { total = Number(s) * 60; any = true; } // número sozinho = horas
  return any ? Math.round(total * 60000) : null;
}

function bonusColumn(platform, list, now) {
  const col = el('div', `bonus-col ${platform}`);
  const head = el('div', 'bonus-col-head');
  head.append(platIcon(platform), el('b', null, platform === 'twitch' ? 'Twitch' : 'Kick'));
  const src = ((state.pokeIdle || {}).source || {})[platform];
  const readAt = (state.pokeIdle || {}).readAt;
  head.append(el('span', 'bonus-src', src === 'jogo' ? ` · lido do jogo${readAt ? ` ${timeStr(new Date(readAt))}` : ''}`
    : src === 'manual' ? ' · digitado' : platform === 'kick' ? ' · pelas compras' : ' · sem leitura'));
  col.append(head);
  for (const b of list || []) {
    const on = b.endsAt && b.endsAt > now;
    const chip = el('div', 'bonus-chip' + (on ? ' on' : ''));
    const left = el('span', 'bonus-left editable', on ? dclock(b.endsAt - now) : 'inativo');
    left.title = 'Clique para digitar quanto falta (ex.: 3d 14h, 2h 49m, 0 para zerar)';
    left.onclick = () => {
      const input = el('input', 'bonus-edit');
      input.value = on ? dclock(b.endsAt - now) : '';
      input.placeholder = 'ex.: 3d 14h';
      left.replaceWith(input);
      input.focus(); input.select();
      let done = false;
      const finish = async (commit) => {
        if (done) return; done = true;
        const ms = commit ? parseDuration(input.value) : null;
        if (commit && ms == null && input.value.trim()) toast('Não entendi o tempo. Use algo como 3d 14h, 2h 49m ou 45m.');
        if (ms != null) applyState(await window.kick.setBonus(platform, b.tipo, ms));
        else renderBonusBox();
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
      input.onblur = () => finish(true);
    };
    chip.append(el('span', 'bonus-name', shortName(b.name)), left);
    const add = el('button', 'bonus-add', '+1h');
    add.title = `Registrar 1 h de ${b.name} resgatada na ${platform === 'twitch' ? 'Twitch' : 'Kick'}`;
    add.onclick = async () => applyState(await window.kick.addPurchase(b.cost, platform));
    chip.append(add);
    if (on) {
      // Zerar: clique uma vez para armar e outra para confirmar (evita zerar sem querer).
      const reset = el('button', 'bonus-reset', '↺');
      reset.title = 'Zerar este cronômetro (para desfazer só um +1h, use o ✕ na lista de compras abaixo)';
      reset.onclick = async () => {
        if (!reset.classList.contains('armed')) {
          reset.classList.add('armed'); reset.textContent = 'zerar?';
          setTimeout(() => { if (reset.isConnected) { reset.classList.remove('armed'); reset.textContent = '↺'; } }, 4000);
          return;
        }
        applyState(await window.kick.setBonus(platform, b.tipo, 0));
      };
      chip.append(reset);
    }
    col.append(chip);
  }
  return col;
}

function renderBonusBox() {
  const box = $('#bonus-box');
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // editando
  box.replaceChildren();
  const now = Date.now();
  const bar = el('div', 'poke-bar');
  const open = (((state.pokeIdle || {}).accounts || []).find((a) => a.id === currentAccount()) || {}).open;
  const btn = el('button', 'poke-open', open ? (pokeMode ? '🎮 PokeIdle na tela' : '🎮 Mostrar PokeIdle') : '🎮 Abrir PokeIdle');
  btn.title = 'Abre o jogo no lugar do chat, numa aba própria. Enquanto ele estiver aberto, o app lê sozinho o tempo do Bônus Twitch e do Bônus Kick. O PokeIdle só aceita uma sessão por conta: se a mesma conta estiver aberta no D2K ou no navegador, uma delas cai.';
  btn.onclick = () => showPoke(currentAccount());
  bar.append(btn);
  // Extensões do Chrome carregadas no PokeIdle; as que têm painel próprio ganham um botão.
  const exts = state.pokeExtensions || [];
  for (const ext of exts.filter((e) => e.cockpit)) {
    const c = el('button', 'poke-ext', `🛰 ${ext.name.replace(/ - .*/, '')}`);
    c.title = `Abre o painel (Cockpit) da extensão ${ext.name}. Ele conversa com o PokeIdle aberto aqui no app.`;
    c.onclick = () => window.kick.openCockpit(ext.id);
    bar.append(c);
  }
  box.append(bar);
  if (exts.length) {
    const note = el('div', 'poke-ext-note', `Extensões no PokeIdle: ${exts.map((e) => `${e.name} ${e.version || ''}`.trim()).join(' · ')}`);
    note.title = 'Carregadas da pasta do seu Chrome. Quando o Chrome atualizar uma delas, o app pega a versão nova ao reiniciar.';
    box.append(note);
  }
  // Tabela com todas as contas: bônus nas linhas, contas nas colunas.
  box.append(bonusMatrix(now));
  // Os cronômetros da conta na tela, para corrigir à mão (+1h, digitar, zerar).
  const det = el('details', 'bonus-edit-box');
  if (bonusEditOpen) det.open = true;
  det.ontoggle = () => { bonusEditOpen = det.open; };
  const acc = (((state.tk || {}).accounts) || []).find((a) => a.id === currentAccount());
  det.append(el('summary', null, `Ajustar tempos de ${acc ? acc.label : 'Principal'}`));
  const cols = el('div', 'bonus-cols');
  cols.append(bonusColumn('twitch', state.twitchBonuses, now), bonusColumn('kick', state.bonuses, now));
  det.append(cols);
  box.append(det);
  const recent = state.purchases || [];
  if (recent.length) {
    const list = el('div', 'purchases');
    for (const p of recent) {
      const name = (BONUS_NAMES[p.cost] || `${p.cost} pts`);
      const ch = state.channels.find((c) => c.slug === p.slug);
      const plat = (p.platform || 'kick') === 'twitch' ? 'Twitch' : 'Kick';
      const row = el('div', 'purchase', `${shortName(name)} · ${plat} · ${ch ? ch.displayName : 'registrado à mão'} · ${timeStr(new Date(p.t))}`);
      const x = el('button', 'purchase-x', '✕');
      x.title = 'Não foi uma compra de bônus? Remove do cronômetro e do relatório';
      x.onclick = async () => applyState(await window.kick.removePurchase(p.t));
      row.append(x);
      list.append(row);
    }
    det.append(list);
  }
}

let bonusEditOpen = false;
const BONUS_ROWS = [['XP', '⚡', 'XP'], ['Capture', '🎯', 'Capture Boost'], ['Lure', '✨', 'Secret Lure']];
// Tempo curto para caber na tabela com várias contas: 2d23h, 8h58, 47m.
const mclock = (ms) => {
  const m = Math.max(0, Math.ceil(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d${h}h` : h ? `${h}h${String(mm).padStart(2, '0')}` : `${mm}m`;
};
function bonusMatrix(now) {
  const accounts = ((state.tk || {}).accounts) || [{ id: 'principal', label: 'Principal', bonus: { twitch: (state.twitchBonuses || []).map((b) => b.endsAt), kick: (state.bonuses || []).map((b) => b.endsAt) } }];
  const t = el('table', 'bonus-matrix');
  const head = el('tr');
  head.append(el('th'));
  for (const a of accounts) {
    const th = el('th', a.id === currentAccount() ? 'on' : '', a.label);
    th.title = `Mostrar a conta ${a.label}`;
    th.onclick = () => switchAccount(a.id);
    head.append(th);
  }
  const thead = el('thead'); thead.append(head); t.append(thead);
  const body = el('tbody');
  for (const platform of ['twitch', 'kick']) {
    const label = platform === 'twitch' ? 'Twitch' : 'Kick';
    const redeemRow = el('tr', `bm-redeem-row ${platform}`);
    const redeemCell = el('td'); redeemCell.colSpan = accounts.length + 1;
    const redeem = button(redeemButtonText(platform), 'poke-redeem poke-redeem-platform', () => openRedeemModal(platform));
    redeem.dataset.platform = platform;
    redeem.title = `Escolha o bônus para resgatar somente nos canais da ${label} desta conta.`;
    redeem.disabled = !(state.channels || []).some((ch) => ch.platform === platform);
    redeemCell.append(redeem); redeemRow.append(redeemCell); body.append(redeemRow);
    const sec = el('tr', `bm-sec ${platform}`);
    const td = el('td'); td.colSpan = accounts.length + 1;
    td.append(platIcon(platform), el('b', null, label));
    sec.append(td); body.append(sec);
    BONUS_ROWS.forEach(([name, ico, full], i) => {
      const tr = el('tr');
      const nm = el('td', 'bm-name', `${ico} ${name}`); nm.title = full;
      tr.append(nm);
      for (const a of accounts) {
        const end = a.bonus && a.bonus[platform] ? a.bonus[platform][i] : null;
        const on = end && end > now;
        const cell = el('td', `bm-cell ${platform}` + (on ? ' on' : '') + (a.id === currentAccount() ? ' cur' : ''), on ? mclock(end - now) : (a.bonus ? '—' : '…'));
        cell.title = on ? `${a.label}: ${full} (${platform === 'twitch' ? 'Twitch' : 'Kick'}) — falta ${dclock(end - now)}, acaba às ${timeStr(new Date(end))}` : (a.bonus ? `${a.label}: sem ${full} ativo` : `${a.label}: ainda carregando`);
        cell.onclick = () => switchAccount(a.id);
        tr.append(cell);
      }
      body.append(tr);
    });
  }
  t.append(body);
  return t;
}
const BONUS_NAMES = { 300: '+15% XP', 500: '+15% Capture Boost', 1000: '+15% Secret Lure' };
setInterval(() => { if (!$('#panel').hidden) renderBonusBox(); }, 20 * 1000);

// ---------- Janela flutuante (relatório, antes de dormir, boas-vindas) ----------
let modalKind = null;
let introShown = false;
function openModal(kind, ...nodes) {
  modalKind = kind;
  $('#modal-card').replaceChildren(...nodes);
  $('#modal').hidden = false;
  // O jogo é desenhado por cima da página: some enquanto a janelinha estiver aberta.
  if (pokeMode) window.kick.hidePokeIdle();
}
function closeModal() {
  if (modalKind === 'intro') window.kick.introDone().then(applyState);
  if (modalKind === 'redeem') { redeemModalAccount = null; redeemModalPlatform = null; }
  modalKind = null;
  $('#modal').hidden = true;
  if (pokeMode) window.kick.showPokeIdle(pokeMode, chatRect());
}
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
const button = (text, cls, onclick) => { const b = el('button', cls, text); b.onclick = onclick; return b; };

const REDEEM_CHOICES = [
  { id: 'xp', icon: '⚡', short: 'XP', name: '+15% XP', cost: 300 },
  { id: 'captura', icon: '🎯', short: 'Capture Boost', name: '+15% Capture Boost', cost: 500 },
  { id: 'shiny', icon: '✨', short: 'Secret Lure', name: '+15% Secret Lure', cost: 1000 },
];
const redeemJobsByAccount = new Map();
const redeemSelectionsByAccount = new Map();
let redeemModalAccount = null;
let redeemModalPlatform = null;
let redeemPollTimer = null;

const redeemJobKey = (account, platform) => `${account}:${platform}`;

function redeemSelectionFor(account = currentAccount(), platform = 'kick') {
  const key = redeemJobKey(account, platform);
  if (redeemSelectionsByAccount.has(key)) return redeemSelectionsByAccount.get(key);
  let saved = 'xp';
  try {
    const value = localStorage.getItem(`redeemBonus:${account}:${platform}`) || localStorage.getItem(`redeemBonus:${account}`);
    if (REDEEM_CHOICES.some((choice) => choice.id === value)) saved = value;
  } catch {}
  redeemSelectionsByAccount.set(key, saved);
  return saved;
}

function setRedeemSelection(account, platform, value) {
  if (!REDEEM_CHOICES.some((choice) => choice.id === value)) return;
  redeemSelectionsByAccount.set(redeemJobKey(account, platform), value);
  try { localStorage.setItem(`redeemBonus:${account}:${platform}`, value); } catch {}
}

function redeemButtonText(platform) {
  const entry = redeemJobsByAccount.get(redeemJobKey(currentAccount(), platform));
  const label = platform === 'twitch' ? 'Twitch' : 'Kick';
  return entry && entry.state && entry.state.status === 'running' ? `🎁 Acompanhar ${label}` : `🎁 Resgatar ${label}`;
}

function startRedeemPolling() {
  if (redeemPollTimer) return;
  redeemPollTimer = setInterval(async () => {
    let currentRunning = false;
    for (const entry of redeemJobsByAccount.values()) {
      if (!entry.state || entry.state.status !== 'running') continue;
      if (entry.account !== currentAccount()) continue;
      currentRunning = true;
      try {
        const fresh = await window.kick.getPokeRedeem(entry.id);
        if (fresh && !fresh.error) entry.state = fresh;
        if (redeemModalAccount === entry.account && redeemModalPlatform === entry.platform && modalKind === 'redeem' && !$('#modal').hidden) {
          renderRedeemProgress(entry.state, entry.account, entry.platform);
        }
      } catch {}
    }
    for (const button of document.querySelectorAll('#bonus-box .poke-redeem-platform')) {
      button.textContent = redeemButtonText(button.dataset.platform);
    }
    if (!currentRunning) { clearInterval(redeemPollTimer); redeemPollTimer = null; }
  }, 1200);
}

function openRedeemModal(platform) {
  redeemModalAccount = currentAccount();
  redeemModalPlatform = platform;
  openModal('redeem', el('div'));
  const entry = redeemJobsByAccount.get(redeemJobKey(redeemModalAccount, platform));
  if (entry && entry.state && entry.state.status === 'running') {
    startRedeemPolling();
    renderRedeemProgress(entry.state, redeemModalAccount, platform);
  } else if (entry && entry.state && ['done', 'cancelled', 'failed'].includes(entry.state.status)) {
    renderRedeemProgress(entry.state, redeemModalAccount, platform);
  } else {
    renderRedeemPicker(platform);
  }
}

function renderRedeemPicker(platform) {
  const wrap = el('div', 'redeem-modal');
  const account = (state.tk && state.tk.accounts || []).find((a) => a.id === currentAccount());
  const platformName = platform === 'twitch' ? 'Twitch' : 'Kick';
  const channels = (state.channels || []).filter((channel) => channel.platform === platform);
  const known = channels.filter((c) => c.points != null).length;
  wrap.append(el('h3', null, `🎁 Resgate automático · ${platformName}`),
    el('p', null, `Escolha o bônus para os canais da ${platformName} na conta ${account ? account.label : 'selecionada'}. Em cada canal com pontos suficientes, o app resgata o maior pacote que o saldo pagar (na Twitch; na Kick, o de 1h) e repete enquanto sobrar saldo. Tudo roda por trás, sem abrir janelas na tela. A escolha fica salva por conta e plataforma.`));
  const options = el('div', 'redeem-options');
  const selectedType = redeemSelectionFor(currentAccount(), platform);
  for (const choice of REDEEM_CHOICES) {
    const card = button('', 'redeem-choice' + (selectedType === choice.id ? ' selected' : ''), () => {
      setRedeemSelection(currentAccount(), platform, choice.id);
      renderRedeemPicker(platform);
    });
    card.setAttribute('aria-pressed', selectedType === choice.id ? 'true' : 'false');
    const copy = el('span', 'redeem-copy');
    copy.append(el('b', null, choice.short), el('small', null, `${choice.name} · ${choice.cost.toLocaleString('pt-BR')} pontos por hora`));
    card.append(el('span', 'redeem-icon', choice.icon), copy);
    options.append(card);
  }
  wrap.append(options);
  const authWarnings = [];
  if (platform === 'kick' && !state.loggedIn) authWarnings.push('Kick desconectada: faça login nesta conta pelo botão “Login Kick”.');
  if (platform === 'twitch' && !(state.twitch || {}).loggedIn) authWarnings.push('Twitch desconectada: faça login nesta conta pelo botão “Login Twitch”.');
  const note = el('p', 'redeem-note' + (authWarnings.length ? ' redeem-auth-warning' : ''),
    `${channels.length} canais da ${platformName} nesta conta · ${known} com saldo lido. O app abre somente os canais desta plataforma que passaram pelo filtro de saldo.${authWarnings.length ? ` ${authWarnings.join(' ')}` : ''}`);
  wrap.append(note);
  const selected = REDEEM_CHOICES.find((x) => x.id === selectedType) || REDEEM_CHOICES[0];
  const actions = el('div', 'modal-actions');
  actions.append(button('Cancelar', null, closeModal), button(`Resgatar ${selected.short} na ${platformName}`, 'primary', () => startRedeemForAll(platform)));
  actions.lastChild.disabled = !channels.length;
  wrap.append(actions);
  $('#modal-card').replaceChildren(wrap);
}

async function startRedeemForAll(platform) {
  const account = currentAccount();
  const start = await window.kick.startPokeRedeem(redeemSelectionFor(account, platform), platform);
  if (!start || start.error) {
    toast((start && start.error) || 'Não foi possível iniciar o resgate.');
    return;
  }
  redeemModalAccount = account;
  redeemModalPlatform = platform;
  redeemJobsByAccount.set(redeemJobKey(account, platform), { account, platform, id: start.id, state: start });
  startRedeemPolling();
  renderRedeemProgress(start, account, platform);
}

function renderRedeemProgress(job, account, platform) {
  if (modalKind !== 'redeem' || redeemModalAccount !== account || redeemModalPlatform !== platform || $('#modal').hidden) return;
  const wrap = el('div', 'redeem-modal');
  const platformName = platform === 'twitch' ? 'Twitch' : 'Kick';
  const choice = REDEEM_CHOICES.find((x) => x.id === job.type) || REDEEM_CHOICES[0];
  wrap.append(el('h3', null, `🎁 ${choice.name} · ${platformName}`));
  if (job.status === 'running') {
    const current = job.current ? ` · ${job.current.label} (${job.current.platform === 'twitch' ? 'Twitch' : 'Kick'})` : '';
    const phase = !job.current ? '' : job.current.phase === 'checking-points' ? ' · conferindo saldo antes de abrir'
      : job.current.phase === 'redeeming' ? ` · compra ${job.current.attempt}` : '';
    wrap.append(el('p', null, `Canal ${Math.min(job.done + 1, job.total)} de ${job.total}${current}${phase}`));
    const progress = el('progress', 'redeem-progress');
    progress.max = Math.max(1, job.total); progress.value = job.done;
    wrap.append(progress, el('p', 'redeem-note', job.cancelRequested ? 'Parando depois do canal atual…' : 'Canais com saldo insuficiente ou não confirmado são pulados sem abrir o chat.'));
  } else {
    const boughtChannels = job.results.filter((r) => r.status === 'redeemed').length;
    const bought = job.results.reduce((sum, r) => sum + (r.status === 'redeemed' ? (r.hours || 1) : 0), 0);
    const sent = job.results.filter((r) => r.status === 'submitted').length;
    const skipped = job.results.filter((r) => r.status === 'skipped').length;
    const failed = job.results.filter((r) => r.status === 'failed').length;
    wrap.append(el('p', null, `${job.status === 'cancelled' ? 'Resgate interrompido.' : job.status === 'failed' ? 'O resgate parou por um erro.' : 'Verificação concluída.'} ${bought} resgate(s) confirmados em ${boughtChannels} canal(is) · ${sent} enviados sem confirmação · ${skipped} sem resgate · ${failed} falharam.`));
  }
  const list = el('div', 'redeem-results');
  for (const r of job.results.slice(-12)) {
    const icon = r.status === 'redeemed' ? '✓' : r.status === 'submitted' ? '…' : r.status === 'failed' ? '!' : '–';
    const row = el('div', `redeem-result ${r.status}`);
    row.append(el('b', null, `${icon} ${r.label || r.slug} · ${r.platform === 'twitch' ? 'Twitch' : 'Kick'}`), el('span', null, r.message || ''));
    list.append(row);
  }
  if (job.results.length) wrap.append(list);
  const actions = el('div', 'modal-actions');
  if (job.status === 'running') {
    actions.append(button(job.cancelRequested ? 'Parando…' : 'Parar após este canal', null, async () => {
      const fresh = await window.kick.cancelPokeRedeem(job.id);
      if (fresh && !fresh.error) {
        const entry = redeemJobsByAccount.get(redeemJobKey(account, platform));
        if (entry) entry.state = fresh;
        renderRedeemProgress(fresh, account, platform);
      }
    }));
    actions.append(button('Fechar (o resgate continua)', null, closeModal));
  } else {
    actions.append(button('Fechar', 'primary', () => {
      redeemJobsByAccount.delete(redeemJobKey(account, platform));
      closeModal();
      renderBonusBox();
    }));
    actions.append(button('Escolher outro bônus', null, () => {
      redeemJobsByAccount.delete(redeemJobKey(account, platform));
      renderRedeemPicker(platform);
      renderBonusBox();
    }));
  }
  wrap.append(actions);
  $('#modal-card').replaceChildren(wrap);
}

// Antes de dormir: canais com pontos para o bônus escolhido; as lojas abrem uma de cada vez.
const sleepPicked = new Set();
function renderSleepList() {
  const cost = state.bonusTarget || 300;
  const name = BONUS_NAMES[cost];
  const rich = state.channels.filter((c) => (c.points || 0) >= cost).sort((a, b) => b.points - a.points);
  for (const s of [...sleepPicked]) if (!rich.some((c) => c.slug === s)) sleepPicked.delete(s);
  const wrap = el('div', 'sleep');
  wrap.append(el('h3', null, '🌙 Antes de dormir'));
  const seq = state.storeSequence;
  if (seq) {
    wrap.append(el('p', null, `Loja ${seq.done} de ${seq.total} aberta. Compre o bônus e feche a janela da loja: a próxima abre sozinha.`),
      button('Parar sequência', null, async () => applyState(await window.kick.cancelStoreSequence())));
    return $('#modal-card').replaceChildren(wrap);
  }
  if (!rich.length) {
    wrap.append(el('p', null, `Nenhum canal tem ${cost} pts para ${name} agora.`), button('Fechar', null, closeModal));
    return $('#modal-card').replaceChildren(wrap);
  }
  const total = rich.reduce((t, c) => t + Math.floor(c.points / cost), 0);
  wrap.append(el('p', null, `Dá para comprar ${total} × ${name} (${total} h de bônus). Escolha os canais e as lojas abrem uma de cada vez: você compra e fecha a janela, e a próxima aparece.`));
  const list = el('div', 'sleep-list');
  for (const c of rich) {
    const row = el('label', 'sleep-row');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = sleepPicked.has(c.slug);
    cb.onchange = () => { if (cb.checked) sleepPicked.add(c.slug); else sleepPicked.delete(c.slug); renderSleepList(); };
    row.append(cb, el('span', null, c.displayName), el('span', 'sleep-pts', `${c.points.toLocaleString('pt-BR')} pts · ${Math.floor(c.points / cost)}×`));
    list.append(row);
  }
  wrap.append(list);
  const go = button(`Abrir ${sleepPicked.size} loja${sleepPicked.size === 1 ? '' : 's'} em sequência`, 'primary', async () => {
    applyState(await window.kick.openStoreSequence(state.channels.filter((c) => sleepPicked.has(c.slug)).map((c) => c.slug)));
  });
  go.disabled = !sleepPicked.size;
  const all = button('Marcar todos', null, () => { for (const c of rich) sleepPicked.add(c.slug); renderSleepList(); });
  const actions = el('div', 'modal-actions');
  actions.append(all, go, button('Fechar', null, closeModal));
  wrap.append(actions);
  $('#modal-card').replaceChildren(wrap);
}

// Relatório da semana, com opção de salvar o card como imagem para postar.
async function showReport() {
  const r = await window.kick.getReport();
  const card = el('div', 'report');
  const head = el('div', 'report-head');
  head.append(el('span', 'brand', 'TK'), el('b', null, ' TK MultiStream · minha semana'), el('span', 'report-date', new Date().toLocaleDateString('pt-BR')));
  const big = el('div', 'report-big');
  const stat = (value, label) => { const d = el('div', 'report-stat'); d.append(el('b', null, value), el('span', null, label)); return d; };
  big.append(stat(r.gained.toLocaleString('pt-BR'), 'pontos ganhos'), stat(String(r.bought.reduce((t, b) => t + b.count, 0)), 'bônus comprados'),
    stat(`${r.bonusHours} h`, 'com bônus ativo'), stat(`${r.coverage}%`, 'do tempo com bônus'));
  const days = el('div', 'report-days');
  const max = Math.max(1, ...r.days.map((d) => d.gained));
  for (const d of r.days) {
    const col = el('div', 'report-day');
    col.title = `${d.day}: ${d.gained} pts · ${d.bought.map((n, i) => `${n}× ${shortName(Object.values(BONUS_NAMES)[i])}`).join(', ')}`;
    const bar = el('i'); bar.style.height = `${Math.round((d.gained / max) * 100)}%`;
    const slot = el('div', 'report-bar'); slot.append(bar);
    col.append(el('small', null, d.gained ? d.gained.toLocaleString('pt-BR') : ''), slot, el('span', null, d.weekday.replace('.', '')));
    days.append(col);
  }
  const periods = el('div', 'report-periods');
  for (const p of r.periods) {
    const row = el('div', 'report-period');
    const track = el('div', 'track'); const fill = el('i'); fill.style.width = `${p.pct}%`; track.append(fill);
    row.append(el('span', null, p.name), track, el('b', null, `${p.pct}%`));
    periods.append(row);
  }
  const line = el('div', 'report-timeline');
  line.title = 'Últimas 24 horas: verde = algum bônus ativo';
  for (const on of r.timeline) line.append(el('i', on ? 'on' : ''));
  const bought = el('div', 'report-bought', r.bought.map((b) => `${b.count}× ${shortName(b.name)}`).join(' · ') + (r.channels ? ` · em ${r.channels} canais` : ''));
  card.append(head, big, el('h4', null, 'Pontos por dia'), days, el('h4', null, 'Bônus ativo por período'), periods,
    el('h4', null, 'Últimas 24 h'), line, bought);
  const actions = el('div', 'modal-actions');
  actions.append(button('💾 Salvar imagem', 'primary', async () => {
    const rect = card.getBoundingClientRect();
    const file = await window.kick.saveReport({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    if (file) actions.replaceChildren(el('span', 'saved', `Imagem salva em ${file}`), button('Fechar', null, closeModal));
  }), button('Fechar', null, closeModal));
  openModal('report', card, actions);
}

// Boas-vindas na primeira vez; depois de atualizar, o que há de novo.
function showIntro(kind) {
  const wrap = el('div', 'intro');
  if (kind === 'welcome') {
    wrap.append(el('h3', null, 'Bem-vindo ao TK MultiStream 👋'));
    const steps = [
      ['1. Faça login', 'Clique em Login Kick e entre com sua conta (e-mail, Google, Apple ou Discord).'],
      ['2. Escolha seu bônus', 'Em Bônus, deixe Automático ou escolha XP, Capture Boost ou Secret Lure.'],
      ['3. Acompanhe no painel', 'Em Pontos ▸ você vê o saldo de cada canal, a previsão do próximo bônus e quanto tempo falta no seu bônus ativo.'],
      ['4. Resgate um bônus', 'Em 🎁 Resgatar (na tabela de bônus), escolha XP, Capture Boost ou Secret Lure. O app resgata em todos os canais desta conta que tiverem pontos.'],
    ];
    for (const [t, d] of steps) { const s = el('div', 'intro-step'); s.append(el('b', null, t), el('span', null, d)); wrap.append(s); }
  } else {
    wrap.append(el('h3', null, `Novidades da versão ${state.version} ✨`));
    const news = [
      '⏱ Bônus ativos: o app percebe a compra pelo saldo, mostra quanto tempo falta e avisa 5 min antes de acabar.',
      '🔮 Previsão: cada canal mostra em quanto tempo chega ao próximo bônus.',
      '📊 Relatório da semana, com imagem pronta para compartilhar.',
      '🌙 Modo antes de dormir (opcional): abre as lojas uma de cada vez para empilhar bônus.',
      '★ Favoritos: ficam no começo das abas e avisam quando entram ao vivo.',
      '🎉 Destaque e aviso quando alguém menciona você ou quando aparece um sorteio no chat.',
      '🤝 Novos parceiros do PokeIdle entram sozinhos na sua lista.',
    ];
    const ul = el('ul');
    for (const n of news) ul.append(el('li', null, n));
    wrap.append(ul);
  }
  const actions = el('div', 'modal-actions');
  actions.append(button('Entendi', 'primary', closeModal));
  wrap.append(actions);
  openModal('intro', wrap);
}

// Aviso de menção ou sorteio quando a janela não está à vista (no máximo um por canal a cada 5 min para sorteio).
const lastGiveawayAlert = new Map();
function chatAlert(slug, data, flags) {
  if (!state.notifyChat) return;
  const ch = state.channels.find((c) => c.slug === slug);
  const name = ch ? ch.displayName : slug;
  const visible = document.hasFocus() && slug === active;
  if (visible) return;
  if (flags.giveaway && !flags.mention) {
    if (Date.now() - (lastGiveawayAlert.get(slug) || 0) < 5 * 60 * 1000) return;
    lastGiveawayAlert.set(slug, Date.now());
  }
  const n = new Notification(flags.mention ? `${data.sender.username} mencionou você em ${name}` : `🎉 Sorteio no chat de ${name}`,
    { body: String(data.content || '').replace(new RegExp(EMOTE_RE.source, 'g'), '$3').slice(0, 140), icon: '../build/icon.png' });
  n.onclick = () => { window.focus(); select(slug); };
}

// ---------- Comemorações: aviso na tela e confete ----------
function toast(text, cls = '') {
  const t = el('div', `toast ${cls}`, text);
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 5000);
}

const CONFETTI_COLORS = ['#53fc18', '#ffcf4a', '#b65ad2', '#ffffff', '#4fc3ff'];
function confetti() {
  const c = $('#confetti');
  const ctx = c.getContext('2d');
  c.width = innerWidth; c.height = innerHeight;
  const parts = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 200, y: innerHeight * .35,
    vx: (Math.random() - .5) * 14, vy: -Math.random() * 12 - 4, r: Math.random() * 6 + 3,
    rot: Math.random() * 6, vr: (Math.random() - .5) * .3, color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
  }));
  const start = performance.now();
  const frame = (t) => {
    ctx.clearRect(0, 0, c.width, c.height);
    const life = (t - start) / 2200;
    for (const p of parts) {
      p.vy += .35; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save(); ctx.globalAlpha = Math.max(0, 1 - life); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.color; ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
    }
    if (life < 1) requestAnimationFrame(frame); else ctx.clearRect(0, 0, c.width, c.height);
  };
  requestAnimationFrame(frame);
}

// Canal que passou de um bônus (300, 500, 1.000 e cada milhar) ganha confete; compra nova ganha aviso.
const tierOf = (p) => (p >= 1000 ? 2 + Math.floor(p / 1000) : [300, 500].filter((c) => p >= c).length);
function celebrate(prev, next) {
  if (!prev.channels.length) return;
  const before = new Map(prev.channels.map((c) => [c.slug, c.points]));
  for (const ch of next.channels) {
    const was = before.get(ch.slug);
    if (was == null || ch.points == null || tierOf(ch.points) <= tierOf(was)) continue;
    const reached = [300, 500, 1000].filter((c) => was < c && ch.points >= c).pop() || Math.floor(ch.points / 1000) * 1000;
    toast(`🎉 ${ch.displayName} chegou a ${reached.toLocaleString('pt-BR')} pts! Já dá para comprar bônus.`, 'gold');
    confetti();
  }
  const lastBefore = (prev.purchases || [])[0];
  for (const p of next.purchases || []) {
    if (lastBefore && p.t <= lastBefore.t) break;
    if (!prev.purchases) break;
    const ch = next.channels.find((c) => c.slug === p.slug);
    toast(`⏱ +1h de ${BONUS_NAMES[p.cost] || 'bônus'}${ch ? ` (${ch.displayName})` : ''} no cronômetro`);
  }
}

// ---------- Eventos ----------
$('#btn-login').onclick = () => window.kick.showLogin('kick');
$('#btn-login-twitch').onclick = () => window.kick.showLogin('twitch');
$('#btn-twitch').onclick = () => { openModal('twitch'); renderTwitchModal(); };
// (o botão Contas virou a barra de contas no topo)

// ---------- Contas (principal + alts) ----------
// Cada conta abre numa janela própria, com logins, canais e bônus só dela.
async function renderAccountsModal(message = '') {
  const accounts = await window.kick.listAccounts();
  const wrap = el('div', 'accounts-modal');
  wrap.append(el('h3', null, '👥 Contas'));
  wrap.append(el('p', null, 'Cada conta abre numa janela própria do TK MultiStream, com os próprios logins da Kick, da Twitch e do PokeIdle. Uma conta nova começa com a sua lista de canais; os logins você faz nela.'));
  const list = el('div', 'accounts-list');
  for (const a of accounts) {
    const row = el('div', 'account-row' + (a.current ? ' current' : ''));
    row.append(el('span', 'account-name', a.label));
    if (a.current) row.append(el('span', 'account-here', 'esta janela'));
    else row.append(button('Abrir', null, async () => { await window.kick.openAccount(a.name); toast(`Abrindo a conta ${a.label}…`); }));
    list.append(row);
  }
  wrap.append(list);
  const form = el('div', 'account-new');
  const input = el('input'); input.placeholder = 'nome da conta nova (ex.: alt1)'; input.maxLength = 20;
  const lbl = el('label', 'toggle');
  const chk = el('input'); chk.type = 'checkbox'; chk.checked = true;
  lbl.append(chk, ' Criar atalho na área de trabalho');
  const msg = el('div', 'account-msg', message);
  const create = async () => {
    if (!input.value.trim()) { input.focus(); return; }
    msg.textContent = 'Criando…';
    const r = await window.kick.createAccount({ name: input.value, shortcut: chk.checked });
    if (!r.ok) { msg.textContent = r.message; return; }
    renderAccountsModal(`Conta "${r.name}" criada e abrindo${r.shortcut ? ' (atalho na área de trabalho)' : ''}. Faça os logins nela.`);
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') create(); };
  form.append(input, button('Criar e abrir', 'primary', create), lbl, msg);
  wrap.append(el('h4', null, 'Nova conta'), form);
  const actions = el('div', 'modal-actions');
  actions.append(button('Fechar', null, closeModal));
  wrap.append(actions);
  if (modalKind === 'accounts') $('#modal-card').replaceChildren(wrap);
}
$('#btn-logout').onclick = async () => applyState(await window.kick.logout());
$('#btn-refresh').onclick = async () => applyState(await window.kick.refresh());
$('#farming').onchange = async (e) => applyState(await window.kick.setFarming(e.target.checked));
$('#btn-limit').onclick = async () => applyState(await (state.limitTest ? window.kick.stopLimitTest() : window.kick.startLimitTest()));
$('#autostart').onchange = async (e) => applyState(await window.kick.setAutostart(e.target.checked));
$('#btn-quit').onclick = () => window.kick.quit();
$('#notify-chat').onchange = async (e) => applyState(await window.kick.setNotifyChat(e.target.checked));
$('#sleep-mode').onchange = async (e) => applyState(await window.kick.setSleepMode(e.target.checked));
$('#btn-sleep').onclick = () => { openModal('sleep'); renderSleepList(); };
$('#btn-report').onclick = showReport;
$('#btn-fav').onclick = async () => active && applyState(await window.kick.toggleFavorite(active));
$('#notify-bonus').onchange = async (e) => applyState(await window.kick.setNotifyBonus(e.target.checked));
$('#rotation').onchange = async (e) => applyState(await window.kick.setRotation(e.target.checked));
$('#bonus-target').onchange = async (e) => applyState(await window.kick.setBonusTarget(Number(e.target.value)));
$('#low-quality').onchange = async (e) => applyState(await window.kick.setLowQuality(e.target.checked));
$('#max-watchers').onchange = async (e) => applyState(await window.kick.setMaxWatchers(e.target.value));
function togglePanel(force) {
  const p = $('#panel');
  p.hidden = typeof force === 'boolean' ? !force : !p.hidden;
  $('#btn-panel').textContent = p.hidden ? 'Pontos ▸' : 'Pontos ◂';
  // » recolhe (o jogo/chat cresce para a direita); « traz o painel de volta.
  $('#panel-toggle').textContent = p.hidden ? '«' : '»';
  $('#panel-toggle').title = p.hidden ? 'Mostrar o painel de pontos' : 'Recolher o painel de pontos (o jogo fica maior)';
  try { localStorage.setItem('panelOpen', p.hidden ? '0' : '1'); } catch {}
}
$('#btn-panel').onclick = () => togglePanel();
$('#panel-toggle').addEventListener('mousedown', (e) => e.stopPropagation()); // clicar não começa o arraste
$('#panel-toggle').onclick = () => togglePanel();
// Volta como estava da última vez.
try { if (localStorage.getItem('panelOpen') === '1') togglePanel(true); else togglePanel(false); } catch {}

// ---------- Divisória: tamanho do jogo/chat x painel ----------
// O jogo é desenhado por cima da página e "rouba" o mouse: some durante o arraste e volta no fim.
const PANEL_MIN = 300;
const CHAT_MIN = 320;
function setPanelWidth(w) {
  const max = Math.max(PANEL_MIN, innerWidth - CHAT_MIN);
  const width = Math.round(Math.min(max, Math.max(PANEL_MIN, w)));
  $('#panel').style.width = `${width}px`;
  return width;
}
try { const saved = Number(localStorage.getItem('panelWidth')); if (saved) setPanelWidth(saved); } catch {}
$('#splitter').addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  // Painel escondido: arrastar faz ele aparecer, já no tamanho que o mouse indicar.
  if ($('#panel').hidden) togglePanel();
  const wasPoke = pokeMode;
  if (wasPoke) window.kick.hidePokeIdle();
  $('#splitter').classList.add('dragging');
  document.body.classList.add('resizing');
  const move = (ev) => setPanelWidth(innerWidth - ev.clientX);
  const up = (ev) => {
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    $('#splitter').classList.remove('dragging');
    document.body.classList.remove('resizing');
    const width = setPanelWidth(innerWidth - ev.clientX);
    try { localStorage.setItem('panelWidth', String(width)); } catch {}
    if (wasPoke && pokeMode) requestAnimationFrame(() => window.kick.showPokeIdle(pokeMode, chatRect()));
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
});
// Para esconder ou mostrar o painel de vez, use o botão "Pontos" no topo.
$('#btn-points').onclick = () => active && window.kick.openStore(active);
$('#btn-show').onclick = () => active && window.kick.showChannel(active);
$('#btn-remove').onclick = async () => {
  if (!active) return;
  const slug = active;
  buffers.delete(slug);
  active = null;
  applyState(await window.kick.removeChannel(slug));
  if (state.channels.length) select(state.channels[0].slug); else $('#messages').replaceChildren();
};
$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#input');
  const ch = state.channels.find((c) => c.slug === active);
  const text = input.value.trim();
  if (!ch || !ch.chatroomId || !text) return;
  input.value = '';
  const res = await window.kick.sendChat(ch.chatroomId, text);
  if (!res.ok) pushMessage(ch.slug, systemMessage(ch.platform === 'twitch' ? `Falha ao enviar: ${res.message}` : `Falha ao enviar (${res.status}${res.message ? ': ' + res.message : ''}). Você fez login?`));
};

window.kick.onStatus(applyState);
window.kick.onSelect((slug) => select(slug));
window.kick.onChat(({ slug, kind, data }) => {
  if (kind === 'message') {
    const flags = chatFlags(data, slug);
    pushMessage(slug, renderChat(data, flags));
    if (flags.mention || flags.giveaway) chatAlert(slug, data, flags);
  }
  else if (kind === 'notice') pushMessage(slug, systemMessage(`ℹ ${data.text}`));
  else if (kind === 'reward') pushMessage(slug, systemMessage(`🎁 ${data.username} resgatou "${data.reward_title}"`));
});
window.kick.onToast((text) => toast(text));

// ---------- Twitch: app do Developer Console e conexão do chat ----------
function renderTwitchModal() {
  const tw = state.twitch || {};
  const wrap = el('div', 'twitch-modal');
  wrap.append(el('h3', null, 'Twitch'));
  wrap.append(el('p', null, 'O chat da Twitch já funciona só para leitura. Para saber quem está ao vivo (e farmar) e para enviar mensagens, crie um app seu em dev.twitch.tv/console/apps: categoria "Chat Bot", OAuth Redirect URL http://localhost, tipo "Confidential". Copie o Client ID e gere um Client Secret.'));
  const id = el('input'); id.placeholder = 'Client ID'; id.value = tw.clientId || '';
  const secret = el('input'); secret.type = 'password'; secret.placeholder = tw.api ? 'Client Secret (salvo; deixe vazio para manter)' : 'Client Secret';
  const msg = el('div', 'twitch-msg', tw.statusError || '');
  wrap.append(el('label', null, 'Client ID'), id, el('label', null, 'Client Secret'), secret, msg);
  const actions = el('div', 'modal-actions');
  actions.append(button('Salvar', 'primary', async () => {
    msg.textContent = 'Salvando…';
    const res = await window.kick.twitchSetApi({ clientId: id.value, clientSecret: secret.value });
    applyState(res);
    msg.textContent = res.error || res.twitch.statusError || 'Salvo. Status ao vivo atualizado.';
  }));
  if (tw.clientId) {
    actions.append(tw.chatUser
      ? button(`Desconectar chat (${tw.chatUser})`, null, async () => { applyState(await window.kick.twitchDisconnectChat()); renderTwitchModal(); })
      : button('Conectar chat (enviar mensagens)', null, async () => {
        msg.textContent = 'Autorize na janela da Twitch…';
        const r = await window.kick.twitchConnectChat();
        applyState(r.state);
        renderTwitchModal();
        $('.twitch-msg').textContent = r.message;
      }));
  }
  actions.append(button('Fechar', null, closeModal));
  wrap.append(actions);
  $('#modal-card').replaceChildren(wrap);
}

// Carga inicial: escolhe o primeiro canal, mas sem tirar ninguém do PokeIdle se ele já estiver na tela.
window.kick.getState().then((s) => {
  applyState(s);
  // Opção da ⚙ Economia: já abre o PokeIdle de todas as contas, lado a lado.
  const poke = s.pokeIdle || {};
  if ((poke.settings || {}).startGrid && !poke.grid) {
    setTimeout(async () => {
      if (pokeMode) return; // a pessoa já abriu o jogo nesse meio-tempo
      const id = currentAccount();
      pokeMode = id;
      renderTabs();
      applyState(await window.kick.pokeGrid(true, id, chatRect()));
    }, 1500);
    return;
  }
  if (active && !pokeMode) select(active);
});
