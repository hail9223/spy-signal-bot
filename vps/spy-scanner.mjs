/**
 * SPY 0DTE Signal Scanner
 * Runs every 30 min during market hours, sends Telegram alert if signal fires
 */

import https from 'https';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text });
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body
  }).catch(() => {});
}

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

function isMarketHours(now) {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 14 * 60 && mins < 17 * 60; // 10am-1pm ET (UTC-4)
}

function isBefore1pmET(now) {
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins < 17 * 60; // 1pm ET = 17:00 UTC
}

function is3pmExitWindow(now) {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  // 3pm ET = 19:00 UTC; fire between 19:00-19:05 to catch the cron tick
  return mins >= 19 * 60 && mins < 19 * 60 + 5;
}

function timeToExpiry(now) {
  const expiry = new Date(now);
  expiry.setUTCHours(20, 0, 0, 0);
  if (expiry.getTime() <= now.getTime()) expiry.setUTCDate(expiry.getUTCDate() + 1);
  return Math.max((expiry.getTime() - now.getTime()) / (365 * 24 * 60 * 60 * 1000), 1 / (365 * 24 * 60));
}

function erf(x){const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;const sign=x<0?-1:1;x=Math.abs(x);const t=1/(1+p*x);return sign*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x));}
function normCDF(x){return 0.5*(1+erf(x/Math.sqrt(2)));}
function bsCall(S,K,T,r,v){if(T<=0)return Math.max(S-K,0);const d1=(Math.log(S/K)+(r+0.5*v*v)*T)/(v*Math.sqrt(T)),d2=d1-v*Math.sqrt(T);return S*normCDF(d1)-K*Math.exp(-r*T)*normCDF(d2);}
function bsPut(S,K,T,r,v){if(T<=0)return Math.max(K-S,0);const d1=(Math.log(S/K)+(r+0.5*v*v)*T)/(v*Math.sqrt(T)),d2=d1-v*Math.sqrt(T);return K*Math.exp(-r*T)*normCDF(-d2)-S*normCDF(-d1);}
function histVol(closes,i,bpy){const n=Math.max(2,Math.round(bpy/252));if(i<n+1)return 0.20;let s=0;for(let j=i-n;j<i;j++){const r=Math.log(closes[j+1]/closes[j]);s+=r*r;}return Math.sqrt((s/n)*bpy);}
function allocPct(equity){if(equity<2000)return 0.50;if(equity<4000)return 0.40;if(equity<10000)return 0.25;if(equity<20000)return 0.10;return 0.08;}
const MAX_DEPLOY=4000; // 8% of $50k account cap
function getCash(equity, score){
  // High-conviction override: score 9+ at max tier -> 10% or $6k, whichever is lower
  if(equity>=20000 && score>=9) return Math.min(equity*0.10, 6000);
  return Math.min(equity*allocPct(equity), MAX_DEPLOY);
}

const IQ_FAST=9,IQ_SLOW=21,IQ_CONFIRM=3,DIV_RSI_LEN=14,DIV_LB=5;
const RSI_LEN=14,RSI_OB=70,RSI_OS=30,RSI_MAX_BUY=70;
const BB_LEN=20,BB_MULT=2.0,MIN_SCORE=6,MIN_SCORE_FALLBACK=4;
const BPY=Math.round(13*252),RISK_FREE=0.053;

// ── Markov 2.0 (stride-sampled, 20-day window) ───────────────────────────────
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
    return { regime: cur, pBull: mat[cur]['BULL'], pBear: mat[cur]['BEAR'] };
  } catch {
    return { regime: 'SIDEWAYS', pBull: 0.33, pBear: 0.33 };
  }
}

(async () => {
  const now = new Date();

  // 3pm ET exit reminder — fires before signal scan check
  if (is3pmExitWindow(now)) {
    await sendTelegram(
      '⏰ 3PM ET EXIT REMINDER\n\nClose your SPY 0DTE position NOW.\nDo not hold past 3pm — strategy exits here.'
    );
    console.log('3pm exit reminder sent');
    process.exit(0);
  }

  if (!isMarketHours(now)) {
    console.log('Outside market hours — skipping');
    process.exit(0);
  }

  const [candles, markov] = await Promise.all([
    fetchCandles('SPY', '5d', '30m'),
    getMarkovRegime(),
  ]);
  const closes = candles.map(c => c.close);
  const n = closes.length;

  const emaFast=calcEMA(closes,IQ_FAST),emaSlow=calcEMA(closes,IQ_SLOW);
  const rsi=calcRSI(closes,RSI_LEN),divRsi=calcRSI(closes,DIV_RSI_LEN);
  const {mid:bbMid,upper:bbUpper,lower:bbLower}=calcBB(closes,BB_LEN,BB_MULT);

  const bullStreak=new Array(n).fill(0),bearStreak=new Array(n).fill(0);
  for(let i=0;i<n;i++){const bull=emaFast[i]>emaSlow[i];if(i===0){bullStreak[i]=bull?1:0;bearStreak[i]=bull?0:1;}else{bullStreak[i]=bull?bullStreak[i-1]+1:0;bearStreak[i]=bull?0:bearStreak[i-1]+1;}}

  const i=n-1,c=closes[i];
  const iqBull=emaFast[i]>emaSlow[i],iqBear=!iqBull;
  const iqFlipBull=iqBull&&emaFast[i-1]<=emaSlow[i-1];
  const iqFlipBear=iqBear&&emaFast[i-1]>=emaSlow[i-1];
  const iqStrongBull=bullStreak[i]>=IQ_CONFIRM,iqStrongBear=bearStreak[i]>=IQ_CONFIRM;
  const r=rsi[i];
  const bbU=bbUpper[i],bbM=bbMid[i],bbL=bbLower[i];
  const atLowerBB=c<=bbL*1.01,atUpperBB=c>=bbU*0.99;
  const bbWidth=bbU-bbL,bbWidthPrev=!isNaN(bbUpper[i-20])?bbUpper[i-20]-bbLower[i-20]:bbWidth;
  const bbSqueeze=bbWidth<bbWidthPrev*0.85;
  const crossMidUp=closes[i-1]<bbMid[i-1]&&c>=bbM;
  const crossMidDn=closes[i-1]>bbMid[i-1]&&c<=bbM;
  const pLowNow=lowestN(closes,i,DIV_LB),pLowPrev=lowestN(closes,i-DIV_LB,DIV_LB);
  const rLowNow=lowestN(divRsi,i,DIV_LB),rLowPrev=lowestN(divRsi,i-DIV_LB,DIV_LB);
  const pHighNow=highestN(closes,i,DIV_LB),pHighPrev=highestN(closes,i-DIV_LB,DIV_LB);
  const rHighNow=highestN(divRsi,i,DIV_LB),rHighPrev=highestN(divRsi,i-DIV_LB,DIV_LB);
  const bullDiv=pLowNow<pLowPrev&&rLowNow>rLowPrev,hiddenBullDiv=pLowNow>pLowPrev&&rLowNow<rLowPrev;
  const bearDiv=pHighNow>pHighPrev&&rHighNow<rHighPrev,hiddenBearDiv=pHighNow<pHighPrev&&rHighNow>rHighPrev;
  const divBullSig=bullDiv||hiddenBullDiv,divBearSig=bearDiv||hiddenBearDiv;

  let buyScore=0;
  buyScore+=iqFlipBull?4:0;buyScore+=iqStrongBull?2:0;buyScore+=bullDiv?2:0;buyScore+=hiddenBullDiv?1:0;
  buyScore+=r<50?2:0;buyScore+=r<40?1:0;buyScore+=atLowerBB?2:0;buyScore+=crossMidUp?1:0;buyScore+=!bbSqueeze?1:0;
  buyScore-=iqBear?5:0;buyScore-=divBearSig?2:0;buyScore-=r>RSI_OB?4:0;buyScore-=atUpperBB?2:0;
  buyScore=Math.max(0,Math.min(10,buyScore));
  const markovBuyPts = markov.regime==='BULL' ? 10 : markov.regime==='BEAR' ? 0 : 5;

  let sellScore=0;
  sellScore+=iqFlipBear?4:0;sellScore+=iqStrongBear?2:0;sellScore+=bearDiv?2:0;sellScore+=hiddenBearDiv?1:0;
  sellScore+=r>60?2:0;sellScore+=r>RSI_OB?1:0;sellScore+=atUpperBB?2:0;sellScore+=crossMidDn?1:0;
  sellScore-=iqBull?5:0;sellScore-=divBullSig?2:0;sellScore-=r<RSI_OS?4:0;sellScore-=atLowerBB?2:0;
  sellScore=Math.max(0,Math.min(10,sellScore));
  const markovSellPts = markov.regime==='BEAR' ? 10 : markov.regime==='BULL' ? 0 : 5;

  // Blend: 80% indicators + 20% Markov 2.0
  buyScore  = Math.round(buyScore  * 0.8 + markovBuyPts  * 0.2);
  sellScore = Math.round(sellScore * 0.8 + markovSellPts * 0.2);

  const primaryBull=iqBull&&r<RSI_MAX_BUY&&buyScore>=MIN_SCORE;
  const primaryBear=iqBear&&sellScore>=MIN_SCORE;
  const fallbackBull=iqBull&&r<RSI_MAX_BUY&&buyScore>=MIN_SCORE_FALLBACK&&!primaryBull;
  const fallbackBear=iqBear&&sellScore>=MIN_SCORE_FALLBACK&&!primaryBear;

  const signalType=primaryBull?'CALL PRIMARY':fallbackBull?'CALL FALLBACK':primaryBear?'PUT PRIMARY':fallbackBear?'PUT FALLBACK':'NONE';
  const direction=signalType.startsWith('CALL')?'CALL':signalType.startsWith('PUT')?'PUT':null;
  const score=direction==='CALL'?buyScore:direction==='PUT'?sellScore:0;

  if (!direction) {
    console.log(`No signal — buy:${buyScore} sell:${sellScore}`);
    process.exit(0);
  }

  if (!isBefore1pmET(now)) {
    console.log('Signal detected but past 1pm ET cutoff');
    process.exit(0);
  }

  const iv=histVol(closes,i,BPY),T=timeToExpiry(now);
  const strike=Math.round(c*20)/20;
  const premium=direction==='CALL'?bsCall(c,strike,T,RISK_FREE,iv)*100:bsPut(c,strike,T,RISK_FREE,iv)*100;
  const acct=600,pct=allocPct(acct),cash=getCash(acct,score);
  const qty=Math.min(50,Math.max(1,Math.floor(cash/premium)));
  const deployed=qty*premium;
  const quality=signalType.includes('PRIMARY')?'PRIMARY':'FALLBACK';

  const timeStr=now.toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'});
  const dateStr=now.toLocaleDateString('en-US',{timeZone:'America/New_York',weekday:'short',month:'short',day:'numeric'});

  const smallSize = qty < 10;
  const q25 = Math.max(1, Math.round(qty*0.25));
  const scaleTargets = smallSize
    ? [
        { pct: 20, qty: q25, label: 'Sell 25%' },
        { pct: 50, qty: q25, label: 'Sell 25% — ride rest to 3pm' },
      ]
    : [
        { pct: 10, qty: Math.round(qty*0.25), label: 'Sell 25%' },
        { pct: 20, qty: Math.round(qty*0.25), label: 'Sell 25%' },
        { pct: 30, qty: Math.round(qty*0.25), label: 'Sell 25%' },
        { pct: 50, qty: Math.round(qty*0.25), label: 'Sell 25% — ride rest to 3pm' },
      ];
  const scaleLines = scaleTargets.map(t =>
    `  +${t.pct}% -> $${(premium*(1+t.pct/100)).toFixed(2)}/contract — ${t.label} (${t.qty} contracts)`
  ).join('\n');

  const msg=[
    `SPY 0DTE SIGNAL - ${dateStr} ${timeStr} ET`,
    ``,
    `${direction} ${quality}  (score ${score}/10)`,
    `Strike: $${strike.toFixed(2)}  |  IV: ${(iv*100).toFixed(0)}%  |  Markov: ${markov.regime}`,
    `Premium: ~$${premium.toFixed(2)}/contract`,
    ``,
    `Your trade ($${acct} account):`,
    `  ${(pct*100).toFixed(0)}% alloc -> ${qty} contracts @ $${premium.toFixed(2)} = $${deployed.toFixed(2)}`,
    ``,
    `Scale-out targets:`,
    scaleLines,
    ``,
    `Enter 10am-1pm ET | EXIT BY 3pm ET (do not hold to expiry)`,
  ].join('\n');

  await sendTelegram(msg);
  console.log('Signal sent to Telegram');

  // Monitor premium and send scale-out alerts
  const targets = smallSize
    ? [{ pct: 20, qty: q25, label: 'SELL 25%', fired: false },
       { pct: 50, qty: q25, label: 'SELL 25% — ride rest to 3pm', fired: false }]
    : [{ pct: 10, qty: Math.round(qty*0.25), label: 'SELL 25%', fired: false },
       { pct: 20, qty: Math.round(qty*0.25), label: 'SELL 25%', fired: false },
       { pct: 30, qty: Math.round(qty*0.25), label: 'SELL 25%', fired: false },
       { pct: 50, qty: Math.round(qty*0.25), label: 'SELL 25% — ride rest to 3pm', fired: false }];

  const entryPremium = premium;
  let allFired = false;

  const monitor = setInterval(async () => {
    const nowCheck = new Date();
    const minsUTC = nowCheck.getUTCHours()*60 + nowCheck.getUTCMinutes();
    // Stop at 3pm ET (19:00 UTC)
    if (minsUTC >= 19*60 || allFired) { clearInterval(monitor); return; }

    try {
      const latest = await fetchCandles('SPY', '1d', '1m');
      if (!latest.length) return;
      const curPrice = latest[latest.length-1].close;
      const T2 = timeToExpiry(nowCheck);
      const iv2 = histVol(closes, i, BPY);
      const curPremium = direction==='CALL'
        ? bsCall(curPrice, strike, T2, RISK_FREE, iv2)*100
        : bsPut(curPrice, strike, T2, RISK_FREE, iv2)*100;
      const gain = (curPremium - entryPremium) / entryPremium * 100;

      for (const t of targets) {
        if (!t.fired && gain >= t.pct) {
          t.fired = true;
          const alertTime = nowCheck.toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'});
          await sendTelegram(
            `SCALE OUT ALERT - ${alertTime} ET\n\n${t.label} — ${t.qty} contracts\nPremium: ~$${curPremium.toFixed(2)} (+${gain.toFixed(0)}%)\n\nOriginal entry: $${entryPremium.toFixed(2)}`
          );
        }
      }
      if (targets.every(t => t.fired)) { allFired = true; clearInterval(monitor); }
    } catch(e) { /* silent fail */ }
  }, 3 * 60 * 1000); // check every 3 minutes
})();
