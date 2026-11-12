// TK MultiStream — extras: overlay para o OBS, painel no celular e backups.
// Fica fora do main.js; recebe do main só o que precisa (dados para mostrar e onde gravar).
//
// - Overlay (OBS): http://127.0.0.1:<porta>/overlay — só responde no próprio PC.
// - Painel no celular: http://<IP do PC na rede>:<porta>/celular?t=<chave> (fora de casa: o mesmo link
//   com o IP do PC no Tailscale, a rede privada entre os aparelhos da pessoa) — mostra as contas; em cada
//   uma, tocar num bônus compra 1 h dele, e há Recarregar e Resetar /hunt. Protegido por uma chave
//   aleatória; só fica na rede quando a pessoa liga.
// - Backups: cópia dos config.json de todas as contas (sem logins: os cookies não entram) numa
//   pasta em Documentos, uma vez por dia, mantendo os 10 últimos.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function createExtras(ctx) {
  // ctx: { app, getConfig, saveConfig, data(), dataDirs(), relaunch(), action(conta, acao, extra) }
  let server = null;
  let serverKey = '';

  const cfg = () => ctx.getConfig();
  const port = () => Number(cfg().extrasPort) || 17777;
  // IPv4 do PC: o da rede de casa (Wi-Fi/cabo) e o do Tailscale (faixa 100.64.0.0/10), que liga os
  // aparelhos da pessoa entre si de qualquer lugar (o celular no 5G alcança o PC por ele).
  const isTailscale = (name, ip) => /tailscale/i.test(name) || (() => { const [a, b] = ip.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; })();
  const ipv4s = () => {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const n of list || []) if (n.family === 'IPv4' && !n.internal && !/^169\.254\./.test(n.address)) out.push({ name, address: n.address });
    }
    return out;
  };
  const lanIp = () => {
    const home = ipv4s().filter((n) => !isTailscale(n.name, n.address));
    return (home.find((n) => /^(192\.168|10|172\.(1[6-9]|2\d|3[01]))\./.test(n.address)) || home[0] || {}).address || null;
  };
  const tailscaleIp = () => (ipv4s().find((n) => isTailscale(n.name, n.address)) || {}).address || null;
  const mobileToken = () => {
    if (!cfg().mobileToken) { cfg().mobileToken = crypto.randomBytes(12).toString('hex'); ctx.saveConfig(); }
    return cfg().mobileToken;
  };
  const isLocal = (req) => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');

  function sendJson(res, obj) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  function sendHtml(res, html) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(html);
  }

  function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const c = cfg();
    if (url.pathname === '/overlay' || url.pathname === '/api/overlay') {
      if (!c.overlayOn || !isLocal(req)) { res.writeHead(404); return res.end(); }
      if (url.pathname === '/overlay') return sendHtml(res, OVERLAY_HTML);
      return sendJson(res, ctx.data('overlay', url.searchParams.get('conta')));
    }
    if (url.pathname === '/celular' || url.pathname === '/api/painel') {
      const ok = c.mobileOn && url.searchParams.get('t') === mobileToken();
      if (!ok) { res.writeHead(404); return res.end(); }
      if (url.pathname === '/celular') return sendHtml(res, MOBILE_HTML);
      return sendJson(res, ctx.data('painel'));
    }
    // Botões do painel: { conta, acao: 'reload' | 'hunt' | 'buy' | 'seguir' | 'lure', tipo, plataforma, ligar } por POST, com a mesma chave do link.
    if (url.pathname === '/api/acao') {
      const ok = c.mobileOn && req.method === 'POST' && url.searchParams.get('t') === mobileToken() && ctx.action;
      if (!ok) { res.writeHead(404); return res.end(); }
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 2000) req.destroy(); });
      req.on('end', async () => {
        let msg = {};
        try { msg = JSON.parse(body || '{}'); } catch {}
        const r = await Promise.resolve(ctx.action(String(msg.conta || ''), String(msg.acao || ''), { tipo: String(msg.tipo || ''), plataforma: String(msg.plataforma || ''), ligar: msg.ligar === true })).catch((e) => ({ error: String(e && e.message || e) }));
        sendJson(res, r || {});
      });
      return;
    }
    res.writeHead(404); res.end();
  }

  // Liga/desliga o servidor conforme as opções. Só escuta na rede quando o painel do celular está ligado.
  function sync() {
    const c = cfg();
    const want = c.overlayOn || c.mobileOn;
    const host = c.mobileOn && !process.env.KT_EXTRAS_LOCALONLY ? '0.0.0.0' : '127.0.0.1'; // (teste: só no PC)
    const key = want ? `${host}:${port()}` : '';
    if (key === serverKey) return;
    if (server) { try { server.close(); } catch {} server = null; }
    serverKey = key;
    if (!want) return;
    server = http.createServer(handle);
    server.on('error', () => { serverKey = ''; server = null; });
    server.listen(port(), host);
  }

  function info() {
    const c = cfg();
    const ip = lanIp();
    const ts = tailscaleIp();
    return {
      overlayOn: !!c.overlayOn, mobileOn: !!c.mobileOn, port: port(), running: !!server,
      overlayUrl: `http://127.0.0.1:${port()}/overlay`,
      mobileUrl: ip ? `http://${ip}:${port()}/celular?t=${mobileToken()}` : null,
      remoteUrl: ts ? `http://${ts}:${port()}/celular?t=${mobileToken()}` : null,
      backups: listBackups().slice(0, 10), backupDir: backupRoot(),
    };
  }

  // ---------- Backups ----------
  const backupRoot = () => path.join(ctx.app.getPath('documents'), 'TK MultiStream', 'backups');
  const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };
  function listBackups() {
    try {
      return fs.readdirSync(backupRoot()).filter((d) => /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(d)).sort().reverse();
    } catch { return []; }
  }
  function backupNow() {
    const dir = path.join(backupRoot(), stamp());
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const [name, folder] of ctx.dataDirs()) {
      const src = path.join(folder, 'config.json');
      if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, `${name}.json`)); n++; }
    }
    // Mantém os 10 mais novos.
    for (const old of listBackups().slice(10)) { try { fs.rmSync(path.join(backupRoot(), old), { recursive: true, force: true }); } catch {} }
    cfg().lastBackupAt = Date.now();
    ctx.saveConfig();
    return { dir, files: n };
  }
  function autoBackup() {
    if (Date.now() - (cfg().lastBackupAt || 0) >= 24 * 60 * 60 * 1000) { try { backupNow(); } catch {} }
  }
  // Restaura um backup: copia os arquivos de volta e reabre o app (as contas leem a config ao abrir).
  function restore(name) {
    if (!/^\d{4}-\d{2}-\d{2}_\d{4}$/.test(name)) return { error: 'Backup inválido.' };
    const dir = path.join(backupRoot(), name);
    const dirs = new Map(ctx.dataDirs());
    let n = 0;
    for (const file of fs.readdirSync(dir)) {
      const acc = file.replace(/\.json$/, '');
      const folder = dirs.get(acc);
      if (!folder || !/\.json$/.test(file)) continue;
      fs.mkdirSync(folder, { recursive: true });
      fs.copyFileSync(path.join(dir, file), path.join(folder, 'config.json'));
      n++;
    }
    if (!n) return { error: 'Nada para restaurar neste backup.' };
    setTimeout(() => ctx.relaunch(), 300);
    return { ok: true, files: n };
  }

  return { sync, info, backupNow, autoBackup, restore, mobileToken };
};

// ---------- Páginas ----------
const BASE_CSS = `
  :root { --bg: #0f1118; --card: #151925; --line: #29304a; --txt: #eef0f4; --muted: #8b93ab; --accent: #9feaf9; --tw: #bf94ff; --kk: #53fc18; }
  * { box-sizing: border-box; } body { margin: 0; font: 600 14px/1.35 "Segoe UI", system-ui, sans-serif; color: var(--txt); }
  .tw { color: var(--tw); } .kk { color: var(--kk); } .muted { color: var(--muted); font-weight: 500; }
`;

const OVERLAY_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>TK MultiStream — overlay</title>
<style>${BASE_CSS}
  body { background: transparent; padding: 8px; }
  .card { display: inline-flex; flex-direction: column; gap: 6px; padding: 10px 14px; border-radius: 14px; background: rgba(15, 17, 24, .82);
    border: 1px solid rgba(159, 234, 249, .35); box-shadow: 0 0 18px rgba(159, 234, 249, .18); min-width: 260px; }
  .top { display: flex; align-items: baseline; gap: 8px; font-size: 16px; }
  .top b { font-size: 18px; } .row { display: flex; gap: 10px; font-size: 13px; flex-wrap: wrap; }
  .b { white-space: nowrap; } .off { opacity: .45; }
</style></head><body><div class="card" id="c">Carregando…</div>
<script>
  const fmt = (ms) => { const m = Math.max(0, Math.ceil(ms / 60000)); const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60; return d ? d + 'd' + h + 'h' : h ? h + 'h' + String(mm).padStart(2, '0') : mm + 'm'; };
  const NAMES = ['⚡ XP', '🎯 Capture', '✨ Lure'];
  async function tick() {
    try {
      const qs = new URLSearchParams(location.search).get('conta');
      const d = await (await fetch('/api/overlay' + (qs ? '?conta=' + encodeURIComponent(qs) : ''), { cache: 'no-store' })).json();
      const now = Date.now();
      const c = document.getElementById('c');
      c.textContent = '';
      const top = document.createElement('div'); top.className = 'top';
      const b = document.createElement('b'); b.textContent = d.nick || d.label || 'PokeIdle'; top.append(b);
      const s = document.createElement('span'); s.className = 'muted'; s.textContent = [d.level ? 'Nv ' + d.level : '', d.xpH ? Math.round(d.xpH / 1000) + ' mil XP/h' : ''].filter(Boolean).join(' · '); top.append(s);
      c.append(top);
      for (const [plat, cls, label] of [['twitch', 'tw', 'Twitch'], ['kick', 'kk', 'Kick']]) {
        const row = document.createElement('div'); row.className = 'row';
        const t = document.createElement('span'); t.className = cls; t.textContent = label; row.append(t);
        (d.bonus && d.bonus[plat] || [null, null, null]).forEach((end, i) => {
          const x = document.createElement('span'); const on = end && end > now;
          x.className = 'b' + (on ? '' : ' off'); x.textContent = NAMES[i] + ' ' + (on ? fmt(end - now) : '—'); row.append(x);
        });
        c.append(row);
      }
    } catch {}
  }
  tick(); setInterval(tick, 5000);
</script></body></html>`;

const MOBILE_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TK MultiStream</title>
<style>${BASE_CSS}
  body { background: var(--bg); padding: 14px; max-width: 640px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; } .sub { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
  .acc { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; margin-bottom: 10px; }
  .acc.bad { border-color: #e5484d; } .acc.warn { border-color: #f5a524; } .acc h2 { font-size: 15px; margin: 0; display: flex; justify-content: space-between; gap: 8px; }
  .chip { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--line); color: var(--muted); }
  .chip.ok { background: var(--accent); color: #0b1a1f; } .chip.bad { background: #e5484d; color: #fff; } .chip.warn { background: #f5a524; color: #000; }
  .line { font-size: 13px; color: var(--muted); margin: 3px 0 6px; font-weight: 500; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; } td { padding: 3px 2px; } td:last-child, td:nth-child(3) { text-align: right; }
  .stats { color: var(--txt); } .shiny { color: #ffd34d; font-weight: 700; }
  .acts { display: flex; gap: 8px; margin-top: 8px; }
  .acts button { flex: 1; font: inherit; font-size: 13px; padding: 9px 6px; border-radius: 10px; border: 1px solid var(--line); background: #1c2233; color: var(--txt); }
  .bn { font: inherit; font-size: 12.5px; color: inherit; background: none; border: 1px solid var(--line); border-radius: 8px; padding: 5px 4px; width: 100%; text-align: inherit; }
  .bn:disabled { opacity: .5; } .hint { color: var(--muted); font-size: 12px; font-weight: 500; margin: -6px 0 12px; }
  .acts button.on { border-color: #ffd34d; color: #ffd34d; }
  .prev { color: var(--txt); cursor: pointer; margin-bottom: 12px; } .toque { color: var(--txt); cursor: pointer; } .dicas { margin: -2px 0 8px; padding-left: 18px; font-size: 12px; color: var(--muted); } .dicas li { margin: 3px 0; }
  .acts button:disabled { opacity: .5; } .msg { font-size: 12px; margin-top: 6px; color: var(--accent); font-weight: 500; } .msg.err { color: #ff8f93; }
</style></head><body><h1>🎮 TK MultiStream</h1><div class="sub" id="sub">Carregando…</div><div class="hint">Toque num bônus para comprar 1 h dele agora.</div><div class="hint shiny" id="shiny"></div><div id="list"></div>
<script>
  const fmt = (ms) => { const m = Math.max(0, Math.ceil(ms / 60000)); const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60; return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + String(mm).padStart(2, '0') + 'm' : mm + ' min'; };
  const NAMES = ['⚡ XP', '🎯 Capture', '✨ Lure'];
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const t = new URLSearchParams(location.search).get('t');
  // Destravar uma conta que parou de caçar: o F5 do jogo, ou zerar os ajustes do /hunt e recarregar.
  const ACTIONS = [
    ['reload', '🔄 Recarregar', 'Recarregar o jogo da conta %s?'],
    ['hunt', '🧹 Resetar /hunt', 'Zerar o /hunt da conta %s (ordem, filtros, o ponto do Apontar e as hunts medidas) e recarregar o jogo?'],
  ];
  // Tocar num bônus: compra 1 h dele, na plataforma da linha.
  const TIPOS = ['xp', 'captura', 'shiny'];
  const FULL = ['+15% XP', '+15% Capture Boost', '+15% Secret Lure'];
  const COST = [300, 500, 1000];
  const n = (v) => Number(v || 0).toLocaleString('pt-BR');
  const ITENS = { fragChave: 'frag. de chave', fragShiny: 'frag. shiny', fragBicicleta: 'frag. de bicicleta', fragMega: 'frag. mega', fragMegaShiny: 'frag. mega shiny', fragOvoShiny: 'frag. de ovo shiny', tmPeca: 'peça de TM', tmPecaAoe: 'peça de TM em área', ticketMistico: 'ticket místico', ticketSafari: 'ticket Safari' };
  const msgs = {}, busy = {}, dicas = {};
  let last = null;
  async function agir(a, payload, pergunta, aguarde) {
    if (!confirm(pergunta)) return;
    busy[a.id] = true; msgs[a.id] = { text: aguarde || 'Enviando…' }; render();
    try {
      const r = await (await fetch('/api/acao?t=' + encodeURIComponent(t), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ conta: a.id }, payload)) })).json();
      msgs[a.id] = r.error ? { text: r.error, err: true } : { text: r.message || 'Feito.' };
    } catch { msgs[a.id] = { text: 'Sem conexão com o PC.', err: true }; }
    busy[a.id] = false; render();
    setTimeout(tick, 15000);
  }
  function render() {
    const d = last; if (!d) return;
    const now = Date.now();
    const u = d.ultimoShiny;
    document.getElementById('shiny').textContent = u ? '✨ Último shiny do jogo: ' + u.nome + ' de ' + u.nick + ' · há ' + fmt(now - u.at) : '';
    const list = document.getElementById('list'); list.textContent = '';
    for (const a of d.contas) {
      const box = el('div', 'acc' + (a.problem === 'semAbate' ? ' warn' : a.problem ? ' bad' : ''));
      const h = el('h2'); h.append(el('span', null, a.label + (a.nick ? ' · ' + a.nick : '')));
      const st = !a.open ? ['fechada', ''] : a.problem === 'deslogou' ? ['deslogou', 'bad'] : a.problem === 'parada' ? ['sem XP', 'bad'] : a.problem === 'semAbate' ? ['caçando · ' + (a.semXpMin || 10) + ' min sem abate', 'warn'] : a.logged ? ['caçando', 'ok'] : ['sem login', ''];
      h.append(el('span', 'chip ' + st[1], st[0])); box.append(h);
      box.append(el('div', 'line', [a.level ? 'Nv ' + a.level : '', a.xpH ? Math.round(a.xpH / 1000) + ' mil XP/h' : '', a.gold ? '💰 ' + a.gold : ''].filter(Boolean).join(' · ') || ' '));
      if (a.hunt) box.append(el('div', 'line', '📍 ' + a.hunt));
      // Estoque: as bolas da automação e as poções que a conta tem.
      if (a.inv) {
        const POC = { 200: 'Small Potion', 201: 'Great Potion', 202: 'Ultra Potion', 203: 'Hyper Potion', 204: 'Ultimate Potion' };
        const bolas = (a.inv.ballIds || []).map((id) => { const b = (a.inv.bolas || []).find((x) => x.id === id); return n(a.inv.balls[id]) + ' ' + (b ? b.nome : 'bola ' + id); });
        const poc = Object.entries(a.inv.pocoes || {}).filter((e) => e[1] > 0).map(([k, v]) => n(v) + ' ' + (POC[k] || k));
        const it = bolas.concat(poc);
        if (it.length) box.append(el('div', 'line', '🎒 ' + it.join(' · ')));
      }
      if (a.compra && now - a.compra.at < 2 * 3600e3) box.append(el('div', 'line', '🛒 ' + new Date(a.compra.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + ': ' + a.compra.texto));
      if (a.seguir && a.seguir.st) { const s = a.seguir.st; box.append(el('div', 'line shiny', '✨ Na hunt do shiny de ' + s.nome + ' (pego por ' + s.nick + ') · volta em ' + fmt(s.ate - now))); }
      if (a.ativo && (a.ativo.nome || a.ativo.level)) {
        const pk = el('div', 'line stats');
        pk.append(el('span', null, '🐾 '), el('span', a.ativo.shiny ? 'shiny' : null, (a.ativo.shiny ? '✨ ' : '') + (a.ativo.nome || 'Pokémon')),
          el('span', null, (a.ativo.level ? ' · Nv ' + n(a.ativo.level) : '') + (a.ativo.xpPct != null && a.ativo.level ? ' · ' + a.ativo.xpPct + '% para o Nv ' + n(a.ativo.level + 1) : '')));
        box.append(pk);
      }
      // Placar da sessão de caça do jogo: capturas, shinies, abates e o que caiu.
      if (a.capturas != null) {
        const st = el('div', 'line stats');
        const sh = el('span', a.shinies ? 'shiny' : null, '✨ ' + n(a.shinies) + ' shiny' + (a.shinies === 1 ? '' : 's') + (a.shiniesVistos ? ' (' + n(a.shiniesVistos) + ' visto' + (a.shiniesVistos === 1 ? '' : 's') + ')' : ''));
        st.append(el('span', null, '🎯 ' + n(a.capturas) + ' capturas · '), sh, el('span', null, ' · ⚔ ' + n(a.abates) + ' abates' + (a.sessMs ? ' · ⏱ ' + fmt(a.sessMs) + ' de sessão' : '')));
        box.append(st);
        const it = Object.entries(a.itens || {}).map(([k, v]) => n(v) + ' ' + (ITENS[k] || k));
        if (a.bossTokens) it.unshift(n(a.bossTokens) + ' boss token' + (a.bossTokens === 1 ? '' : 's'));
        if (it.length) box.append(el('div', 'line', '🎁 ' + it.join(' · ')));
      }
      // Melhor hunt (conta da extensão /hunt). Tocar mostra as melhores para XP e para ouro.
      const mh = a.melhorHunt;
      if (mh) {
        const kh = 'h:' + a.id;
        const lh = el('div', 'line toque', '🗺️ ' + mh.resumo + (dicas[kh] ? ' ▴' : ' ⓘ'));
        lh.onclick = () => { dicas[kh] = !dicas[kh]; render(); };
        box.append(lh);
        if (dicas[kh]) { const ul = el('ul', 'dicas'); for (const dc of mh.detalhes) ul.append(el('li', null, dc)); box.append(ul); }
      }
      // Previsão de shiny da sessão desta conta. Tocar mostra as dicas.
      const sp = a.shinyPrev;
      if (sp) {
        const partes = [sp.ver ? 'ver ~1 a cada ' + sp.ver : null, sp.capturar ? 'capturar ~1 a cada ' + sp.capturar : null].filter(Boolean);
        const txt = sp.outland ? 'Na Outland não existe shiny' : sp.medindo ? 'Previsão de shiny: medindo a sessão…' : partes.length ? 'Shiny: ' + partes.join(' · ') : '';
        if (txt) {
          const ln = el('div', 'line prev', '✨ ' + txt + (sp.mult > 1 ? ' (Lure ×' + String(sp.mult).replace('.', ',') + ')' : '') + (dicas[a.id] ? ' ▴' : ' ⓘ'));
          ln.onclick = () => { dicas[a.id] = !dicas[a.id]; render(); };
          box.append(ln);
          if (dicas[a.id]) { const ul = el('ul', 'dicas'); for (const dc of sp.dicas) ul.append(el('li', null, dc)); box.append(ul); }
        }
      }
      const tb = el('table');
      for (const [plat, cls, label] of [['twitch', 'tw', 'Twitch'], ['kick', 'kk', 'Kick']]) {
        const tr = el('tr'); tr.append(el('td', cls, label));
        (a.bonus && a.bonus[plat] || [null, null, null]).forEach((end, i) => {
          const on = end && end > now;
          const td = el('td', on ? '' : 'muted');
          const b = el('button', 'bn', NAMES[i] + ' ' + (on ? fmt(end - now) : '—'));
          b.disabled = !!busy[a.id];
          b.onclick = () => agir(a, { acao: 'buy', tipo: TIPOS[i], plataforma: plat },
            'Comprar 1 h de ' + FULL[i] + ' na ' + label + ' para a conta ' + a.label + '? Gasta ' + COST[i].toLocaleString('pt-BR') + ' pontos de um canal da ' + label + '.',
            'Comprando ' + FULL[i] + ' na ' + label + '… (na Twitch leva até 1 min)');
          td.append(b); tr.append(td);
        });
        tb.append(tr);
      }
      box.append(tb);
      const bar = el('div', 'acts');
      for (const [acao, txt, pergunta] of ACTIONS) {
        const b = el('button', null, txt);
        b.disabled = !!busy[a.id];
        b.onclick = () => agir(a, { acao }, pergunta.replace('%s', a.label));
        bar.append(b);
      }
      box.append(bar);
      // Seguir shiny: vai para a hunt do Pokémon que alguém acabou de pegar shiny, por 30 min.
      const sg = a.seguir || {};
      const bar2 = el('div', 'acts');
      const bs = el('button', sg.on ? 'on' : null, sg.on ? '✨ Seguindo shiny (toque para parar)' : '✨ Seguir shiny');
      bs.disabled = !!busy[a.id];
      bs.onclick = () => agir(a, { acao: 'seguir', ligar: !sg.on }, sg.on
        ? 'Parar de seguir shiny na conta ' + a.label + '? Se ela estiver na hunt de um shiny, volta para a hunt de antes.'
        : 'Seguir shiny na conta ' + a.label + '? Quando alguém pegar um shiny no jogo, ela vai para a hunt desse Pokémon por 30 min (ou até sair outro shiny) e depois volta para onde estava.');
      bar2.append(bs);
      box.append(bar2);
      // Secret Lure de madrugada (só a Principal): junta a sobra do XP da Twitch e gasta em 2 madrugadas.
      const lu = a.lure;
      if (lu) {
        if (lu.on) box.append(el('div', 'line', '🌙 Lure de madrugada: ' + lu.texto));
        const bar3 = el('div', 'acts');
        const bl = el('button', lu.on ? 'on' : null, lu.on ? '🌙 Lure de madrugada ligado (toque para desligar)' : '🌙 Lure de madrugada');
        bl.disabled = !!busy[a.id];
        bl.onclick = () => agir(a, { acao: 'lure', ligar: !lu.on }, lu.on
          ? 'Desligar o Lure de madrugada na conta ' + a.label + '? O Capture da Twitch volta a usar a sobra do XP.'
          : 'Ligar o Lure de madrugada na conta ' + a.label + '? O TK junta a sobra do XP da Twitch e, quando der para 2 noites (8.000 pontos), compra o Secret Lure das 0h às 8h, hora sim hora não, por 2 madrugadas seguidas. O XP continua sempre ligado; o Capture da Twitch só usa o que passar do guardado.');
        bar3.append(bl);
        box.append(bar3);
      }
      if (msgs[a.id]) box.append(el('div', 'msg' + (msgs[a.id].err ? ' err' : ''), msgs[a.id].text));
      list.append(box);
    }
  }
  async function tick() {
    try {
      last = await (await fetch('/api/painel?t=' + encodeURIComponent(t), { cache: 'no-store' })).json();
      document.getElementById('sub').textContent = 'Farm ' + (last.farming ? 'ligado' : 'pausado') + ' · ' + last.assistindo + ' lives assistindo · atualizado ' + new Date().toLocaleTimeString('pt-BR');
      render();
    } catch { document.getElementById('sub').textContent = 'Sem conexão com o PC.'; }
  }
  tick(); setInterval(tick, 10000);
</script></body></html>`;
