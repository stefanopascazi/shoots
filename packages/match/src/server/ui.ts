/**
 * The duel page, served inline (no external assets, no build copy step).
 * Two photos, keep one with ←/→ or a click; space to skip. Progress in the bar.
 */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>shoots · match</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 15px/1.4 system-ui, sans-serif;
    background: #111; color: #eee; height: 100vh; display: flex; flex-direction: column;
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; border-bottom: 1px solid #333; background: #181818;
  }
  header .hint { color: #999; font-size: 13px; }
  #stage { flex: 1; display: flex; gap: 12px; padding: 12px; min-height: 0; }
  .card {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: #000; border: 2px solid #333; border-radius: 10px; cursor: pointer;
    overflow: hidden; transition: border-color .12s, transform .06s;
  }
  .card:hover { border-color: #5b8def; }
  .card:active { transform: scale(.995); }
  .card img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .card .missing { color: #777; padding: 24px; text-align: center; }
  .side { position: absolute; top: 8px; padding: 2px 8px; border-radius: 6px; background: #5b8def; color: #fff; font-size: 12px; }
  footer { padding: 8px 16px; border-top: 1px solid #333; color: #999; font-size: 13px; text-align: center; }
  button {
    font: inherit; background: #222; color: #eee; border: 1px solid #444;
    border-radius: 8px; padding: 6px 12px; cursor: pointer;
  }
  button:hover { background: #2a2a2a; }
  #done { display: none; margin: auto; text-align: center; color: #aaa; }
</style>
</head>
<body>
  <header>
    <strong>shoots · match</strong>
    <span class="hint">← / → or click to keep · space to skip</span>
    <span id="counter">0 duels</span>
  </header>
  <div id="stage">
    <div class="card" id="cardA" data-side="0"><span class="missing">…</span></div>
    <div class="card" id="cardB" data-side="1"><span class="missing">…</span></div>
  </div>
  <div id="done">Not enough photos to duel. Import a dataset first.</div>
  <footer><button id="skip">Skip (space)</button></footer>
<script>
const cardA = document.getElementById('cardA');
const cardB = document.getElementById('cardB');
const counterEl = document.getElementById('counter');
const stage = document.getElementById('stage');
const doneEl = document.getElementById('done');
const session = 'sess-' + Date.now();
let pair = null;
let duels = 0;

function render(id, card) {
  card.dataset.id = id;
  card.innerHTML = '';
  const img = new Image();
  img.src = '/api/image/' + id + '?t=' + Date.now();
  img.onerror = () => { card.innerHTML = '<span class="missing">image not viewable<br>(RAW?)</span>'; };
  card.appendChild(img);
}

async function next() {
  const r = await fetch('/api/next-pair');
  const data = await r.json();
  if (!data.pair) { stage.style.display = 'none'; doneEl.style.display = 'block'; return; }
  pair = data.pair;
  render(pair[0], cardA);
  render(pair[1], cardB);
}

async function vote(winnerSide) {
  if (!pair) return;
  const winnerId = pair[winnerSide];
  const loserId = pair[winnerSide === 0 ? 1 : 0];
  pair = null;
  await fetch('/api/vote', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ winnerId, loserId, session }),
  });
  duels++;
  counterEl.textContent = duels + ' duels';
  next();
}

async function skip() { pair = null; next(); }

cardA.onclick = () => vote(0);
cardB.onclick = () => vote(1);
document.getElementById('skip').onclick = skip;
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') vote(0);
  else if (e.key === 'ArrowRight') vote(1);
  else if (e.key === ' ') { e.preventDefault(); skip(); }
});

next();
</script>
</body>
</html>`;
