// SPY 0DTE Signal Bot — Cloud Server
// Runs on Render.com (free tier)
// - Checks SPY signal every 30min during market hours → Telegram
// - Listens for Telegram commands from your phone:
//     enter [account]  — record entering the trade
//     scale [1-5]      — record a scale-out
//     exit             — close position + P&L
//     status           — current position value
//     help             — show all commands

import express   from 'express';
import cron      from 'node-cron';
import https     from 'https';

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;
const PORT      = process.env.PORT || 3000;

// ── In-memory paper position ──────────────────────────────────────────────────
let position = null;  // null = no open trade

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  }).then(r => r.json()).catch(e => console.error('Telegram error:', e.message));
}

// ── Yahoo Finance ─────────────────────────────────────────────────────────────
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
            time: t * 1000, close: q.close[i],
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
  const n=Math.max(2,Math.round(bpy/252)); if(i<n+1)return 0.20;
  let s=0; for(let j=i-n;j<i;j++){const r=Math.log(closes[j+1]/closes[j]);s+=r*r;}
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

// ── Strategy constants ────────────────────────────────────────────────────────
const IQ_FAST=9,IQ_SLOW=21,IQ_CONFIRM=3,DIV_RSI_LEN=14,DIV_LB=5;
const RSI_LEN=14,RSI_OB=70,RSI_OS=30,RSI_MAX_BUY=70,BB_LEN=20,BB_MULT=2.0;
const MIN_SCORE=6,MIN_SCORE_FALLBACK=4,RISK_FREE=0.053;
const BPY=Math.round(13*252);

function allocPct(equity){
  if(equity< 2000)return 0.50;
  if(equity< 4000)return 0.60;
  if(equity<10000)return 0.25;
  return 0.10;
}

function timeToExpiry(now){
  const expiry=new Date(now); expiry.setUTCHours(20,0,0,0);
  if(expiry.getTime()<=now.getTime()) expiry.setUTCDate(expiry.getUTCDate()+1);
  return Math.max((expiry.getTime()-now.getTime())/(365*24*60*60*1000),1/(365*24*60));
}

// ── Core signal computation ───────────────────────────────────────────────────
async function computeSignal() {
  const candles = await fetchCandles('SPY','5d','30m');
  const closes  = candles.map(c=>c.close);
  const n       = closes.length;
  const now     = new Date();

  const emaFast=calcEMA(closes,IQ_FAST), emaSlow=calcEMA(closes,IQ_SLOW);
  const rsi=calcRSI(closes,RSI_LEN), divRsi=calcRSI(closes,DIV_RSI_LEN);
  const {mid:bbMid,upper:bbUpper,lower:bbLower}=calcBB(closes,BB_LEN,BB_MULT);

  const bullStreak=new Array(n).fill(0),bearStreak=new Array(n).fill(0);
  for(let i=0;i<n;i++){const bull=emaFast[i]>emaSlow[i];if(i===0){bullStreak[i]=bull?1:0;bearStreak[i]=bull?0:1;}else{bullStreak[i]=bull?bullStreak[i-1]+1:0;bearStreak[i]=bull?0:bearStreak[i-1]+1;}}

  const i=n-1, c=closes[i];
  const iqBull=emaFast[i]>emaSlow[i], iqBear=!iqBull;
  const iqFlipBull=iqBull&&emaFast[i-1]<=emaSlow[i-1];
  const iqFlipBear=iqBear&&emaFast[i-1]>=emaSlow[i-1];
  const iqStrongBull=bullStreak[i]>=IQ_CONFIRM, iqStrongBear=bearStreak[i]>=IQ_CONFIRM;
  const r=rsi[i];
  const bbU=bbUpper[i],bbM=bbMid[i],bbL=bbLower[i];
  const atLowerBB=c<=bbL*1.01, atUpperBB=c>=bbU*0.99;
  const bbWidth=bbU-bbL, bbWidthPrev=!isNaN(bbUpper[i-20])?bbUpper[i-20]-bbLower[i-20]:bbWidth;
  const bbSqueeze=bbWidth<bbWidthPrev*0.85;
  const crossMidUp=closes[i-1]<bbMid[i-1]&&c>=bbM;
  const crossMidDn=closes[i-1]>bbMid[i-1]&&c<=bbM;
  const pLowNow=lowestN(closes,i,DIV_LB),pLowPrev=lowestN(closes,i-DIV_LB,DIV_LB);
  const rLowNow=lowestN(divRsi,i,DIV_LB),rLowPrev=lowestN(divRsi,i-DIV_LB,DIV_LB);
  const pHighNow=highestN(closes,i,DIV_LB),pHighPrev=highestN(closes,i-DIV_LB,DIV_LB);
  const rHighNow=highestN(divRsi,i,DIV_LB),rHighPrev=highestN(divRsi,i-DIV_LB,DIV_LB);
  const bullDiv=pLowNow<pLowPrev&&rLowNow>rLowPrev, hiddenBullDiv=pLowNow>pLowPrev&&rLowNow<rLowPrev;
  const bearDiv=pHighNow>pHighPrev&&rHighNow<rHighPrev, hiddenBearDiv=pHighNow<pHighPrev&&rHighNow>rHighPrev;
  const divBullSig=bullDiv||hiddenBullDiv, divBearSig=bearDiv||hiddenBearDiv;

  let buyScore=0;
  buyScore+=iqFlipBull?4:0; buyScore+=iqStrongBull?2:0;
  buyScore+=bullDiv?2:0; buyScore+=hiddenBullDiv?1:0;
  buyScore+=r<50?2:0; buyScore+=r<40?1:0;
  buyScore+=atLowerBB?2:0; buyScore+=crossMidUp?1:0; buyScore+=!bbSqueeze?1:0;
  buyScore-=iqBear?5:0; buyScore-=divBearSig?2:0; buyScore-=r>RSI_OB?4:0; buyScore-=atUpperBB?2:0;
  buyScore=Math.max(0,Math.min(10,buyScore));

  let sellScore=0;
  sellScore+=iqFlipBear?4:0; sellScore+=iqStrongBear?2:0;
  sellScore+=bearDiv?2:0; sellScore+=hiddenBearDiv?1:0;
  sellScore+=r>60?2:0; sellScore+=r>RSI_OB?1:0;
  sellScore+=atUpperBB?2:0; sellScore+=crossMidDn?1:0;
  sellScore-=iqBull?5:0; sellScore-=divBullSig?2:0; sellScore-=r<RSI_OS?4:0; sellScore-=atLowerBB?2:0;
  sellScore=Math.max(0,Math.min(10,sellScore));

  const utcH=now.getUTCHours(), utcM=now.getUTCMinutes();
  const beforeCutoff=(utcH*60+utcM)<18*60;

  const primaryBull=iqBull&&r<RSI_MAX_BUY&&buyScore>=MIN_SCORE;
  const primaryBear=iqBear&&sellScore>=MIN_SCORE;
  const fallbackBull=!primaryBull&&iqBull&&r<RSI_MAX_BUY&&buyScore>=MIN_SCORE_FALLBACK;
  const fallbackBear=!primaryBear&&iqBear&&sellScore>=MIN_SCORE_FALLBACK;

  const direction=primaryBull||fallbackBull?'CALL':primaryBear||fallbackBear?'PUT':null;
  const quality=primaryBull||primaryBear?'PRIMARY':'FALLBACK';
  const score=direction==='CALL'?buyScore:direction==='PUT'?sellScore:0;
  const iv=histVol(closes,i,BPY);
  const T=timeToExpiry(now);
  const strike=direction?Math.round(c*20)/20:null;
  const premium=direction==='CALL'?bsCall(c,strike,T,RISK_FREE,iv)*100:direction==='PUT'?bsPut(c,strike,T,RISK_FREE,iv)*100:null;

  // Check for exit signal on open position
  const exitSignal = position && (
    (position.type==='CALL'&&(primaryBear||fallbackBear)) ||
    (position.type==='PUT'&&(primaryBull||fallbackBull))
  );

  return { c, iv, r, iqBull, bullStreak:bullStreak[i], bearStreak:bearStreak[i],
           atLowerBB, atUpperBB, bbM, divBullSig, divBearSig,
           direction, quality, score, strike, premium, beforeCutoff, T, exitSignal, now };
}

// ── Signal check (runs on schedule + on demand) ───────────────────────────────
async function runSignalCheck() {
  console.log(`[${new Date().toISOString()}] Running signal check...`);
  let sig;
  try { sig = await computeSignal(); }
  catch(e) { console.error('Signal check failed:', e.message); return; }

  const timeStr = sig.now.toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'});
  const dateStr = sig.now.toLocaleDateString('en-US',{timeZone:'America/New_York',weekday:'short',month:'short',day:'numeric'});

  // Warn if open position has opposing signal
  if(sig.exitSignal){
    await sendTelegram([
      `⚠️ <b>EXIT SIGNAL on open position</b>`,
      `Your ${position.type} $${position.strike} has an opposing signal.`,
      `Reply <b>exit</b> to close it now.`,
    ].join('\n'));
  }

  if(!sig.direction){
    console.log(`No signal — buy:${sig.score} sell:${sig.score} — skipping Telegram`);
    return;
  }
  if(!sig.beforeCutoff){
    console.log(`Signal detected but past 2pm ET cutoff — skipping`);
    return;
  }
  if(position){
    console.log(`Signal detected but position already open — skipping entry alert`);
    return;
  }

  // Calculate sizing for default $600 account
  const acct = 600;
  const pct  = allocPct(acct);
  const cash = acct * pct;
  const qty  = Math.min(50, Math.max(1, Math.floor(cash / sig.premium)));
  const deployed = qty * sig.premium;

  const scaleLevels = qty < 5 ? [2, 5] : [1, 2, 3, 4, 5];
  const scaleLines = scaleLevels.map(l =>
    `  +${l*10}% → sell when premium hits $${(sig.premium*(1+l*0.10)).toFixed(2)}`
  ).join('\n');
  const scaleNote = qty < 5
    ? `Scale-out targets (sell 1 contract each):`
    : `Scale-out targets (10% each):`;

  await sendTelegram([
    `📊 <b>SPY 0DTE SIGNAL — ${dateStr} ${timeStr} ET</b>`,
    ``,
    `${sig.direction==='CALL'?'🟢':'🔴'} <b>${sig.direction} (${sig.quality}, score ${sig.score}/10)</b>`,
    `Strike: <b>$${sig.strike.toFixed(2)}</b>  |  IV: ${(sig.iv*100).toFixed(0)}%`,
    `Premium: ~<b>$${sig.premium.toFixed(2)}</b>/contract`,
    ``,
    `<b>Size ($${acct} account, ${(pct*100).toFixed(0)}% alloc):</b>`,
    `  → <b>${qty} contracts</b> = $${deployed.toFixed(2)} deployed`,
    ``,
    `<b>${scaleNote}</b>`,
    scaleLines,
    ``,
    `⏰ Expires 4pm ET`,
    `Reply <b>enter</b> once you place the trade`,
  ].join('\n'));

  console.log(`Signal sent: ${sig.direction} $${sig.strike} score ${sig.score}`);
}

// ── Telegram command handler ──────────────────────────────────────────────────
async function handleCommand(text) {
  const parts  = text.trim().toLowerCase().split(/\s+/);
  const cmd    = parts[0].replace('/','');
  const arg    = parts[1];

  if(cmd === 'help') {
    return sendTelegram([
      `<b>SPY 0DTE Bot Commands</b>`,
      ``,
      `<b>enter [amount]</b> — record entering the current signal trade`,
      `  e.g. enter 600`,
      ``,
      `<b>scale [1-5]</b> — record a scale-out`,
      `  e.g. scale 1  (at +10%)`,
      `  e.g. scale 2  (at +20%)`,
      ``,
      `<b>exit</b> — close open position, see P&amp;L`,
      ``,
      `<b>status</b> — current position value &amp; P&amp;L`,
      ``,
      `<b>signal</b> — check signal right now (on demand)`,
      ``,
      `<b>reset</b> — clear position (if you made a mistake)`,
    ].join('\n'));
  }

  if(cmd === 'signal') {
    await sendTelegram('🔍 Checking signal now...');
    return runSignalCheck();
  }

  if(cmd === 'enter') {
    if(position) return sendTelegram('⚠️ Already have an open position. Reply <b>exit</b> first, or <b>reset</b> to clear.');
    let sig;
    try { sig = await computeSignal(); }
    catch(e) { return sendTelegram(`❌ Could not fetch signal: ${e.message}`); }
    if(!sig.direction) return sendTelegram('⚠️ No active signal right now. Wait for a signal alert before entering.');
    if(!sig.beforeCutoff) return sendTelegram('⚠️ Past 2pm ET cutoff — too late for 0DTE entry today.');

    const acct   = parseFloat(arg) || 600;
    const pct    = allocPct(acct);
    const cash   = acct * pct;
    const qty    = Math.min(50, Math.max(1, Math.floor(cash / sig.premium)));
    const deployed = qty * sig.premium;

    position = {
      type: sig.direction, strike: sig.strike,
      entryTime: sig.now.toISOString(), entryPrice: sig.c,
      contracts: qty, deployed, accountSize: acct,
      premiumPerContract: sig.premium,
      scaledContracts: 0, scaleProceeds: 0, scales: [],
    };

    return sendTelegram([
      `✅ <b>PAPER TRADE RECORDED</b>`,
      `${sig.direction} $${sig.strike.toFixed(2)} — <b>${qty} contracts</b>`,
      `Deployed: $${deployed.toFixed(2)}  (${(pct*100).toFixed(0)}% of $${acct})`,
      `Premium: $${sig.premium.toFixed(2)}/contract`,
      ``,
      `Reply <b>scale 1</b> when up +10%, <b>scale 2</b> at +20%, etc.`,
      `Reply <b>status</b> anytime to see live P&amp;L`,
      `Reply <b>exit</b> to close`,
    ].join('\n'));
  }

  if(cmd === 'status') {
    if(!position) return sendTelegram('📭 No open position. Wait for a signal.');
    let sig;
    try { sig = await computeSignal(); }
    catch(e) { return sendTelegram(`❌ Could not fetch price: ${e.message}`); }

    const currentPremium = position.type==='CALL'
      ? bsCall(sig.c, position.strike, sig.T, RISK_FREE, sig.iv)
      : bsPut(sig.c, position.strike, sig.T, RISK_FREE, sig.iv);
    const remaining = position.contracts - position.scaledContracts;
    const currentValue = currentPremium * 100 * remaining;
    const totalValue = position.scaleProceeds + currentValue;
    const pnl = totalValue - position.deployed;
    const pnlPct = pnl / position.deployed * 100;
    const nextLevel = (position.scales?.length || 0) + 1;
    const nextTrigger = position.premiumPerContract/100 * (1 + nextLevel * 0.10);
    const pctMoved = ((currentPremium - position.premiumPerContract/100) / (position.premiumPerContract/100) * 100).toFixed(1);

    return sendTelegram([
      `📋 <b>POSITION STATUS</b>`,
      `${position.type} $${position.strike.toFixed(2)} — entered ${new Date(position.entryTime).toLocaleString('en-US',{timeZone:'America/New_York'})}`,
      ``,
      `SPY: $${sig.c.toFixed(2)}  |  Option: $${currentPremium.toFixed(4)}/share  (${pctMoved}%)`,
      `Remaining: ${remaining} contracts  |  Value: $${currentValue.toFixed(2)}`,
      position.scaledContracts>0 ? `Banked: $${position.scaleProceeds.toFixed(2)} (${position.scaledContracts} contracts)` : `No scale-outs yet`,
      ``,
      `${pnl>=0?'✅':'🔴'} <b>P&amp;L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}  (${pnlPct>=0?'+':''}${pnlPct.toFixed(1)}%)</b>`,
      nextLevel<=5 ? `Next scale: +${nextLevel*10}% → sell when option hits $${nextTrigger.toFixed(4)}/share` : `All 5 scales done — ride to expiry`,
    ].join('\n'));
  }

  if(cmd === 'scale') {
    if(!position) return sendTelegram('📭 No open position to scale.');
    const level = parseInt(arg) || ((position.scales?.length||0)+1);
    if(level<1||level>5) return sendTelegram('⚠️ Scale level must be 1–5. e.g. scale 1');

    let sig;
    try { sig = await computeSignal(); }
    catch(e) { return sendTelegram(`❌ Could not fetch price: ${e.message}`); }

    const currentPremium = position.type==='CALL'
      ? bsCall(sig.c, position.strike, sig.T, RISK_FREE, sig.iv)
      : bsPut(sig.c, position.strike, sig.T, RISK_FREE, sig.iv);
    const sellContracts = Math.min(
      position.contracts - position.scaledContracts,
      Math.max(1, Math.round(position.contracts * 0.10))
    );
    const proceeds = currentPremium * 100 * sellContracts;
    position.scaledContracts += sellContracts;
    position.scaleProceeds   += proceeds;
    position.scales = position.scales || [];
    position.scales.push({ level, time: sig.now.toISOString(), price: sig.c, premium: currentPremium, contracts: sellContracts, proceeds });

    return sendTelegram([
      `💰 <b>SCALE-OUT +${level*10}% RECORDED</b>`,
      `Sold ${sellContracts} contracts @ $${currentPremium.toFixed(4)}/share`,
      `Banked: $${proceeds.toFixed(2)}`,
      `Total banked: $${position.scaleProceeds.toFixed(2)}`,
      `Still open: ${position.contracts-position.scaledContracts} contracts`,
      level<5 ? `\nReply <b>scale ${level+1}</b> at +${(level+1)*10}%` : `\nAll 5 levels done — let remaining ride to expiry`,
    ].join('\n'));
  }

  if(cmd === 'exit') {
    if(!position) return sendTelegram('📭 No open position to exit.');
    let sig;
    try { sig = await computeSignal(); }
    catch(e) { return sendTelegram(`❌ Could not fetch price: ${e.message}`); }

    const currentPremium = position.type==='CALL'
      ? bsCall(sig.c, position.strike, sig.T, RISK_FREE, sig.iv)
      : bsPut(sig.c, position.strike, sig.T, RISK_FREE, sig.iv);
    const remaining = position.contracts - position.scaledContracts;
    const finalProceeds = currentPremium * 100 * remaining;
    const totalProceeds = position.scaleProceeds + finalProceeds;
    const pnl = totalProceeds - position.deployed;
    const pnlPct = pnl / position.deployed * 100;
    const newAcct = position.accountSize + pnl;

    const p = { ...position };
    position = null;

    return sendTelegram([
      pnl>=0 ? `✅ <b>TRADE CLOSED — WIN</b>` : `🔴 <b>TRADE CLOSED — LOSS</b>`,
      `${p.type} $${p.strike.toFixed(2)} — ${p.contracts} contracts`,
      ``,
      p.scaledContracts>0 ? `Banked early: $${p.scaleProceeds.toFixed(2)} (${p.scaledContracts} contracts)` : `No scale-outs`,
      `Final exit: $${finalProceeds.toFixed(2)} (${remaining} contracts @ $${currentPremium.toFixed(4)}/share)`,
      ``,
      `<b>P&amp;L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}  (${pnlPct>=0?'+':''}${pnlPct.toFixed(1)}%)</b>`,
      `New account: <b>$${newAcct.toFixed(2)}</b>`,
    ].join('\n'));
  }

  if(cmd === 'reset') {
    position = null;
    return sendTelegram('🗑 Position cleared.');
  }

  return sendTelegram(`Unknown command. Reply <b>help</b> for the full list.`);
}

// ── Express server ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Telegram webhook
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // respond immediately so Telegram doesn't retry
  const msg = req.body?.message;
  if (!msg) return;
  if (String(msg.chat.id) !== String(CHAT_ID)) return; // only respond to your chat
  const text = msg.text;
  if (!text) return;
  try { await handleCommand(text); }
  catch(e) { console.error('Command error:', e.message); }
});

// Health check
app.get('/', (req, res) => res.send('SPY Signal Bot running ✓'));

// One-time webhook registration endpoint
app.get('/set-webhook', async (req, res) => {
  const host = req.get('host');
  const url = `https://${host}/webhook`;
  const result = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${url}`).then(r=>r.json());
  res.json(result);
});

app.listen(PORT, () => console.log(`Bot server running on port ${PORT}`));

// ── Morning Brief ─────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'Mozilla/5.0' } };
    https.get(url, opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function runMorningBrief() {
  try {
    console.log('Running morning brief...');

    // Fetch small cap gainers and most actives from Yahoo Finance screener
    const [gainersRes, activesRes] = await Promise.all([
      fetchJSON('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=small_cap_gainers&start=0&count=50'),
      fetchJSON('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=most_actives&start=0&count=50'),
    ]);

    const gainers = gainersRes?.finance?.result?.[0]?.quotes || [];
    const actives = activesRes?.finance?.result?.[0]?.quotes || [];

    // Combine, deduplicate, filter under $15, sort by % gain
    const seen = new Set();
    const candidates = [...gainers, ...actives]
      .filter(q => {
        if (seen.has(q.symbol)) return false;
        seen.add(q.symbol);
        const p = q.regularMarketPrice;
        return p && p > 0.10 && p < 15;
      })
      .sort((a, b) => (b.regularMarketChangePercent || 0) - (a.regularMarketChangePercent || 0))
      .slice(0, 5);

    if (candidates.length === 0) {
      await sendTelegram('🌅 Morning Brief: No strong runners under $15 found today.');
      return;
    }

    // Fetch latest news headline for each ticker
    const withNews = await Promise.all(candidates.map(async q => {
      try {
        const r = await fetchJSON(`https://query1.finance.yahoo.com/v1/finance/search?q=${q.symbol}&newsCount=1&enableFuzzyQuery=false`);
        return { ...q, headline: r?.news?.[0]?.title || 'No recent news' };
      } catch { return { ...q, headline: 'No recent news' }; }
    }));

    // Build Telegram message
    const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'];
    const dateStr = new Date().toLocaleDateString('en-US', {
      weekday:'long', month:'long', day:'numeric', year:'numeric', timeZone:'America/New_York'
    });

    const lines = [
      `🌅 MORNING BRIEF — ${dateStr}`,
      ``,
      `📋 TOP 5 RUNNERS UNDER $15`,
      `Squeeze Potential + News Catalyst`,
      ``,
    ];

    withNews.forEach((q, i) => {
      const price  = q.regularMarketPrice?.toFixed(2) || '?';
      const pct    = (q.regularMarketChangePercent || 0).toFixed(1);
      const vol    = q.regularMarketVolume >= 1e6
        ? (q.regularMarketVolume / 1e6).toFixed(1) + 'M'
        : q.regularMarketVolume >= 1e3
          ? (q.regularMarketVolume / 1e3).toFixed(0) + 'K' : (q.regularMarketVolume || 0).toString();
      const mcap   = q.marketCap ? '$' + (q.marketCap / 1e6).toFixed(0) + 'M mkt cap' : 'micro-cap';
      const tag    = parseFloat(pct) >= 20 ? '🔥 Squeeze Pick' : '⚡ Squeeze Watch';
      const name   = q.shortName || q.longName || q.symbol;

      lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`${emojis[i]} ${q.symbol} — ${name}`);
      lines.push(`💲 ~$${price}  |  ${tag}`);
      lines.push(``);
      lines.push(`📰 ${q.headline}`);
      lines.push(`📈 +${pct}% today  |  Vol: ${vol}`);
      lines.push(`⚡ ${mcap} — small float = big move potential`);
      lines.push(`⚠️ High volatility — confirm volume before entry`);
      lines.push(``);
    });

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`📌 RULES FOR THESE PLAYS:`);
    lines.push(`• Watch first 15–30 min for direction`);
    lines.push(`• Only enter if volume confirms move`);
    lines.push(`• Set a hard stop — these move FAST both ways`);
    lines.push(`• Never risk more than you can afford to lose 100%`);
    lines.push(``);
    lines.push(`🕙 Market opens 9:30am ET`);
    lines.push(`Good luck today! 🚀`);

    await sendTelegram(lines.join('\n'));
    console.log('Morning brief sent.');
  } catch(e) {
    console.error('Morning brief error:', e.message);
    await sendTelegram(`⚠️ Morning brief error: ${e.message}`);
  }
}

// ── Scheduled signal checks ───────────────────────────────────────────────────
// 9:30am ET = 13:30 UTC (EDT), then every 30min until 1:30pm ET = 17:30 UTC
// Cron: at :30 of hour 13, then :00 and :30 of hours 14-17, Mon-Fri

cron.schedule('30 13 * * 1-5', runSignalCheck, { timezone: 'UTC' }); // 9:30am ET
cron.schedule('0,30 14-17 * * 1-5', runSignalCheck, { timezone: 'UTC' }); // 10am-1:30pm ET

// ── Morning Brief schedule ────────────────────────────────────────────────────
// 8:00am ET = 12:00 UTC (EDT, UTC-4)
// 8:30am ET = 12:30 UTC
cron.schedule('0 12 * * 1-5',  runMorningBrief, { timezone: 'UTC' }); // 8:00am ET
cron.schedule('30 12 * * 1-5', runMorningBrief, { timezone: 'UTC' }); // 8:30am ET

console.log('Scheduler started — signal checks: 9:30am–1:30pm ET | morning brief: 8am & 8:30am ET, Mon–Fri');
