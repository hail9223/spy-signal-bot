// Backtest: IQ Candles + Divergence IQ + RSI + BB Strategy
// Symbol: BTCUSDT  |  Timeframe: 5m  |  Period: last 30 days
// Starting capital: $1000 (cash account, no margin, no shorting)

import https from 'https';

// ── helpers ───────────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Yahoo Finance — returns up to 60 days of 5m intraday OHLC
function fetchCandlesYahoo(ticker, range, interval = '30m') {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
    const options = { headers: { 'User-Agent': 'Mozilla/5.0' } };
    https.get(url, options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const result = j?.chart?.result?.[0];
          if (!result) return reject(new Error(JSON.stringify(j?.chart?.error)));
          const ts    = result.timestamp;
          const q     = result.indicators.quote[0];
          const candles = ts.map((t, i) => ({
            time:  t * 1000,
            open:  q.open[i],
            high:  q.high[i],
            low:   q.low[i],
            close: q.close[i],
          })).filter(c => c.close != null && !isNaN(c.close));
          resolve(candles);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── indicator maths ───────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const result = new Array(closes.length).fill(NaN);
  let ema = closes[0];
  result[0] = ema;
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

function calcRSI(closes, period) {
  const result = new Array(closes.length).fill(NaN);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function calcBB(closes, period, mult) {
  const mid = new Array(closes.length).fill(NaN);
  const upper = new Array(closes.length).fill(NaN);
  const lower = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    mid[i]   = mean;
    upper[i] = mean + mult * std;
    lower[i] = mean - mult * std;
  }
  return { mid, upper, lower };
}

function lowestN(arr, i, n) {
  let lo = Infinity;
  for (let j = Math.max(0, i - n + 1); j <= i; j++)
    if (!isNaN(arr[j])) lo = Math.min(lo, arr[j]);
  return lo;
}

function highestN(arr, i, n) {
  let hi = -Infinity;
  for (let j = Math.max(0, i - n + 1); j <= i; j++)
    if (!isNaN(arr[j])) hi = Math.max(hi, arr[j]);
  return hi;
}

// ── strategy params (matching strategy.pine defaults) ─────────────────────────

const IQ_FAST     = 9;
const IQ_SLOW     = 21;
const IQ_CONFIRM  = 3;
const DIV_RSI_LEN = 14;
const DIV_LB      = 5;
const RSI_LEN     = 14;
const RSI_OB      = 70;
const RSI_OS      = 30;
const RSI_MAX_BUY = 70;
const BB_LEN      = 20;
const BB_MULT     = 2.0;
const TRAIL_ACT   = 5.0;   // %
const TRAIL_PCT   = 3.0;   // %
const MIN_SCORE   = 6;
const START_CAP   = 1000;

// ── position sizing tiers ─────────────────────────────────────────────────────
function allocPct(equity) {
  if (equity <  1000) return 1.00;   // 100% — deploy full cash
  if (equity <  2000) return 0.50;   //  50%
  if (equity < 10000) return 0.25;   //  25%
  return 0.15;                        //  15%
}

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
  const now   = Date.now();
  const start = now - 30 * 24 * 60 * 60 * 1000;

  const ticker   = (process.argv[2] || 'TSLA').toUpperCase();
  const range    = process.argv[3] || '30d';
  const interval = process.argv[4] || '30m';
  const days     = range.replace('d', '');
  process.stdout.write(`Fetching ${days} days of ${ticker} ${interval} candles from Yahoo Finance...\n`);
  const candles = await fetchCandlesYahoo(ticker, range, interval);
  console.log(` ${candles.length} candles loaded.\n`);

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const n      = candles.length;

  // Pre-compute indicators
  const emaFast = calcEMA(closes, IQ_FAST);
  const emaSlow = calcEMA(closes, IQ_SLOW);
  const rsi     = calcRSI(closes, RSI_LEN);
  const divRsi  = calcRSI(closes, DIV_RSI_LEN);
  const { mid: bbMid, upper: bbUpper, lower: bbLower } = calcBB(closes, BB_LEN, BB_MULT);

  // Streak counters (computed sequentially)
  const bullStreak = new Array(n).fill(0);
  const bearStreak = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const bull = emaFast[i] > emaSlow[i];
    if (i === 0) {
      bullStreak[i] = bull ? 1 : 0;
      bearStreak[i] = bull ? 0 : 1;
    } else {
      bullStreak[i] = bull ? bullStreak[i - 1] + 1 : 0;
      bearStreak[i] = bull ? 0 : bearStreak[i - 1] + 1;
    }
  }

  // ── simulate trades ─────────────────────────────────────────────────────────

  let cash        = START_CAP;
  let sharesHeld  = 0;      // units of whatever ticker
  let entryPrice  = 0;
  let trailStop   = 0;
  let trailActive = false;
  let deployedCash = 0;     // cash spent on current position

  const trades = [];
  let currentTrade = null;

  const WARMUP = Math.max(IQ_SLOW, RSI_LEN, BB_LEN, DIV_RSI_LEN) + DIV_LB * 2 + 5;

  for (let i = WARMUP; i < n; i++) {
    const c      = closes[i];
    const inPos  = sharesHeld > 0;

    // ── IQ Candles signals
    const iqBull       = emaFast[i] > emaSlow[i];
    const iqBear       = !iqBull;
    const iqFlipBull   = iqBull  && emaFast[i - 1] <= emaSlow[i - 1];
    const iqFlipBear   = iqBear  && emaFast[i - 1] >= emaSlow[i - 1];
    const iqStrongBull = bullStreak[i] >= IQ_CONFIRM;
    const iqStrongBear = bearStreak[i] >= IQ_CONFIRM;

    // ── RSI
    const r = rsi[i];
    if (isNaN(r)) continue;

    // ── Bollinger Bands
    const bbU = bbUpper[i], bbM = bbMid[i], bbL = bbLower[i];
    if (isNaN(bbU)) continue;
    const atLowerBB   = c <= bbL * 1.01;
    const atUpperBB   = c >= bbU * 0.99;
    const bbWidth     = bbU - bbL;
    const bbWidthPrev = !isNaN(bbUpper[i - 20]) ? bbUpper[i - 20] - bbLower[i - 20] : bbWidth;
    const bbSqueeze   = bbWidth < bbWidthPrev * 0.85;
    const crossMidUp  = closes[i - 1] < bbMid[i - 1] && c >= bbM;
    const crossMidDn  = closes[i - 1] > bbMid[i - 1] && c <= bbM;

    // ── Divergence IQ
    const pLowNow   = lowestN(closes,  i,          DIV_LB);
    const pLowPrev  = lowestN(closes,  i - DIV_LB, DIV_LB);
    const rLowNow   = lowestN(divRsi,  i,          DIV_LB);
    const rLowPrev  = lowestN(divRsi,  i - DIV_LB, DIV_LB);
    const pHighNow  = highestN(closes, i,           DIV_LB);
    const pHighPrev = highestN(closes, i - DIV_LB,  DIV_LB);
    const rHighNow  = highestN(divRsi, i,           DIV_LB);
    const rHighPrev = highestN(divRsi, i - DIV_LB,  DIV_LB);

    const bullDiv       = pLowNow  < pLowPrev  && rLowNow  > rLowPrev;
    const hiddenBullDiv = pLowNow  > pLowPrev  && rLowNow  < rLowPrev;
    const bearDiv       = pHighNow > pHighPrev && rHighNow < rHighPrev;
    const hiddenBearDiv = pHighNow < pHighPrev && rHighNow > rHighPrev;
    const divBullSig    = bullDiv || hiddenBullDiv;
    const divBearSig    = bearDiv || hiddenBearDiv;

    // ── Scores
    let buyScore = 0;
    buyScore += iqFlipBull   ? 4 : 0;
    buyScore += iqStrongBull ? 2 : 0;
    buyScore += bullDiv       ? 2 : 0;
    buyScore += hiddenBullDiv ? 1 : 0;
    buyScore += r < 50        ? 2 : 0;
    buyScore += r < 40        ? 1 : 0;
    buyScore += atLowerBB     ? 2 : 0;
    buyScore += crossMidUp    ? 1 : 0;
    buyScore += !bbSqueeze    ? 1 : 0;
    buyScore -= iqBear        ? 5 : 0;
    buyScore -= divBearSig    ? 2 : 0;
    buyScore -= r > RSI_OB    ? 4 : 0;
    buyScore -= atUpperBB     ? 2 : 0;
    buyScore = Math.max(0, Math.min(10, buyScore));

    let sellScore = 0;
    sellScore += iqFlipBear   ? 4 : 0;
    sellScore += iqStrongBear ? 2 : 0;
    sellScore += bearDiv       ? 2 : 0;
    sellScore += hiddenBearDiv ? 1 : 0;
    sellScore += r > 60        ? 2 : 0;
    sellScore += r > RSI_OB    ? 1 : 0;
    sellScore += atUpperBB     ? 2 : 0;
    sellScore += crossMidDn    ? 1 : 0;
    sellScore -= iqBull        ? 5 : 0;
    sellScore -= divBullSig    ? 2 : 0;
    sellScore -= r < RSI_OS    ? 4 : 0;
    sellScore -= atLowerBB     ? 2 : 0;
    sellScore = Math.max(0, Math.min(10, sellScore));

    // ── Entry
    const longCond = iqBull && r < RSI_MAX_BUY && buyScore >= MIN_SCORE && !inPos;
    // ── Exit conditions
    const exitCond = iqBear && sellScore >= MIN_SCORE && inPos;

    if (longCond) {
      // Tiered sizing: equity = cash (no position open yet)
      const pct         = allocPct(cash);
      deployedCash      = cash * pct;
      sharesHeld        = deployedCash / c;
      cash             -= deployedCash;
      entryPrice        = c;
      trailStop         = 0;
      trailActive       = false;
      currentTrade = {
        entryTime:   new Date(candles[i].time).toISOString(),
        entryPrice:  c,
        score:       buyScore,
        allocPct:    pct,
        deployed:    deployedCash,
      };
    }

    if (inPos) {
      const profitPct = (c - entryPrice) / entryPrice * 100;
      if (profitPct >= TRAIL_ACT && !trailActive) {
        trailActive = true;
        trailStop   = entryPrice;
      }
      if (trailActive) {
        const newStop = c * (1 - TRAIL_PCT / 100);
        trailStop = Math.max(trailStop, newStop);
      }

      const closePosition = (exitPrice, reason) => {
        const proceeds = sharesHeld * exitPrice;
        const pnlDollar = proceeds - deployedCash;
        const pnlPct    = (exitPrice - currentTrade.entryPrice) / currentTrade.entryPrice * 100;
        cash += proceeds;
        trades.push({
          ...currentTrade,
          exitTime:   new Date(candles[i].time).toISOString(),
          exitPrice,
          exitReason: reason,
          pnlPct,
          pnlDollar,
          won: pnlPct > 0,
        });
        sharesHeld = 0; trailActive = false; trailStop = 0;
        deployedCash = 0; currentTrade = null;
      };

      // Trail stop hit
      if (trailActive && c <= trailStop) {
        closePosition(trailStop, 'Trail Stop');
        continue;
      }

      // Signal exit
      if (exitCond) {
        closePosition(c, 'IQ Bear Exit');
      }
    }
  }

  // Close any open position at last close
  if (sharesHeld > 0 && currentTrade) {
    const lastC     = closes[n - 1];
    const proceeds  = sharesHeld * lastC;
    const pnlDollar = proceeds - deployedCash;
    const pnlPct    = (lastC - currentTrade.entryPrice) / currentTrade.entryPrice * 100;
    cash += proceeds;
    trades.push({
      ...currentTrade,
      exitTime:   new Date(candles[n - 1].time).toISOString(),
      exitPrice:  lastC,
      exitReason: 'Open (last bar)',
      pnlPct,
      pnlDollar,
      won: pnlPct > 0,
    });
    sharesHeld = 0;
  }

  // ── Results ─────────────────────────────────────────────────────────────────

  const finalEquity = cash;
  const netDollar   = (finalEquity - START_CAP).toFixed(2);
  const netPct      = ((finalEquity - START_CAP) / START_CAP * 100).toFixed(2);

  const totalTrades = trades.length;
  const wins        = trades.filter(t => t.won).length;
  const losses      = totalTrades - wins;
  const winRate     = totalTrades ? (wins / totalTrades * 100).toFixed(1) : '0.0';

  const avgWinPct  = wins   ? (trades.filter(t => t.won).reduce((s, t) => s + t.pnlPct, 0) / wins).toFixed(2)        : '0.00';
  const avgLossPct = losses ? (trades.filter(t => !t.won).reduce((s, t) => s + t.pnlPct, 0) / losses).toFixed(2)     : '0.00';
  const avgWin$    = wins   ? (trades.filter(t => t.won).reduce((s, t) => s + t.pnlDollar, 0) / wins).toFixed(2)     : '0.00';
  const avgLoss$   = losses ? (trades.filter(t => !t.won).reduce((s, t) => s + t.pnlDollar, 0) / losses).toFixed(2)  : '0.00';
  const biggestWin = wins   ? Math.max(...trades.filter(t => t.won).map(t => t.pnlPct)).toFixed(2)                    : '0.00';
  const biggestLoss= losses ? Math.min(...trades.filter(t => !t.won).map(t => t.pnlPct)).toFixed(2)                   : '0.00';

  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  BACKTEST RESULTS — Last ${days} Days  (${ticker} ${interval})`);
  console.log('  Strategy: IQ Candles + Divergence IQ + RSI + BB');
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log(`  Starting Capital : $${START_CAP.toFixed(2)}`);
  console.log(`  Final Equity     : $${finalEquity.toFixed(2)}`);
  console.log(`  Net P&L          : $${netDollar}  (${netPct >= 0 ? '+' : ''}${netPct}%)\n`);
  console.log(`  Total Trades     : ${totalTrades}`);
  console.log(`  Wins             : ${wins}   (${winRate}% win rate)`);
  console.log(`  Losses           : ${losses}`);
  console.log('');
  console.log(`  Avg Win          : +${avgWinPct}%   (+$${avgWin$} actual)`);
  console.log(`  Avg Loss         :  ${avgLossPct}%   ($${avgLoss$} actual)`);
  console.log(`  Biggest Win      : +${biggestWin}%`);
  console.log(`  Biggest Loss     :  ${biggestLoss}%`);
  console.log('');
  console.log('  Position Sizing Tiers Used:');
  console.log('    < $1,000  → 100%  |  $1k–$2k → 50%  |  $2k–$10k → 25%  |  $10k+ → 15%');
  console.log('');
  console.log('  ── Trade Log ──────────────────────────────────────────────────');
  console.log(`  ${'#'.padEnd(3)} ${'Entry Date'.padEnd(20)} ${'Alloc'.padEnd(7)} ${'Deployed'.padEnd(11)} ${'Entry $'.padEnd(10)} ${'Exit $'.padEnd(10)} ${'P&L %'.padEnd(9)} ${'P&L $'.padEnd(10)} Reason`);
  trades.forEach((t, idx) => {
    const sign   = t.pnlPct >= 0 ? '+' : '';
    const sign$  = t.pnlDollar >= 0 ? '+' : '';
    const marker = t.won ? '✓' : '✗';
    console.log(
      `  ${marker} ${String(idx + 1).padEnd(2)} ${t.entryTime.replace('T', ' ').slice(0, 19).padEnd(20)} ` +
      `${(Math.round(t.allocPct * 100) + '%').padEnd(7)}` +
      `$${t.deployed.toFixed(0).padEnd(10)} ` +
      `$${t.entryPrice.toFixed(2).padEnd(9)} $${t.exitPrice.toFixed(2).padEnd(9)} ` +
      `${(sign + t.pnlPct.toFixed(2) + '%').padEnd(9)} ` +
      `${(sign$ + '$' + t.pnlDollar.toFixed(2)).padEnd(10)} ${t.exitReason}`
    );
  });
  console.log('══════════════════════════════════════════════════════════════\n');
})();
