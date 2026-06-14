// Live Signal Checker — SPY 0DTE Strategy
// Fetches latest SPY 30m data, computes signal, shows trade recommendation.
// Tracks a paper position in paper-position.json.
//
// Usage:
//   node live-signal.mjs [account_size]         — check signal + position status
//   node live-signal.mjs enter [account_size]   — record entering the current signal trade
//   node live-signal.mjs exit                   — record closing the open position
//   node live-signal.mjs scale [level]          — record a scale-out (level = 1-5)
//   node live-signal.mjs reset                  — clear paper position

import https from 'https';
import fs    from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';

const TELEGRAM = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'telegram.json'), 'utf8'
));

async function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: TELEGRAM.chat_id, text, parse_mode: 'HTML' });
  await fetch(`https://api.telegram.org/bot${TELEGRAM.bot_token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  }).catch(() => {});
}

const DIR        = path.dirname(fileURLToPath(import.meta.url));
const POS_FILE   = path.join(DIR, 'paper-position.json');
const LOG_FILE   = path.join(DIR, 'signal-log.jsonl');
const TICKER     = 'SPY';
const INTERVAL   = '30m';
const RANGE      = '5d';

// ── fetch ─────────────────────────────────────────────────────────────────────
function fetchCandles(ticker, range, interval) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const r = j?.chart?.result?.[0];
          if (!r) return reject(new Error(JSON.stringify(j?.chart?.error)));
          const q = r.indicators.quote[0];
          resolve(r.timestamp.map((t, i) => ({
            time:  t * 1000,
            close: q.close[i],
          })).filter(c => c.close != null && !isNaN(c.close)));
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── Black-Scholes ─────────────────────────────────────────────────────────────
function erf(x) {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign=x<0?-1:1; x=Math.abs(x);
  const t=1/(1+p*x);
  return sign*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x));
}
function normCDF(x){return 0.5*(1+erf(x/Math.sqrt(2)));}
function bsCall(S,K,T,r,v){if(T<=0)return Math.max(S-K,0);const d1=(Math.log(S/K)+(r+0.5*v*v)*T)/(v*Math.sqrt(T)),d2=d1-v*Math.sqrt(T);return S*normCDF(d1)-K*Math.exp(-r*T)*normCDF(d2);}
function bsPut(S,K,T,r,v){if(T<=0)return Math.max(K-S,0);const d1=(Math.log(S/K)+(r+0.5*v*v)*T)/(v*Math.sqrt(T)),d2=d1-v*Math.sqrt(T);return K*Math.exp(-r*T)*normCDF(-d2)-S*normCDF(-d1);}

function histVol(closes, i, bpy) {
  const n = Math.max(2, Math.round(bpy/252));
  if (i < n+1) return 0.20;
  let s=0;
  for(let j=i-n;j<i;j++){const r=Math.log(closes[j+1]/closes[j]);s+=r*r;}
  return Math.sqrt((s/n)*bpy);
}

// ── Indicators ────────────────────────────────────────────────────────────────
function calcEMA(closes,p){const k=2/(p+1);let e=closes[0];const r=[e];for(let i=1;i<closes.length;i++){e=closes[i]*k+e*(1-k);r.push(e);}return r;}
function calcRSI(closes,p){
  const r=new Array(closes.length).fill(NaN);let ag=0,al=0;
  for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];if(d>0)ag+=d;else al-=d;}
  ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);
  for(let i=p+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}
  return r;
}
function calcBB(closes,p,m){
  const mid=new Array(closes.length).fill(NaN),upper=new Array(closes.length).fill(NaN),lower=new Array(closes.length).fill(NaN);
  for(let i=p-1;i<closes.length;i++){const s=closes.slice(i-p+1,i+1),mean=s.reduce((a,b)=>a+b,0)/p,std=Math.sqrt(s.reduce((a,b)=>a+(b-mean)**2,0)/p);mid[i]=mean;upper[i]=mean+m*std;lower[i]=mean-m*std;}
  return{mid,upper,lower};
}
function lowestN(arr,i,n){let lo=Infinity;for(let j=Math.max(0,i-n+1);j<=i;j++)if(!isNaN(arr[j]))lo=Math.min(lo,arr[j]);return lo;}
function highestN(arr,i,n){let hi=-Infinity;for(let j=Math.max(0,i-n+1);j<=i;j++)if(!isNaN(arr[j]))hi=Math.max(hi,arr[j]);return hi;}

// ── Position sizing ───────────────────────────────────────────────────────────
function allocPct(equity){
  if(equity< 2000)return 0.50;
  if(equity< 4000)return 0.40;
  if(equity<10000)return 0.25;
  if(equity<20000)return 0.10;
  return 0.08;
}
const MAX_DEPLOY=4000; // 8% of $50k account cap

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadPosition(){
  try { return JSON.parse(fs.readFileSync(POS_FILE,'utf8')); }
  catch { return null; }
}
function savePosition(pos){
  fs.writeFileSync(POS_FILE, JSON.stringify(pos, null, 2));
}
function clearPosition(){
  if(fs.existsSync(POS_FILE)) fs.unlinkSync(POS_FILE);
}
function appendLog(entry){
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
}

function etNow(){
  // Returns current ET time as a Date adjusted to ET offset
  const now = new Date();
  const utcH = now.getUTCHours();
  return now;
}

function timeToExpiry(now){
  // Time in years until 4pm ET today (20:00 UTC)
  const expiry = new Date(now);
  expiry.setUTCHours(20,0,0,0);
  if(expiry.getTime() <= now.getTime()) expiry.setUTCDate(expiry.getUTCDate()+1);
  return Math.max((expiry.getTime()-now.getTime())/(365*24*60*60*1000), 1/(365*24*60));
}

function isMarketOpen(now){
  const day = now.getUTCDay(); // 0=Sun 6=Sat
  if(day===0||day===6) return false;
  const h=now.getUTCHours(), m=now.getUTCMinutes();
  const mins=h*60+m;
  return mins>=13*60+30 && mins<20*60; // 9:30am-4pm ET in UTC (EDT offset -4)
}

function isAfter10amET(now){
  const h=now.getUTCHours(), m=now.getUTCMinutes();
  return (h*60+m) >= 14*60; // 10am ET = 14:00 UTC
}

function isBefore1pmET(now){
  const h=now.getUTCHours(), m=now.getUTCMinutes();
  return (h*60+m) < 17*60; // 1pm ET = 17:00 UTC
}

const RISK_FREE=0.053;
const MIN_SCORE=6, MIN_SCORE_FALLBACK=4;

// ── Markov 2.0 regime (stride-sampled, 20-day window) ────────────────────────
function buildStrideMatrix(states, stride) {
  const order = ['BULL','SIDEWAYS','BEAR'];
  const counts = {};
  order.forEach(a => { counts[a] = {}; order.forEach(b => counts[a][b] = 0); });
  for (let i = 0; i + stride < states.length; i += stride)
    counts[states[i]][states[i + stride]]++;
  const mat = {};
  order.forEach(row => {
    const total = order.reduce((s, c) => s + counts[row][c], 0);
    mat[row] = {};
    order.forEach(col => mat[row][col] = total > 0 ? counts[row][col] / total : 1/3);
  });
  return mat;
}

async function getMarkovRegime() {
  try {
    const daily = await fetchCandles('SPY', '2y', '1d');
    const closes = daily.map(c => c.close);
    const WINDOW = 20;
    const states = [];
    for (let i = WINDOW; i < closes.length; i++) {
      const ret = (closes[i] - closes[i - WINDOW]) / closes[i - WINDOW] * 100;
      states.push(ret >= 5 ? 'BULL' : ret <= -5 ? 'BEAR' : 'SIDEWAYS');
    }
    const mat = buildStrideMatrix(states, WINDOW);
    const cur = states[states.length - 1];
    const signal = mat[cur]['BULL'] - mat[cur]['BEAR'];
    return { regime: cur, signal, pBull: mat[cur]['BULL'], pBear: mat[cur]['BEAR'] };
  } catch {
    return { regime: 'SIDEWAYS', signal: 0, pBull: 0.33, pBear: 0.33 };
  }
}
const IQ_FAST=9,IQ_SLOW=21,IQ_CONFIRM=3;
const DIV_RSI_LEN=14,DIV_LB=5;
const RSI_LEN=14,RSI_OB=70,RSI_OS=30,RSI_MAX_BUY=70;
const BB_LEN=20,BB_MULT=2.0;
const BPY=Math.round(13*252); // 30m bars per year

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  const cmd    = process.argv[2] || '';
  const isCmd  = ['enter','exit','scale','reset'].includes(cmd.toLowerCase());
  const acctArg= isCmd ? parseFloat(process.argv[3]||'0') : parseFloat(cmd||'0');
  const action = isCmd ? cmd.toLowerCase() : 'check';

  // ── reset ──
  if(action==='reset'){
    clearPosition();
    console.log('\n  Paper position cleared.\n');
    return;
  }

  // ── exit ──
  if(action==='exit'){
    const pos=loadPosition();
    if(!pos){ console.log('\n  No open position to exit.\n'); return; }
    console.log(`\n  Fetching current ${TICKER} price...`);
    const candles=await fetchCandles(TICKER,RANGE,INTERVAL);
    const closes=candles.map(c=>c.close);
    const n=closes.length;
    const price=closes[n-1];
    const iv=histVol(closes,n-1,BPY);
    const T=timeToExpiry(new Date());
    const exitPremium=pos.type==='CALL'?bsCall(price,pos.strike,T,RISK_FREE,iv):bsPut(price,pos.strike,T,RISK_FREE,iv);
    const remainContracts=pos.contracts-pos.scaledContracts;
    const finalProceeds=exitPremium*100*remainContracts;
    const totalProceeds=pos.scaleProceeds+finalProceeds;
    const pnl=totalProceeds-pos.deployed;
    const pnlPct=pnl/pos.deployed*100;
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  EXIT — ${pos.type} @ $${pos.strike}`);
    console.log(`  Exit price:    $${price.toFixed(2)}  |  Option: $${exitPremium.toFixed(4)}/share`);
    console.log(`  Remaining:     ${remainContracts} contracts × $${exitPremium.toFixed(4)} × 100`);
    console.log(`  Final proceeds:$${finalProceeds.toFixed(2)}`);
    if(pos.scaledContracts>0) console.log(`  Scale proceeds: $${pos.scaleProceeds.toFixed(2)} (${pos.scaledContracts} contracts banked)`);
    console.log(`  ─────────────────────────────────────────────────`);
    console.log(`  Total P&L:     ${pnl>=0?'+':''} $${pnl.toFixed(2)}  (${pnlPct>=0?'+':''}${pnlPct.toFixed(1)}%)`);
    console.log(`  New account:   $${(pos.accountSize+pnl).toFixed(2)}`);
    console.log(`${'═'.repeat(60)}\n`);
    await sendTelegram([
      pnl>=0?`✅ <b>TRADE CLOSED — WIN</b>`:`🔴 <b>TRADE CLOSED — LOSS</b>`,
      `${pos.type} $${pos.strike} — ${pos.contracts} contracts`,
      ``,
      pos.scaledContracts>0?`Banked early: $${pos.scaleProceeds.toFixed(2)} (${pos.scaledContracts} contracts)`:'No scale-outs triggered',
      `Final exit: $${finalProceeds.toFixed(2)} (${remainContracts} contracts)`,
      ``,
      `<b>P&amp;L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}  (${pnlPct>=0?'+':''}${pnlPct.toFixed(1)}%)</b>`,
      `New account size: $${(pos.accountSize+pnl).toFixed(2)}`,
    ].join('\n'));
    clearPosition();
    return;
  }

  // ── scale ──
  if(action==='scale'){
    const level=parseInt(process.argv[3]||'1',10);
    const pos=loadPosition();
    if(!pos){ console.log('\n  No open position to scale.\n'); return; }
    console.log(`\n  Fetching current ${TICKER} price...`);
    const candles=await fetchCandles(TICKER,RANGE,INTERVAL);
    const closes=candles.map(c=>c.close);
    const n=closes.length;
    const price=closes[n-1];
    const iv=histVol(closes,n-1,BPY);
    const T=timeToExpiry(new Date());
    const currentPremium=pos.type==='CALL'?bsCall(price,pos.strike,T,RISK_FREE,iv):bsPut(price,pos.strike,T,RISK_FREE,iv);
    const sellContracts=Math.min(pos.contracts-pos.scaledContracts, Math.max(1,Math.round(pos.contracts*0.10)));
    const proceeds=currentPremium*100*sellContracts;
    pos.scaledContracts+=sellContracts;
    pos.scaleProceeds+=proceeds;
    pos.scales=pos.scales||[];
    pos.scales.push({level,time:new Date().toISOString(),price,premium:currentPremium.toFixed(4),contracts:sellContracts,proceeds});
    savePosition(pos);
    console.log(`\n  Scale-out level ${level} recorded:`);
    console.log(`  Sold ${sellContracts} contracts @ $${currentPremium.toFixed(4)}/share = $${proceeds.toFixed(2)} banked`);
    console.log(`  Remaining: ${pos.contracts-pos.scaledContracts} contracts still open\n`);
    await sendTelegram([
      `💰 <b>SCALE-OUT LEVEL ${level} (+${level*10}%)</b>`,
      `Sold ${sellContracts} contracts @ $${currentPremium.toFixed(4)}/share`,
      `Banked: $${proceeds.toFixed(2)}`,
      `Total banked: $${pos.scaleProceeds.toFixed(2)}`,
      `Remaining open: ${pos.contracts-pos.scaledContracts} contracts`,
    ].join('\n'));
    return;
  }

  // ── fetch & compute signal ─────────────────────────────────────────────────
  process.stdout.write(`\n  Fetching ${TICKER} ${INTERVAL} data...\n`);
  const [candles, markov] = await Promise.all([
    fetchCandles(TICKER, RANGE, INTERVAL),
    getMarkovRegime(),
  ]);
  const closes  = candles.map(c=>c.close);
  const n       = closes.length;
  const now     = new Date();

  const emaFast=calcEMA(closes,IQ_FAST);
  const emaSlow=calcEMA(closes,IQ_SLOW);
  const rsi    =calcRSI(closes,RSI_LEN);
  const divRsi =calcRSI(closes,DIV_RSI_LEN);
  const {mid:bbMid,upper:bbUpper,lower:bbLower}=calcBB(closes,BB_LEN,BB_MULT);

  const bullStreak=new Array(n).fill(0),bearStreak=new Array(n).fill(0);
  for(let i=0;i<n;i++){const bull=emaFast[i]>emaSlow[i];if(i===0){bullStreak[i]=bull?1:0;bearStreak[i]=bull?0:1;}else{bullStreak[i]=bull?bullStreak[i-1]+1:0;bearStreak[i]=bull?0:bearStreak[i-1]+1;}}

  const i=n-1;
  const c=closes[i];
  const iqBull=emaFast[i]>emaSlow[i], iqBear=!iqBull;
  const iqFlipBull=iqBull&&emaFast[i-1]<=emaSlow[i-1];
  const iqFlipBear=iqBear&&emaFast[i-1]>=emaSlow[i-1];
  const iqStrongBull=bullStreak[i]>=IQ_CONFIRM;
  const iqStrongBear=bearStreak[i]>=IQ_CONFIRM;
  const r=rsi[i];
  const bbU=bbUpper[i],bbM=bbMid[i],bbL=bbLower[i];
  const atLowerBB=c<=bbL*1.01,atUpperBB=c>=bbU*0.99;
  const bbWidth=bbU-bbL;
  const bbWidthPrev=!isNaN(bbUpper[i-20])?bbUpper[i-20]-bbLower[i-20]:bbWidth;
  const bbSqueeze=bbWidth<bbWidthPrev*0.85;
  const crossMidUp=closes[i-1]<bbMid[i-1]&&c>=bbM;
  const crossMidDn=closes[i-1]>bbMid[i-1]&&c<=bbM;
  const pLowNow=lowestN(closes,i,DIV_LB),pLowPrev=lowestN(closes,i-DIV_LB,DIV_LB);
  const rLowNow=lowestN(divRsi,i,DIV_LB),rLowPrev=lowestN(divRsi,i-DIV_LB,DIV_LB);
  const pHighNow=highestN(closes,i,DIV_LB),pHighPrev=highestN(closes,i-DIV_LB,DIV_LB);
  const rHighNow=highestN(divRsi,i,DIV_LB),rHighPrev=highestN(divRsi,i-DIV_LB,DIV_LB);
  const bullDiv=pLowNow<pLowPrev&&rLowNow>rLowPrev;
  const hiddenBullDiv=pLowNow>pLowPrev&&rLowNow<rLowPrev;
  const bearDiv=pHighNow>pHighPrev&&rHighNow<rHighPrev;
  const hiddenBearDiv=pHighNow<pHighPrev&&rHighNow>rHighPrev;
  const divBullSig=bullDiv||hiddenBullDiv,divBearSig=bearDiv||hiddenBearDiv;

  let buyScore=0;
  buyScore+=iqFlipBull?4:0; buyScore+=iqStrongBull?2:0;
  buyScore+=bullDiv?2:0; buyScore+=hiddenBullDiv?1:0;
  buyScore+=r<50?2:0; buyScore+=r<40?1:0;
  buyScore+=atLowerBB?2:0; buyScore+=crossMidUp?1:0; buyScore+=!bbSqueeze?1:0;
  buyScore-=iqBear?5:0; buyScore-=divBearSig?2:0;
  buyScore-=r>RSI_OB?4:0; buyScore-=atUpperBB?2:0;
  buyScore=Math.max(0,Math.min(10,buyScore));

  // Markov 2.0 buy contribution (20% weight): BULL=10, SIDEWAYS=5, BEAR=0
  const markovBuyPts  = markov.regime==='BULL' ? 10 : markov.regime==='BEAR' ? 0 : 5;

  let sellScore=0;
  sellScore+=iqFlipBear?4:0; sellScore+=iqStrongBear?2:0;
  sellScore+=bearDiv?2:0; sellScore+=hiddenBearDiv?1:0;
  sellScore+=r>60?2:0; sellScore+=r>RSI_OB?1:0;
  sellScore+=atUpperBB?2:0; sellScore+=crossMidDn?1:0;
  sellScore-=iqBull?5:0; sellScore-=divBullSig?2:0;
  sellScore-=r<RSI_OS?4:0; sellScore-=atLowerBB?2:0;
  sellScore=Math.max(0,Math.min(10,sellScore));

  // Markov 2.0 sell contribution (20% weight): BEAR=10, SIDEWAYS=5, BULL=0
  const markovSellPts = markov.regime==='BEAR' ? 10 : markov.regime==='BULL' ? 0 : 5;

  // Blend: 80% existing indicators + 20% Markov 2.0
  const buyScoreRaw  = buyScore;
  const sellScoreRaw = sellScore;
  buyScore  = Math.round(buyScore  * 0.8 + markovBuyPts  * 0.2);
  sellScore = Math.round(sellScore * 0.8 + markovSellPts * 0.2);

  const beforeCutoff=isAfter10amET(now) && isBefore1pmET(now);
  const iv=histVol(closes,i,BPY);
  const T=timeToExpiry(now);
  const expiryMins=Math.round(T*365*24*60);

  // Signal decision
  const primaryBull=iqBull&&r<RSI_MAX_BUY&&buyScore>=MIN_SCORE;
  const primaryBear=iqBear&&sellScore>=MIN_SCORE;
  const fallbackBull=iqBull&&r<RSI_MAX_BUY&&buyScore>=MIN_SCORE_FALLBACK&&!primaryBull;
  const fallbackBear=iqBear&&sellScore>=MIN_SCORE_FALLBACK&&!primaryBear;

  const signalType = primaryBull?'CALL PRIMARY':fallbackBull?'CALL FALLBACK':primaryBear?'PUT PRIMARY':fallbackBear?'PUT FALLBACK':'NONE';
  const direction  = signalType.startsWith('CALL')?'CALL':signalType.startsWith('PUT')?'PUT':null;
  const score      = direction==='CALL'?buyScore:direction==='PUT'?sellScore:0;

  // Option pricing
  const strike = direction?Math.round(c*20)/20:null;
  const premium= direction==='CALL'?bsCall(c,strike,T,RISK_FREE,iv)*100:direction==='PUT'?bsPut(c,strike,T,RISK_FREE,iv)*100:null;

  // ── print header ──────────────────────────────────────────────────────────
  const timeStr=now.toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'});
  const dateStr=now.toLocaleDateString('en-US',{timeZone:'America/New_York',weekday:'short',month:'short',day:'numeric'});
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  SPY 0DTE Signal Check — ${dateStr}  ${timeStr} ET`);
  console.log(`${'═'.repeat(62)}`);
  console.log(`  SPY Price  : $${c.toFixed(2)}`);
  console.log(`  IV (hist)  : ${(iv*100).toFixed(0)}%`);
  console.log(`  Time left  : ~${Math.floor(expiryMins/60)}h ${expiryMins%60}m to 4pm expiry`);
  console.log(`  EMA trend  : ${iqBull?'BULLISH ▲':'BEARISH ▼'}  (${iqBull?`${bullStreak[i]} bars up`:`${bearStreak[i]} bars down`})`);
  console.log(`  RSI        : ${isNaN(r)?'n/a':r.toFixed(1)}  ${r>RSI_OB?'(overbought)':r<RSI_OS?'(oversold)':'(neutral)'}`);
  console.log(`  BB position: ${atLowerBB?'At LOWER band':atUpperBB?'At UPPER band':c>bbM?'Above mid':'Below mid'}`);
  console.log(`  Divergence : ${divBullSig?'BULL DIV ↑':divBearSig?'BEAR DIV ↓':'None'}`);
  console.log(`  Markov 2.0 : ${markov.regime} regime  |  P(bull)=${markov.pBull.toFixed(2)}  P(bear)=${markov.pBear.toFixed(2)}  sig=${markov.signal>=0?'+':''}${markov.signal.toFixed(3)}`);
  console.log(`  Buy score  : ${buyScoreRaw}/10 raw → ${buyScore}/10 blended   Sell: ${sellScoreRaw}/10 raw → ${sellScore}/10 blended  (80% indicators + 20% Markov)`);
  console.log(`${'─'.repeat(62)}`);

  // ── signal recommendation ─────────────────────────────────────────────────
  const pos = loadPosition();
  let alerted = false;
  if(!direction){
    console.log(`  SIGNAL     : ⏸  NO TRADE — score too low`);
    console.log(`               Minimum needed: ${MIN_SCORE_FALLBACK} (fallback) / ${MIN_SCORE} (primary)`);
  } else if(!beforeCutoff){
    console.log(`  SIGNAL     : ⚠  ${direction} signal (score ${score}) but outside 10am–1pm ET window`);
    console.log(`               Too late to enter 0DTE — skip this one`);
  } else {
    const quality=signalType.includes('PRIMARY')?'★ PRIMARY':'◎ FALLBACK';
    console.log(`  SIGNAL     : 🟢 ${direction} — ${quality} (score ${score}/10)`);
    console.log(`  Strike     : $${strike.toFixed(2)}  (ATM)`);
    console.log(`  Premium est: ~$${premium.toFixed(2)}/contract`);
    console.log(`  Expires    : today 4pm ET (0DTE)`);
    console.log(`${'─'.repeat(62)}`);

    // Position sizing
    const sizes = acctArg>0 ? [acctArg] : [600,1000,2000,5000];
    console.log(`  POSITION SIZING:`);
    sizes.forEach(acct=>{
      const pct=allocPct(acct);
      const cash=Math.min(acct*pct,MAX_DEPLOY);
      const qty=Math.min(50,Math.max(1,Math.floor(cash/premium)));
      const deployed=qty*premium;
      console.log(`    $${acct.toLocaleString()} account → ${(pct*100).toFixed(0)}% = $${cash.toFixed(0)} → ${qty} contracts @ $${premium.toFixed(2)} = $${deployed.toFixed(2)} deployed`);
    });
    console.log(`${'─'.repeat(62)}`);
    console.log(`  SCALE-OUT TARGETS (10% incremental, up to 50%):`);
    [1,2,3,4,5].forEach(lvl=>{
      const trigger=premium*(1+lvl*0.10);
      console.log(`    +${lvl*10}% → option hits $${trigger.toFixed(2)}/contract — sell 10% of position`);
    });

    // Send Telegram alert if no position already open
    if(!pos && action==='check'){
      const acct=acctArg>0?acctArg:600;
      const pct=allocPct(acct);
      const cash=Math.min(acct*pct,MAX_DEPLOY);
      const qty=Math.min(50,Math.max(1,Math.floor(cash/premium)));
      const deployed=qty*premium;
      const scaleLines=[1,2,3,4,5].map(l=>`  +${l*10}% → sell when premium hits $${(premium*(1+l*0.10)).toFixed(2)}`).join('\n');
      const msg=[
        `📊 <b>SPY 0DTE SIGNAL — ${dateStr} ${timeStr} ET</b>`,
        ``,
        `🟢 <b>${direction} ${quality}</b>  (score ${score}/10)`,
        `Strike: <b>$${strike.toFixed(2)}</b>  |  IV: ${(iv*100).toFixed(0)}%  |  Markov: ${markov.regime}`,
        `Premium: ~<b>$${premium.toFixed(2)}</b>/contract`,
        ``,
        `<b>Your trade ($${acct} account):</b>`,
        `  ${(pct*100).toFixed(0)}% alloc → <b>${qty} contracts</b> @ $${premium.toFixed(2)} = $${deployed.toFixed(2)}`,
        ``,
        `<b>Scale-out targets:</b>`,
        scaleLines,
        ``,
        `⏰ Expires 4pm ET — enter 10am–1pm ET | exit by 3pm ET`,
        `Run: node live-signal.mjs enter ${acct}`,
      ].join('\n');
      await sendTelegram(msg);
      alerted = true;
      console.log(`\n  📱 Signal sent to Telegram.`);
    }
  }

  // ── log scan result ───────────────────────────────────────────────────────
  if(action==='check'){
    appendLog({
      time: now.toISOString(),
      price: +c.toFixed(2),
      buyScore, sellScore,
      signal: signalType,
      alerted,
    });
  }

  // ── open position status ──────────────────────────────────────────────────
  if(pos){
    const currentPremium=pos.type==='CALL'?bsCall(c,pos.strike,T,RISK_FREE,iv):bsPut(c,pos.strike,T,RISK_FREE,iv);
    const remainContracts=pos.contracts-(pos.scaledContracts||0);
    const currentValue=currentPremium*100*remainContracts;
    const totalValue=(pos.scaleProceeds||0)+currentValue;
    const pnl=totalValue-pos.deployed;
    const pnlPct=pnl/pos.deployed*100;
    const entryPPc=pos.deployed/pos.contracts;
    const nextScaleLevel=(pos.scales||[]).length+1;
    const nextTrigger=entryPPc/100*(1+nextScaleLevel*0.10);
    const nextTriggerPct=nextScaleLevel*10;

    console.log(`\n${'─'.repeat(62)}`);
    console.log(`  📋 OPEN PAPER POSITION`);
    console.log(`  ${pos.type} @ $${pos.strike}  |  Entered: ${new Date(pos.entryTime).toLocaleString('en-US',{timeZone:'America/New_York'})}`);
    console.log(`  Entry: ${pos.contracts} contracts × $${(entryPPc/100).toFixed(4)}/share = $${pos.deployed.toFixed(2)} deployed`);
    console.log(`  Current premium : $${currentPremium.toFixed(4)}/share`);
    console.log(`  Current value   : $${currentValue.toFixed(2)} (${remainContracts} contracts remaining)`);
    if(pos.scaledContracts>0) console.log(`  Banked so far   : $${pos.scaleProceeds.toFixed(2)} (${pos.scaledContracts} contracts scaled)`);
    console.log(`  ─────────────────────────────────────────────────`);
    const marker=pnl>=0?'✅':'🔴';
    console.log(`  ${marker} P&L: ${pnl>=0?'+':''} $${pnl.toFixed(2)}  (${pnlPct>=0?'+':''}${pnlPct.toFixed(1)}% on deployed)`);
    if(nextScaleLevel<=5){
      const pctToTrigger=((currentPremium-(entryPPc/100))/(entryPPc/100)*100).toFixed(1);
      console.log(`  Next scale-out  : +${nextTriggerPct}% trigger @ $${nextTrigger.toFixed(4)}/share (currently ${pctToTrigger}%)`);
    } else {
      console.log(`  All 5 scale-outs triggered — ride remaining to expiry`);
    }

    // Exit signal check
    const exitSignal=(pos.type==='CALL'&&(primaryBear||fallbackBear))||(pos.type==='PUT'&&(primaryBull||fallbackBull));
    if(exitSignal) console.log(`  ⚠️  EXIT SIGNAL: opposing signal detected — consider closing position`);
  }

  console.log(`\n${'═'.repeat(62)}`);

  // ── enter ──────────────────────────────────────────────────────────────────
  if(action==='enter'){
    if(!direction){
      console.log('\n  Cannot enter — no valid signal.\n'); return;
    }
    if(!beforeCutoff){
      console.log('\n  Cannot enter — outside 10am–1pm ET window.\n'); return;
    }
    if(pos){
      console.log('\n  Already have an open position. Run "exit" first.\n'); return;
    }
    const acct=acctArg>0?acctArg:600;
    const pct=allocPct(acct);
    const cash=Math.min(acct*pct,MAX_DEPLOY);
    const qty=Math.min(50,Math.max(1,Math.floor(cash/premium)));
    const deployed=qty*premium;
    const newPos={
      type:direction, strike, entryTime:now.toISOString(), entryPrice:c,
      contracts:qty, deployed, accountSize:acct,
      scaledContracts:0, scaleProceeds:0, scales:[],
    };
    savePosition(newPos);
    console.log(`\n  ✅ Paper position recorded:`);
    console.log(`     ${direction} $${strike} — ${qty} contracts — $${deployed.toFixed(2)} deployed`);
    console.log(`     Account: $${acct}  |  Alloc: ${(pct*100).toFixed(0)}%`);
    await sendTelegram([
      `✅ <b>PAPER TRADE ENTERED</b>`,
      `${direction} $${strike} — ${qty} contracts`,
      `Deployed: $${deployed.toFixed(2)}  (${(pct*100).toFixed(0)}% of $${acct})`,
      `Premium: $${(deployed/qty).toFixed(2)}/contract`,
      `Expires: today 4pm ET`,
    ].join('\n'));
    console.log(`\n  Commands:`);
    console.log(`     node live-signal.mjs              — refresh signal + position P&L`);
    console.log(`     node live-signal.mjs scale [1-5]  — record a scale-out`);
    console.log(`     node live-signal.mjs exit          — close position\n`);
  } else {
    console.log(`\n  Commands:`);
    if(direction&&beforeCutoff&&!pos)
      console.log(`     node live-signal.mjs enter ${acctArg||600}   — record entering this trade`);
    if(pos){
      console.log(`     node live-signal.mjs scale [1-5]  — record a scale-out`);
      console.log(`     node live-signal.mjs exit          — close position`);
    }
    console.log(`     node live-signal.mjs reset         — clear paper position`);
    console.log('');
  }
})();
