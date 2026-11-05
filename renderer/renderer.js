// Streamterino — interface (abas estilo Chatterino). O chat chega do processo principal,
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

// ---------- Abas ----------
function renderTabs() {
  const nav = $('#tabs');
  nav.replaceChildren();
  // Favoritos primeiro (só na tela: a ordem da lista, usada sem o foco em bônus, não muda).
  const favs = new Set(state.favorites || []);
  const ordered = [...state.channels.filter((c) => favs.has(c.slug)), ...state.channels.filter((c) => !favs.has(c.slug))];
  for (const ch of ordered) {
    const queued = ch.live && !ch.watching;
    const t = el('div', 'tab' + (ch.live ? ' live' : '') + (queued ? ' queued' : '') + (ch.ageGate ? ' age' : '') + (ch.slug === active ? ' active' : '') + (ch.watching ? ' watching' : ''));
    if (favs.has(ch.slug)) t.append(el('span', 'fav-star', '★ '));
    const plat = el('span', `plat ${ch.platform === 'twitch' ? 'twitch' : 'kick'}`, ch.platform === 'twitch' ? 'T' : 'K');
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

function select(slug) {
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
  th.append(el('span', `plat ${platform}`, platform === 'twitch' ? 'T' : 'K'),
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
  $('#sleep-box').hidden = !state.sleepMode;
  $('#summary').textContent = !state.loggedIn && !(state.twitch || {}).loggedIn ? `${live} ao vivo · Faça login para farmar pontos` : `${live} ao vivo · ${watching} assistindo`
    + (queued ? (state.rotation ? ` · ${queued} na fila (foco no próximo bônus)` : ` · ${queued} sem vaga`) : '')
    + ` · ${totalPts.toLocaleString('pt-BR')} pts`
    + (gained ? ` (+${gained.toLocaleString('pt-BR')} nesta sessão)` : '');
}

function applyState(s) {
  const prevLive = new Map(state.channels.map((c) => [c.slug, c.live]));
  celebrate(state, s);
  state = s;
  for (const ch of state.channels) {
    const was = prevLive.get(ch.slug);
    if (was === false && ch.live) pushMessage(ch.slug, systemMessage(`${ch.displayName} entrou ao vivo.`));
    if (was === true && !ch.live) pushMessage(ch.slug, systemMessage(`${ch.displayName} está offline.`));
  }
  if (!active && state.channels.length) active = state.channels[0].slug;
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
  head.append(el('span', `plat ${platform}`, platform === 'twitch' ? 'T' : 'K'), el('b', null, platform === 'twitch' ? 'Twitch' : 'Kick'));
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
  const open = (state.pokeIdle || {}).open;
  const btn = el('button', 'poke-open', open ? '🎮 PokeIdle aberto' : '🎮 Abrir PokeIdle');
  btn.title = 'Abre o jogo numa janela do Streamterino. Enquanto ele estiver aberto, o app lê sozinho o tempo do Bônus Twitch e do Bônus Kick. Jogue por essa janela: o PokeIdle só aceita uma sessão por conta.';
  btn.onclick = async () => applyState(await window.kick.openPokeIdle());
  bar.append(btn);
  box.append(bar);
  const cols = el('div', 'bonus-cols');
  cols.append(bonusColumn('twitch', state.twitchBonuses, now), bonusColumn('kick', state.bonuses, now));
  box.append(cols);
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
    box.append(list);
  }
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
}
function closeModal() {
  if (modalKind === 'intro') window.kick.introDone().then(applyState);
  modalKind = null;
  $('#modal').hidden = true;
}
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
const button = (text, cls, onclick) => { const b = el('button', cls, text); b.onclick = onclick; return b; };

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
  head.append(el('span', 'brand', 'S'), el('b', null, ' Streamterino · minha semana'), el('span', 'report-date', new Date().toLocaleDateString('pt-BR')));
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
    wrap.append(el('h3', null, 'Bem-vindo ao Streamterino 👋'));
    const steps = [
      ['1. Faça login', 'Clique em Login Kick e entre com sua conta (e-mail, Google, Apple ou Discord).'],
      ['2. Escolha seu bônus', 'Em Bônus, deixe Automático ou escolha XP, Capture Boost ou Secret Lure.'],
      ['3. Acompanhe no painel', 'Em Pontos ▸ você vê o saldo de cada canal, a previsão do próximo bônus e quanto tempo falta no seu bônus ativo.'],
      ['4. Compre na loja', 'O ícone de pontos ao lado do chat abre a loja do canal. A compra é sempre feita por você.'],
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
$('#btn-panel').onclick = () => {
  const p = $('#panel');
  p.hidden = !p.hidden;
  $('#btn-panel').textContent = p.hidden ? 'Pontos ▸' : 'Pontos ◂';
};
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

window.kick.getState().then((s) => { applyState(s); if (active) select(active); });
