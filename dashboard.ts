import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

const TRADES_PATH = join(import.meta.dir, "logs/trades.csv");
const PORT = 3001;
const STARTING_BALANCE = 50;

type Trade = {
  timestamp: string;
  window: string;
  direction: string;
  entry_price: number;
  exit_price: number;
  shares: number;
  pnl: number;
  exit_reason: string;
  score: number;
  confidence: number;
  duration_s: number;
};

function parseTrades(): Trade[] {
  if (!existsSync(TRADES_PATH)) return [];
  const raw = readFileSync(TRADES_PATH, "utf-8");
  const lines = raw.trim().split("\n");
  if (lines.length < 2) return [];
  return lines
    .slice(1)
    .filter((l) => l.trim())
    .map((line) => {
      const [timestamp, window, direction, entry_price, exit_price, shares, pnl, exit_reason, score, confidence, duration_s] = line.split(",");
      return {
        timestamp,
        window,
        direction,
        entry_price: parseFloat(entry_price),
        exit_price: parseFloat(exit_price),
        shares: parseFloat(shares),
        pnl: parseFloat(pnl),
        exit_reason,
        score: parseFloat(score),
        confidence: parseFloat(confidence),
        duration_s: parseFloat(duration_s),
      };
    })
    .filter((t) => !isNaN(t.pnl) && t.shares > 0);
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Polymarket Bot Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d0d;color:#e0e0e0;padding:24px;min-height:100vh}
h1{font-size:18px;font-weight:500;color:#fff;margin-bottom:24px;letter-spacing:-0.3px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
.stat{background:#1a1a1a;border:0.5px solid #2a2a2a;border-radius:10px;padding:16px}
.stat-label{font-size:12px;color:#666;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px}
.stat-value{font-size:22px;font-weight:500}
.pos{color:#22c55e}.neg{color:#ef4444}.neu{color:#e0e0e0}
.chart-wrap{background:#1a1a1a;border:0.5px solid #2a2a2a;border-radius:10px;padding:20px;margin-bottom:24px}
.chart-title{font-size:13px;color:#666;margin-bottom:16px}
table{width:100%;border-collapse:collapse;background:#1a1a1a;border:0.5px solid #2a2a2a;border-radius:10px;overflow:hidden}
th{font-size:11px;color:#555;font-weight:500;text-align:left;padding:10px 14px;border-bottom:0.5px solid #2a2a2a;text-transform:uppercase;letter-spacing:0.5px}
td{font-size:13px;padding:10px 14px;border-bottom:0.5px solid #1f1f1f;font-family:'SF Mono',Consolas,monospace}
tr:last-child td{border-bottom:none}
tr:hover td{background:#1f1f1f}
.pill{font-size:11px;padding:2px 8px;border-radius:20px;font-weight:500;font-family:-apple-system,sans-serif}
.pill-win{background:#14532d;color:#4ade80}
.pill-loss{background:#450a0a;color:#f87171}
.pill-flat{background:#1c1917;color:#a8a29e}
.refresh{font-size:12px;color:#444;margin-bottom:16px}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
.btn{font-size:12px;font-weight:500;padding:6px 14px;border-radius:8px;border:0.5px solid #333;background:#1a1a1a;color:#e0e0e0;cursor:pointer}
.btn:hover{background:#222;border-color:#555}
.btn-danger{border-color:#7f1d1d;color:#f87171}
.btn-danger:hover{background:#450a0a}
</style>
</head>
<body>
<div class="header">
  <h1>Polymarket Bot</h1>
  <button class="btn btn-danger" onclick="clearTrades()">Clear Trades</button>
</div>
<p class="refresh" id="ts">Loading...</p>
<div class="stats" id="stats"></div>
<div class="chart-wrap">
  <p class="chart-title">Cumulative PnL</p>
  <canvas id="chart" height="80"></canvas>
</div>
<table>
  <thead><tr>
    <th>Time</th><th>Entry</th><th>Exit</th><th>Shares</th><th>PnL</th><th>Reason</th><th>Score</th><th>Conf</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table>
<script>
async function refresh() {
  const trades = await fetch('/api/trades').then(r => r.json());
  const now = new Date().toLocaleTimeString();
  document.getElementById('ts').textContent = 'Last updated: ' + now + ' — ' + trades.length + ' trades';

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = trades.length ? (wins.length / trades.length * 100) : 0;
  const avgWin = wins.length ? wins.reduce((s,t)=>s+t.pnl,0)/wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s,t)=>s+t.pnl,0)/losses.length : 0;
  const best = trades.length ? Math.max(...trades.map(t=>t.pnl)) : 0;
  const worst = trades.length ? Math.min(...trades.map(t=>t.pnl)) : 0;
  const balance = ${STARTING_BALANCE} + totalPnl;

  const pnlClass = totalPnl >= 0 ? 'pos' : 'neg';
  const statsData = [
    {label:'Balance', value: '$' + balance.toFixed(2), cls: pnlClass},
    {label:'Total PnL', value: (totalPnl>=0?'+':'') + '$' + totalPnl.toFixed(2), cls: pnlClass},
    {label:'Win Rate', value: winRate.toFixed(0) + '%', cls: winRate >= 50 ? 'pos' : winRate >= 35 ? 'neu' : 'neg'},
    {label:'Trades', value: trades.length, cls: 'neu'},
    {label:'Avg Win', value: '+$' + avgWin.toFixed(2), cls: 'pos'},
    {label:'Avg Loss', value: '$' + avgLoss.toFixed(2), cls: 'neg'},
    {label:'Best', value: '+$' + best.toFixed(2), cls: 'pos'},
    {label:'Worst', value: '$' + worst.toFixed(2), cls: 'neg'},
  ];
  document.getElementById('stats').innerHTML = statsData.map(s =>
    '<div class="stat"><div class="stat-label">'+s.label+'</div><div class="stat-value '+s.cls+'">'+s.value+'</div></div>'
  ).join('');

  const cumPnl = [];
  let running = 0;
  [...trades].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)).forEach(t => {
    running += t.pnl;
    cumPnl.push({x: new Date(t.timestamp).toLocaleTimeString(), y: parseFloat(running.toFixed(4))});
  });

  if (window._chart) window._chart.destroy();
  const ctx = document.getElementById('chart').getContext('2d');
  window._chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: cumPnl.map(p=>p.x),
      datasets: [{
        data: cumPnl.map(p=>p.y),
        borderColor: totalPnl >= 0 ? '#22c55e' : '#ef4444',
        borderWidth: 2,
        pointRadius: 3,
        pointBackgroundColor: totalPnl >= 0 ? '#22c55e' : '#ef4444',
        fill: false,
        tension: 0.3,
      }]
    },
    options: {
      responsive: true,
      plugins: {legend:{display:false}},
      scales: {
        x: {ticks:{color:'#555',font:{size:11}}, grid:{color:'#1f1f1f'}},
        y: {ticks:{color:'#555',font:{size:11},callback:v=>'$'+v.toFixed(2)}, grid:{color:'#1f1f1f'}}
      }
    }
  });

  const rows = [...trades].reverse().map(t => {
    const pillCls = t.pnl > 0 ? 'pill-win' : t.pnl < 0 ? 'pill-loss' : 'pill-flat';
    const sign = t.pnl > 0 ? '+' : '';
    const time = new Date(t.timestamp).toLocaleTimeString();
    return '<tr>' +
      '<td>'+time+'</td>' +
      '<td>'+t.entry_price.toFixed(2)+'</td>' +
      '<td>'+t.exit_price.toFixed(2)+'</td>' +
      '<td>'+t.shares.toFixed(2)+'</td>' +
      '<td class="'+(t.pnl>=0?'pos':'neg')+'">'+sign+t.pnl.toFixed(4)+'</td>' +
      '<td><span class="pill '+pillCls+'">'+t.exit_reason+'</span></td>' +
      '<td>'+t.score.toFixed(2)+'</td>' +
      '<td>'+Math.round(t.confidence*100)+'%</td>' +
      '</tr>';
  }).join('');
  document.getElementById('rows').innerHTML = rows || '<tr><td colspan="8" style="text-align:center;color:#444;padding:32px">No trades yet</td></tr>';
}

async function clearTrades() {
  if (!confirm('Clear all trades?')) return;
  await fetch('/api/clear', { method: 'POST' });
  refresh();
}

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/trades") {
      return Response.json(parseTrades());
    }
    if (url.pathname === "/api/clear" && req.method === "POST") {
      const header = "timestamp,window,direction,entry_price,exit_price,shares,pnl,exit_reason,score,confidence,duration_s\n";
      writeFileSync(TRADES_PATH, header);
      return new Response("ok");
    }
    return new Response(PAGE, { headers: { "Content-Type": "text/html" } });
  },
});

console.log(`Dashboard → http://localhost:${PORT}`);
