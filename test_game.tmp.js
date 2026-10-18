// Teste de integração multiplayer: host + cliente PC + "cliente celular" (jsdom + ws real)
const { JSDOM } = require('jsdom');
const fs = require('fs');

function fakeCtx() {
  const noop = () => {};
  return new Proxy({}, { get(t, k) {
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop: noop });
    if (k === 'measureText') return () => ({ width: 10 });
    return noop;
  }, set: () => true });
}

let VT = 0; // tempo virtual (ms) compartilhado
function makeWindow(isTouch) {
  const html = fs.readFileSync('/workspace/index.html', 'utf-8');
  const dom = new JSDOM(html, { url: 'http://localhost:8000/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  w.matchMedia = q => ({ matches: isTouch ? q.includes('coarse') : false, addListener(){}, removeListener(){} });
  function FakeAudio() {
    this.createOscillator = () => ({ connect(){}, start(){}, stop(){}, frequency:{} });
    this.createGain = () => ({ connect(){}, gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} } });
  }
  w.AudioContext = FakeAudio; w.webkitAudioContext = FakeAudio;
  w.WebSocket = require('ws');
  // relógios virtuais: o teste controla o tempo explicitamente
  w.performance = { now: () => VT };
  let rafCb = null;
  w.requestAnimationFrame = cb => { rafCb = cb; return 1; };
  w.__raf = () => { const cb = rafCb; rafCb = null; if (cb) cb(VT); };
  const code = fs.readFileSync('/tmp/game.js', 'utf-8');
  try { w.eval(code); } catch(e) { console.log('ERRO ao avaliar script:', e.message); process.exit(1); }
  const D = () => w.__dbg;
  return { w,
    ev: f => f(D()),
    tick(ms) { // avança tempo virtual e roda o loop da janela quantas vezes precisar
      const steps = Math.max(1, Math.round(ms / 16));
      for (let i = 0; i < steps; i++) { VT += 16; this.w.__raf(); }
    },
  };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const findP = (D, name) => Object.values(D.game.players).find(p => p.name === name);

(async () => {
  const host = makeWindow(false), c1 = makeWindow(false), c2 = makeWindow(true);
  const all = [host, c1, c2];
  const advance = ms => { for (const win of all) win.tick(ms); };

  host.w.document.getElementById('nameInput').value = 'Ana';
  c1.w.document.getElementById('nameInput').value = 'Beto';
  c2.w.document.getElementById('nameInput').value = 'Carla';

  host.ev(({ $ }) => $('btnHost').click()); advance(600); await sleep(50);
  c1.ev(({ $ }) => { $('btnJoin').click(); $('serverInput').value='ws://localhost:8765'; $('btnConnect').click(); }); advance(600); await sleep(50);
  c2.ev(({ $ }) => { $('btnJoin').click(); $('serverInput').value='ws://localhost:8765'; $('btnConnect').click(); }); advance(800); await sleep(50);

  const lobby = JSON.stringify(host.ev(({ net }) => net.lobby));
  console.log('LOBBY no host:', lobby);
  if (!(lobby.includes('Ana') && lobby.includes('Beto') && lobby.includes('Carla'))) { console.log('FALHOU: lobby incompleto'); process.exit(1); }

  host.ev(({ $ }) => $('btnStartGame').click()); advance(900); await sleep(50);

  const nH = host.ev(({ game }) => game && Object.keys(game.players).length);
  const n1 = c1.ev(({ game, MODE }) => MODE==='client' && game ? Object.keys(game.players).length : -1);
  const n2 = c2.ev(({ game, MODE }) => MODE==='client' && game ? Object.keys(game.players).length : -1);
  console.log('jogadores — host:', nH, '| cliente PC:', n1, '| cliente celular:', n2);
  if (nH !== 3 || n1 !== 3 || n2 !== 3) { console.log('FALHOU: início com 3 jogadores'); process.exit(1); }

  // movimento do host (teclado) visto pelos clientes
  host.ev(({ keys }) => { keys['a'] = true; });
  c2.ev(({ touchCtl }) => { touchCtl.mx = -1; touchCtl.my = 0; });
  const x0 = host.ev(({ game }) => findP({game}, 'Ana').x);
  advance(1200); await sleep(50);
  const xh = host.ev(({ game }) => findP({game}, 'Ana').x);
  const xc = c1.ev(({ game }) => findP({game}, 'Ana').x);
  console.log('Ana andou? host', x0.toFixed(1), '->', xh.toFixed(1), '| cliente PC vê', xc.toFixed(1));
  if (!(xh < x0 - 30)) { console.log('FALHOU: movimento do host'); process.exit(1); }
  if (Math.abs(xc - xh) > 40) { console.log('FALHOU: snapshot não sincronizou'); process.exit(1); }

  // Carla (celular) corta árvore
  host.ev(({ game }) => { const p = findP({game}, 'Carla'); const t = game.trees.find(t=>t.alive); p.x=t.x+20; p.y=t.y; });
  advance(300); await sleep(50);
  c2.ev(({ touchCtl, handleInteract }) => { touchCtl.chop = true; handleInteract(); });
  advance(1600); await sleep(50);
  const wood = host.ev(({ game }) => findP({game}, 'Carla').inv.wood);
  console.log('Carla (celular) coletou madeira no host:', wood);
  if (wood < 1) { console.log('FALHOU: coleta do cliente'); process.exit(1); }

  // Carla alimenta a fogueira
  host.ev(({ game }) => { const p = findP({game}, 'Carla'); p.x = game.fire.x + 30; p.y = game.fire.y; game.fire.intensity = 50; });
  advance(200); await sleep(50);
  c2.ev(({ sendInput }) => sendInput('interact'));
  advance(500); await sleep(50);
  const fi = host.ev(({ game }) => game.fire.intensity);
  console.log('Fogueira após alimentar (era 50):', fi);
  if (fi <= 55) { console.log('FALHOU: alimentar fogueira pelo cliente'); process.exit(1); }

  // noite + lobos sincronizados
  host.ev(({ game }) => { game.phase='night'; game.phaseTimer=59; game.night=1; });
  advance(2500); await sleep(50);
  const wl = host.ev(({ game }) => game.wolves.length);
  const wc = c1.ev(({ game }) => game.wolves.length);
  console.log('Lobos — host:', wl, '| cliente PC vê:', wc);
  if (wl < 1 || wc < 1) { console.log('FALHOU: lobos não surgiram/sincronizaram'); process.exit(1); }

  // Beto (cliente PC) ataca lobo via comando enviado ao host
  host.ev(({ game }) => { const p = findP({game}, 'Beto'); const w = game.wolves[0]; p.x=w.x+30; p.y=w.y; p.dir=Math.PI; });
  advance(200); await sleep(50);
  c1.ev(({ sendInput }) => sendInput('attack'));
  advance(500); await sleep(50);
  const wolfHp = host.ev(({ game }) => game.wolves.length ? Math.min(...game.wolves.map(w=>w.hp)) : -999);
  console.log('menor HP de lobo no host após ataque do cliente (base noite1 = 36):', wolfHp);
  if (wolfHp >= 36) { console.log('FALHOU: ataque do cliente não surtiu efeito'); process.exit(1); }

  // morte/respawn: matar Ana no host deve ressuscitá-la na fogueira
  host.ev(({ game }) => { const p = findP({game}, 'Ana'); p.hp = 1; });
  advance(1500); await sleep(50);
  const downed = host.ev(({ game }) => findP({game}, 'Ana').downed);
  console.log('Ana caiu?', downed);
  if (!downed) { console.log('FALHOU: queda não registrada'); process.exit(1); }
  host.ev(({ game }) => { findP({game}, 'Ana').deathTimer = 0.1; });
  advance(600); await sleep(50);
  const revived = host.ev(({ game }) => !findP({game}, 'Ana').downed && findP({game}, 'Ana').hp > 0);
  console.log('Ana reviveu na fogueira?', revived);
  if (!revived) { console.log('FALHOU: respawn'); process.exit(1); }

  console.log('\n✅ TODOS OS TESTES DE MULTIPLAYER PASSARAM');
  process.exit(0);
})().catch(e => { console.log('ERRO:', e.stack); process.exit(1); });
