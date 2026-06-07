// Options Backtest — SPY 30m 0DTE
import https from 'https';

// ── fetch ─────────────────────────────────────────────────────────────────────

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
          const ts = result.timestamp;
          const q  = result.indicators.quote[0];
          resolve(ts.map((t, i) => ({
            time:  t * 1000,
            open:  q.open[i],
            high:  q.high[i],
            low:   q.low[i],
            close: q.close[i],
          })).filter(c => c.close != null && !isNaN(c.close)));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── Black-Scholes ─────────────────────────────────────────────────────────────

function erf(x) {
  const a1= 0.254829592, a2=-0.284496736, a3= 1.421413741,
        a4=-1.453152027, a5= 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign * y;
}

function normCDF(x) { return 0.5 * (1 + erf(x / Math.sqrt(2))); }

function bsCall(S, K, T, r, v) {
  if (T <= 0) return Math.max(S - K, 0);
  const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * Math.sqrt(T));
  const d2 = d1 - v * Math.sqrt(T);
  return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
}

function bsPut(S, K, T, r, v) {
  if (T <= 0) return Math.max(K - S, 0);
  const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * Math.sqrt(T));
  const d2 = d1 - v * Math.sqrt(T);
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

function historicalVol(closes, i, barsPerYear, n) {
  n = n || Math.round(barsPerYear / 252);
  if (i < n + 1) return 0.20;
  let sumSq = 0;
  for (let j = i - n; j < i; j++) {
    const r = Math.log(closes[j + 1] / closes[j]);
    sumSq += r * r;
  }
  return Math.sqrt((sumSq / n) * barsPerYear);
}

// ── Strategy params ───────────────────────────────────────────────────────────

const IQ_FAST=9, IQ_SLOW=21, IQ_CONFIRM=3;
const DIV_RSI_LEN=14, DIV_LB=5;
const RSI_LEN=14, RSI_OB=70, RSI_OS=30, RSI_MAX_BUY=70;
const BB_LEN=20, BB_MULT=2.0;
const MIN_SCORE=6;          // primary signal quality threshold
const MIN_SCORE_FALLBACK=4; // used when no trade has fired yet today (before cutoff)
const ENTRY_CUTOFF_UTC=18;  // no new 0DTE entries at or after 2pm ET (18:00 UTC)
const START_CAP=600;
const RISK_FREE=0.053;

const DTE          = parseInt(process.argv[5] ?? '0', 10);
const EXIT_EOD     = (process.argv[6] || '').toLowerCase() === 'eod';
const STOP_LOSS_PCT= parseFloat(process.argv[7] ?? '0');
const OTM_OFFSET   = parseFloat(process.argv[8] ?? '0');

function allocPct(equity) {
  if (equity <  2000) return 0.50;  // up to $2k   → 50%
  if (equity <  4000) return 0.60;  // $2k–$4k     → 60%
  if (equity < 10000) return 0.25;  // $4k–$10k    → 25%
  return 0.10;                      // $10k+        → 10%
}

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const r = new Array(closes.length).fill(NaN);
  let ema = closes[0]; r[0] = ema;
  for (let i = 1; i < closes.length; i++) { ema = closes[i]*k + ema*(1-k); r[i]=ema; }
  return r;
}

function calcRSI(closes, period) {
  const r = new Array(closes.length).fill(NaN);
  let ag=0, al=0;
  for (let i=1;i<=period;i++){const d=closes[i]-closes[i-1];if(d>0)ag+=d;else al-=d;}
  ag/=period;al/=period;
  r[period]=al===0?100:100-100/(1+ag/al);
  for(let i=period+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    ag=(ag*(period-1)+(d>0?d:0))/period;
    al=(al*(period-1)+(d<0?-d:0))/period;
    r[i]=al===0?100:100-100/(1+ag/al);
  }
  return r;
}

function calcBB(closes,period,mult){
  const mid=new Array(closes.length).fill(NaN);
  const upper=new Array(closes.length).fill(NaN);
  const lower=new Array(closes.length).fill(NaN);
  for(let i=period-1;i<closes.length;i++){
    const s=closes.slice(i-period+1,i+1);
    const mean=s.reduce((a,b)=>a+b,0)/period;
    const std=Math.sqrt(s.reduce((a,b)=>a+(b-mean)**2,0)/period);
    mid[i]=mean;upper[i]=mean+mult*std;lower[i]=mean-mult*std;
  }
  return {mid,upper,lower};
}

function lowestN(arr,i,n){let lo=Infinity;for(let j=Math.max(0,i-n+1);j<=i;j++)if(!isNaN(arr[j]))lo=Math.min(lo,arr[j]);return lo;}
function highestN(arr,i,n){let hi=-Infinity;for(let j=Math.max(0,i-n+1);j<=i;j++)if(!isNaN(arr[j]))hi=Math.max(hi,arr[j]);return hi;}

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
  const ticker   = (process.argv[2] || 'SPY').toUpperCase();
  const range    = process.argv[3] || '60d';
  const interval = process.argv[4] || '30m';
  const days     = range.replace('d','');
  process.stdout.write(`Fetching ${days} days of ${ticker} ${interval} candles from Yahoo Finance...\n`);
  const candles = await fetchCandlesYahoo(ticker, range, interval);
  console.log(` ${candles.length} candles loaded.\n`);

  const closes = candles.map(c => c.close);
  const n      = candles.length;

  const emaFast = calcEMA(closes, IQ_FAST);
  const emaSlow = calcEMA(closes, IQ_SLOW);
  const rsi     = calcRSI(closes, RSI_LEN);
  const divRsi  = calcRSI(closes, DIV_RSI_LEN);
  const {mid:bbMid,upper:bbUpper,lower:bbLower} = calcBB(closes,BB_LEN,BB_MULT);

  const bullStreak=new Array(n).fill(0), bearStreak=new Array(n).fill(0);
  for(let i=0;i<n;i++){
    const bull=emaFast[i]>emaSlow[i];
    if(i===0){bullStreak[i]=bull?1:0;bearStreak[i]=bull?0:1;}
    else{bullStreak[i]=bull?bullStreak[i-1]+1:0;bearStreak[i]=bull?0:bearStreak[i-1]+1;}
  }

  const barsPerDay = interval==='1m'?390:interval==='2m'?195:interval==='5m'?78:interval==='15m'?26:interval==='30m'?13:interval==='60m'||interval==='1h'?6.5:1;
  const barsPerYear = Math.round(barsPerDay * 252);

  const WARMUP=Math.max(IQ_SLOW,RSI_LEN,BB_LEN,DIV_RSI_LEN)+DIV_LB*2+5;

  // ── equity sim (baseline) ────────────────────────────────────────────────
  let eqCash=START_CAP, eqShares=0, eqEntry=0, eqDeployed=0;
  let eqTrailStop=0, eqTrailActive=false;
  const eqTrades=[];
  let eqCurrent=null;
  const TRAIL_ACT=5.0, TRAIL_PCT=3.0;

  for(let i=WARMUP;i<n;i++){
    const c=closes[i], ts=candles[i].time;
    const iqBull=emaFast[i]>emaSlow[i], iqBear=!iqBull;
    const iqFlipBull=iqBull&&emaFast[i-1]<=emaSlow[i-1];
    const iqStrongBull=bullStreak[i]>=IQ_CONFIRM;
    const iqStrongBear=bearStreak[i]>=IQ_CONFIRM;
    const r=rsi[i]; if(isNaN(r))continue;
    const bbU=bbUpper[i],bbM=bbMid[i],bbL=bbLower[i]; if(isNaN(bbU))continue;
    const atLowerBB=c<=bbL*1.01, atUpperBB=c>=bbU*0.99;
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
    const divBullSig=bullDiv||hiddenBullDiv, divBearSig=bearDiv||hiddenBearDiv;
    let buyScore=0;
    buyScore+=iqFlipBull?4:0; buyScore+=iqStrongBull?2:0;
    buyScore+=bullDiv?2:0; buyScore+=hiddenBullDiv?1:0;
    buyScore+=r<50?2:0; buyScore+=r<40?1:0;
    buyScore+=atLowerBB?2:0; buyScore+=crossMidUp?1:0; buyScore+=!bbSqueeze?1:0;
    buyScore-=iqBear?5:0; buyScore-=divBearSig?2:0;
    buyScore-=r>RSI_OB?4:0; buyScore-=atUpperBB?2:0;
    buyScore=Math.max(0,Math.min(10,buyScore));
    let sellScore=0;
    const iqFlipBear=iqBear&&emaFast[i-1]>=emaSlow[i-1];
    sellScore+=iqFlipBear?4:0; sellScore+=iqStrongBear?2:0;
    sellScore+=bearDiv?2:0; sellScore+=hiddenBearDiv?1:0;
    sellScore+=r>60?2:0; sellScore+=r>RSI_OB?1:0;
    sellScore+=atUpperBB?2:0; sellScore+=crossMidDn?1:0;
    sellScore-=iqBull?5:0; sellScore-=divBullSig?2:0;
    sellScore-=r<RSI_OS?4:0; sellScore-=atLowerBB?2:0;
    sellScore=Math.max(0,Math.min(10,sellScore));
    const longCond=iqBull&&r<RSI_MAX_BUY&&buyScore>=MIN_SCORE;
    const shortCond=iqBear&&sellScore>=MIN_SCORE;

    const eqInPos=eqShares>0;
    if(longCond&&!eqInPos){
      const pct=allocPct(eqCash);
      eqDeployed=eqCash*pct; eqShares=eqDeployed/c; eqCash-=eqDeployed;
      eqEntry=c; eqTrailStop=0; eqTrailActive=false;
      eqCurrent={entryTime:new Date(ts).toISOString(),entryPrice:c,score:buyScore,allocPct:pct,deployed:eqDeployed,type:'LONG'};
    }
    if(eqInPos){
      const prof=(c-eqEntry)/eqEntry*100;
      if(prof>=TRAIL_ACT&&!eqTrailActive){eqTrailActive=true;eqTrailStop=eqEntry;}
      if(eqTrailActive){eqTrailStop=Math.max(eqTrailStop,c*(1-TRAIL_PCT/100));}
      const closeEq=(exitPrice,reason)=>{
        const proceeds=eqShares*exitPrice;
        const pnlPct=(exitPrice-eqCurrent.entryPrice)/eqCurrent.entryPrice*100;
        eqCash+=proceeds;
        eqTrades.push({...eqCurrent,exitTime:new Date(ts).toISOString(),exitPrice,exitReason:reason,pnlPct,pnlDollar:proceeds-eqDeployed,won:pnlPct>0});
        eqShares=0;eqTrailActive=false;eqTrailStop=0;eqDeployed=0;eqCurrent=null;
      };
      if(eqTrailActive&&c<=eqTrailStop){closeEq(eqTrailStop,'Trail Stop');continue;}
      if(shortCond){closeEq(c,'IQ Bear Exit');}
    }
  }
  if(eqShares>0&&eqCurrent){
    const lastC=closes[n-1];
    eqCash+=eqShares*lastC;
    eqTrades.push({...eqCurrent,exitTime:new Date(candles[n-1].time).toISOString(),exitPrice:lastC,exitReason:'Open (last bar)',pnlPct:(lastC-eqCurrent.entryPrice)/eqCurrent.entryPrice*100,pnlDollar:eqShares*lastC-eqDeployed,won:lastC>eqCurrent.entryPrice});
  }

  // ── options sim (called twice, once per scale mode) ───────────────────────
  //   scaleMode = 'half'        → sell 50% of position once at +10%
  //   scaleMode = 'incremental' → sell 10% of original position at each
  //                               +10% gain level up to +50% (5 triggers)
  function runOpSim(scaleMode) {
    let opCash=START_CAP;
    let opContracts=0, opOrigContracts=0, opStrike=0, opExpiry=0, opDeployed=0, opType='';
    let opScaleLevel=0, opScaleProceeds=0;
    const opTrades=[];
    let opCurrent=null;
    let lastTradeDateStr='';

    const reset = () => {
      opContracts=0; opOrigContracts=0; opDeployed=0; opType='';
      opScaleLevel=0; opScaleProceeds=0; opCurrent=null;
    };

    for(let i=WARMUP;i<n;i++){
      const c=closes[i], ts=candles[i].time;

      // signals
      const iqBull=emaFast[i]>emaSlow[i], iqBear=!iqBull;
      const iqFlipBull=iqBull&&emaFast[i-1]<=emaSlow[i-1];
      const iqFlipBear=iqBear&&emaFast[i-1]>=emaSlow[i-1];
      const iqStrongBull=bullStreak[i]>=IQ_CONFIRM;
      const iqStrongBear=bearStreak[i]>=IQ_CONFIRM;
      const r=rsi[i]; if(isNaN(r))continue;
      const bbU=bbUpper[i],bbM=bbMid[i],bbL=bbLower[i]; if(isNaN(bbU))continue;
      const atLowerBB=c<=bbL*1.01, atUpperBB=c>=bbU*0.99;
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
      const divBullSig=bullDiv||hiddenBullDiv, divBearSig=bearDiv||hiddenBearDiv;
      let buyScore=0;
      buyScore+=iqFlipBull?4:0; buyScore+=iqStrongBull?2:0;
      buyScore+=bullDiv?2:0; buyScore+=hiddenBullDiv?1:0;
      buyScore+=r<50?2:0; buyScore+=r<40?1:0;
      buyScore+=atLowerBB?2:0; buyScore+=crossMidUp?1:0; buyScore+=!bbSqueeze?1:0;
      buyScore-=iqBear?5:0; buyScore-=divBearSig?2:0;
      buyScore-=r>RSI_OB?4:0; buyScore-=atUpperBB?2:0;
      buyScore=Math.max(0,Math.min(10,buyScore));
      let sellScore=0;
      sellScore+=iqFlipBear?4:0; sellScore+=iqStrongBear?2:0;
      sellScore+=bearDiv?2:0; sellScore+=hiddenBearDiv?1:0;
      sellScore+=r>60?2:0; sellScore+=r>RSI_OB?1:0;
      sellScore+=atUpperBB?2:0; sellScore+=crossMidDn?1:0;
      sellScore-=iqBull?5:0; sellScore-=divBullSig?2:0;
      sellScore-=r<RSI_OS?4:0; sellScore-=atLowerBB?2:0;
      sellScore=Math.max(0,Math.min(10,sellScore));

      // dynamic threshold: use fallback score on days with no trade yet, before 2pm ET
      const barDateStr=new Date(ts).toISOString().slice(0,10);
      const barHourUTC=new Date(ts).getUTCHours();
      const noTradeToday=lastTradeDateStr!==barDateStr;
      const beforeCutoff=barHourUTC<ENTRY_CUTOFF_UTC;
      const threshold=(noTradeToday&&beforeCutoff)?MIN_SCORE_FALLBACK:MIN_SCORE;

      const longCond=iqBull&&r<RSI_MAX_BUY&&buyScore>=threshold;
      const shortCond=iqBear&&sellScore>=threshold;

      const opInPos=opContracts>0;
      const iv=historicalVol(closes,i,barsPerYear);

      // 4pm ET same-day hard exit
      if(opInPos&&EXIT_EOD){
        const eodClose=new Date(opCurrent.entryTime);
        eodClose.setUTCHours(20,0,0,0);
        if(ts>=eodClose.getTime()){
          const T2=Math.max((opExpiry-ts)/(365*24*60*60*1000),0.0001);
          const eodPremium=opType==='CALL'?bsCall(c,opStrike,T2,RISK_FREE,iv):bsPut(c,opStrike,T2,RISK_FREE,iv);
          const proceeds=eodPremium*100*opContracts;
          const totalProceeds=opScaleProceeds+proceeds;
          const pnlDollar=totalProceeds-opDeployed;
          opCash+=proceeds;
          opTrades.push({...opCurrent,exitTime:new Date(ts).toISOString(),exitPrice:c,exitPremium:eodPremium.toFixed(4),exitReason:'4pm Exit',pnlDollar,pnlPct:pnlDollar/opDeployed*100,won:pnlDollar>0});
          reset(); continue;
        }
      }

      // expiry
      if(opInPos&&ts>=opExpiry){
        const intrinsic=opType==='CALL'?Math.max(c-opStrike,0)*100*opContracts:Math.max(opStrike-c,0)*100*opContracts;
        const totalProceeds=opScaleProceeds+intrinsic;
        const pnlDollar=totalProceeds-opDeployed;
        opCash+=intrinsic;
        opTrades.push({...opCurrent,exitTime:new Date(ts).toISOString(),exitPrice:c,exitReason:'Expired',pnlDollar,pnlPct:pnlDollar/opDeployed*100,won:pnlDollar>0});
        reset(); continue;
      }

      if(opInPos){
        const T=Math.max((opExpiry-ts)/(365*24*60*60*1000),0.0001);
        const currentPremium=opType==='CALL'?bsCall(c,opStrike,T,RISK_FREE,iv):bsPut(c,opStrike,T,RISK_FREE,iv);
        const entryPPc=parseFloat(opCurrent.premiumPerContract);

        // ── scale-out logic ─────────────────────────────────────────────────
        if(scaleMode==='half'){
          // sell 50% once at +10%
          if(opScaleLevel===0 && currentPremium >= entryPPc/100 * 1.10){
            const sell=Math.floor(opContracts/2);
            if(sell>0){
              const proceeds=currentPremium*100*sell;
              opCash+=proceeds; opScaleProceeds+=proceeds; opContracts-=sell; opScaleLevel=1;
              const ev={pct:10,time:new Date(ts).toISOString(),price:c,premium:currentPremium.toFixed(4),contracts:sell,proceeds};
              opCurrent={...opCurrent,scales:[ev]};
            }
          }
        } else {
          // sell 10% of original at each +10% level, up to +50% (5 levels)
          const nextLevel=opScaleLevel+1;
          if(nextLevel<=5 && currentPremium >= entryPPc/100 * (1+nextLevel*0.10)){
            const sell=Math.min(opContracts, Math.max(1, Math.round(opOrigContracts*0.10)));
            if(sell>0){
              const proceeds=currentPremium*100*sell;
              opCash+=proceeds; opScaleProceeds+=proceeds; opContracts-=sell; opScaleLevel=nextLevel;
              const ev={pct:nextLevel*10,time:new Date(ts).toISOString(),price:c,premium:currentPremium.toFixed(4),contracts:sell,proceeds};
              opCurrent={...opCurrent,scales:[...(opCurrent.scales||[]),ev]};
            }
          }
        }

        // signal exit or stop-loss
        const stopHit=STOP_LOSS_PCT>0&&currentPremium<entryPPc/100*(1-STOP_LOSS_PCT);
        const shouldExit=(opType==='CALL'&&shortCond)||(opType==='PUT'&&longCond)||stopHit;
        if(shouldExit){
          const exitReason=stopHit?`Stop-Loss (${(STOP_LOSS_PCT*100).toFixed(0)}%)`:opType==='CALL'?'Bear Signal':'Bull Signal';
          const proceeds=currentPremium*100*opContracts;
          const totalProceeds=opScaleProceeds+proceeds;
          const pnlDollar=totalProceeds-opDeployed;
          opCash+=proceeds;
          opTrades.push({...opCurrent,exitTime:new Date(ts).toISOString(),exitPrice:c,exitPremium:currentPremium.toFixed(4),exitReason,pnlDollar,pnlPct:pnlDollar/opDeployed*100,won:pnlDollar>0});
          reset();
        }
      }

      // open new position
      if(opContracts===0&&opCash>0){
        // for 0DTE don't enter at or after 2pm ET — not enough time left
        if(DTE===0&&!beforeCutoff) continue;

        let entryExpiry;
        if(DTE===0){
          const d=new Date(ts); d.setUTCHours(20,0,0,0);
          if(d.getTime()<=ts) d.setUTCDate(d.getUTCDate()+1);
          entryExpiry=d.getTime();
        } else {
          entryExpiry=ts+DTE*24*60*60*1000;
        }
        const entryT=Math.max((entryExpiry-ts)/(365*24*60*60*1000),1/(365*24*60));
        let type='', premium=0, strike=0;
        if(longCond){
          type='CALL'; strike=Math.round((c+OTM_OFFSET)*20)/20;
          premium=bsCall(c,strike,entryT,RISK_FREE,iv);
        } else if(shortCond){
          type='PUT'; strike=Math.round((c-OTM_OFFSET)*20)/20;
          premium=bsPut(c,strike,entryT,RISK_FREE,iv);
        }
        if(type&&premium>0){
          const premiumPerContract=premium*100;
          if(premiumPerContract>opCash) continue;
          const pct=allocPct(opCash);
          const cashToSpend=opCash*pct;
          const numContracts=Math.min(50,Math.max(1,Math.floor(cashToSpend/premiumPerContract)));
          const deployed=numContracts*premiumPerContract;
          if(deployed>opCash) continue;
          opCash-=deployed; opContracts=numContracts; opOrigContracts=numContracts;
          opStrike=strike; opExpiry=entryExpiry; opDeployed=deployed; opType=type;
          opScaleLevel=0; opScaleProceeds=0;
          lastTradeDateStr=barDateStr;
          opCurrent={
            type,entryTime:new Date(ts).toISOString(),entryPrice:c,strike,
            iv:(iv*100).toFixed(0)+'%',premiumPerContract:premiumPerContract.toFixed(2),
            contracts:numContracts,deployed,score:type==='CALL'?buyScore:sellScore,threshold,allocPct:pct,dte:DTE,scales:[],
          };
        }
      }
    }

    // close open position at last bar
    if(opContracts>0&&opCurrent){
      const lastC=closes[n-1], lastTs=candles[n-1].time;
      const iv2=historicalVol(closes,n-1,barsPerYear);
      const T=Math.max((opExpiry-lastTs)/(365*24*60*60*1000),0.0001);
      const p=opType==='CALL'?bsCall(lastC,opStrike,T,RISK_FREE,iv2):bsPut(lastC,opStrike,T,RISK_FREE,iv2);
      const proceeds=p*100*opContracts;
      const totalProceeds=opScaleProceeds+proceeds;
      const pnlDollar=totalProceeds-opDeployed;
      opCash+=proceeds;
      opTrades.push({...opCurrent,exitTime:new Date(lastTs).toISOString(),exitPrice:lastC,exitPremium:p.toFixed(4),exitReason:'Open (last bar)',pnlDollar,pnlPct:pnlDollar/opDeployed*100,won:pnlDollar>0});
    }

    return {trades:opTrades, finalCash:opCash};
  }

  const halfSim = runOpSim('half');
  const incrSim = runOpSim('incremental');

  // ── Print results ──────────────────────────────────────────────────────────

  const summary=(trades,finalCash,label)=>{
    const wins=trades.filter(t=>t.won).length, losses=trades.length-wins;
    const winRate=trades.length?(wins/trades.length*100).toFixed(1):'0.0';
    const avgWin$=wins?(trades.filter(t=>t.won).reduce((s,t)=>s+t.pnlDollar,0)/wins).toFixed(2):'0.00';
    const avgLoss$=losses?(trades.filter(t=>!t.won).reduce((s,t)=>s+t.pnlDollar,0)/losses).toFixed(2):'0.00';
    const net=(finalCash-START_CAP).toFixed(2), netPct=((finalCash-START_CAP)/START_CAP*100).toFixed(2);
    console.log(`\n  ══ ${label} `.padEnd(66,'═'));
    console.log(`  Starting Capital : $${START_CAP.toFixed(2)}`);
    console.log(`  Final Equity     : $${finalCash.toFixed(2)}`);
    console.log(`  Net P&L          : $${net}  (${parseFloat(netPct)>=0?'+':''}${netPct}%)`);
    console.log(`  Trades: ${trades.length}  |  Wins: ${wins}  |  Losses: ${losses}  |  Win Rate: ${winRate}%`);
    console.log(`  Avg Win $: +$${avgWin$}  |  Avg Loss $: $${avgLoss$}`);
  };

  const printTradeLog=(label,trades)=>{
    console.log(`\n  ── Trade Log: ${label} ${'─'.repeat(Math.max(0,54-label.length))}`);
    console.log(`  ${'#'.padEnd(3)} ${'Type'.padEnd(5)} ${'Entry'.padEnd(20)} ${'Stock$'.padEnd(9)} ${'Strike'.padEnd(9)} ${'IV'.padEnd(6)} ${'Scr'.padEnd(5)} ${'$/Contract'.padEnd(12)} ${'Qty'.padEnd(8)} ${'Deployed'.padEnd(10)} ${'Exit$'.padEnd(9)} ${'P&L$'.padEnd(11)} Reason`);
    trades.forEach((t,idx)=>{
      const sign=t.pnlDollar>=0?'+':'';
      const marker=t.won?'✓':'✗';
      const fallbackTag=t.threshold<=MIN_SCORE_FALLBACK&&t.threshold<MIN_SCORE?'*':'';
      console.log(
        `  ${marker} ${String(idx+1).padEnd(2)} ${(t.type==='CALL'?'CALL':'PUT ').padEnd(5)} ${t.entryTime.replace('T',' ').slice(0,19).padEnd(20)} ` +
        `$${t.entryPrice.toFixed(2).padEnd(8)} $${t.strike.toFixed(2).padEnd(8)} ${t.iv.padEnd(6)} ` +
        `${String(t.score+fallbackTag).padEnd(5)} $${t.premiumPerContract.padEnd(11)} ${String(t.contracts+' x 100').padEnd(8)} ` +
        `$${t.deployed.toFixed(0).padEnd(9)} $${t.exitPrice.toFixed(2).padEnd(8)} ` +
        `${(sign+'$'+Math.abs(t.pnlDollar).toFixed(2)).padEnd(11)} ${t.exitReason}`
      );
      (t.scales||[]).forEach(s=>{
        console.log(`       ↳ +${s.pct}% trigger: sold ${s.contracts} contracts @ $${s.premium}/share on ${s.time.replace('T',' ').slice(0,19)} — banked $${s.proceeds.toFixed(2)}`);
      });
    });
  };

  const otmLabel  = OTM_OFFSET>0 ? ` | $${OTM_OFFSET} OTM` : ' | ATM';
  const stopLabel = STOP_LOSS_PCT>0 ? ` | Stop-Loss: ${(STOP_LOSS_PCT*100).toFixed(0)}% of premium` : ' | No stop-loss';
  const dteLabel  = DTE===0 ? '0DTE (same-day expiry)' : EXIT_EOD ? `${DTE} DTE — exit same day by 4pm ET or signal` : `${DTE} DTE`;

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(`  ${ticker} — ${interval} — ${days} Days  |  Shares vs Options  |  $1,000 Starting`);
  console.log(`  Options: Calls (bullish) + Puts (bearish), ${dteLabel}${otmLabel}${stopLabel}`);
  console.log('══════════════════════════════════════════════════════════════════');

  summary(eqTrades,  eqCash, 'SHARES — Long only (baseline)');
  summary(halfSim.trades, halfSim.finalCash, 'OPTIONS — 50% scale-out at +10%');
  summary(incrSim.trades, incrSim.finalCash, 'OPTIONS — 10% incremental scale (up to +50%)');

  printTradeLog('50% scale-out at +10%', halfSim.trades);
  printTradeLog('10% incremental scale (up to +50%)', incrSim.trades);

  // ── Clean trade breakdown ──────────────────────────────────────────────────
  const printBreakdown=(label,trades)=>{
    console.log(`\n${'═'.repeat(90)}`);
    console.log(`  TRADE BREAKDOWN — ${label}`);
    console.log(`${'═'.repeat(90)}`);
    let runningCash=START_CAP;
    trades.forEach((t,idx)=>{
      const date=t.entryTime.slice(0,10);
      const entryTime=t.entryTime.slice(11,16);
      const exitTime=t.exitTime.slice(11,16);
      const isFallback=t.threshold<=MIN_SCORE_FALLBACK&&t.threshold<MIN_SCORE;
      const signalTag=isFallback?'FALLBACK':'PRIMARY ';
      const won=t.pnlDollar>0;
      const marker=won?'✓ WIN ':'✗ LOSS';
      const sign=t.pnlDollar>=0?'+':'-';
      const scaleLevels=(t.scales||[]).map(s=>'+'+s.pct+'%').join(' → ');
      const scaleTotal=(t.scales||[]).reduce((s,e)=>s+e.proceeds,0);
      runningCash+=t.pnlDollar;

      console.log(`\n  Trade ${String(idx+1).padStart(2,'0')}  ${marker}  ${date}  ${t.type.padEnd(4)}  Score: ${t.score} (${signalTag})`);
      console.log(`  ├─ Entry : ${entryTime} ET @ $${t.entryPrice.toFixed(2)}  Strike: $${t.strike.toFixed(2)}  IV: ${t.iv}`);
      console.log(`  ├─ Exit  : ${exitTime} ET @ $${t.exitPrice.toFixed(2)}  Reason: ${t.exitReason}`);
      console.log(`  ├─ Size  : ${t.contracts} contracts × 100 shares  |  Premium: $${t.premiumPerContract}/contract  |  Deployed: $${t.deployed.toFixed(0)}`);
      if(scaleLevels){
        console.log(`  ├─ Scale : ${scaleLevels}  (banked $${scaleTotal.toFixed(0)} in partial exits)`);
      } else {
        console.log(`  ├─ Scale : no scale-out triggered`);
      }
      console.log(`  └─ P&L   : ${sign}$${Math.abs(t.pnlDollar).toFixed(2)}  (${sign}${Math.abs(t.pnlPct).toFixed(1)}% on deployed)  |  Running equity: $${runningCash.toFixed(0)}`);
    });
    const wins=trades.filter(t=>t.won).length;
    const primary=trades.filter(t=>!(t.threshold<=MIN_SCORE_FALLBACK&&t.threshold<MIN_SCORE));
    const fallback=trades.filter(t=>t.threshold<=MIN_SCORE_FALLBACK&&t.threshold<MIN_SCORE);
    const fbWins=fallback.filter(t=>t.won).length;
    const prWins=primary.filter(t=>t.won).length;
    console.log(`\n${'─'.repeat(90)}`);
    console.log(`  Total: ${trades.length} trades  |  Wins: ${wins}  Losses: ${trades.length-wins}  |  Win rate: ${(wins/trades.length*100).toFixed(1)}%`);
    console.log(`  Primary signals (score ≥${MIN_SCORE}): ${primary.length} trades, ${prWins} wins (${primary.length?(prWins/primary.length*100).toFixed(1):0}% win rate)`);
    console.log(`  Fallback signals (score ${MIN_SCORE_FALLBACK}-${MIN_SCORE-1}): ${fallback.length} trades, ${fbWins} wins (${fallback.length?(fbWins/fallback.length*100).toFixed(1):0}% win rate)`);
    console.log(`${'─'.repeat(90)}`);
  };

  printBreakdown('50% scale-out at +10%', halfSim.trades);
  printBreakdown('10% incremental scale (up to +50%)', incrSim.trades);

  console.log('\n  Note: Black-Scholes mid-price — no bid/ask spread. Real fills will differ.');
  console.log('  Puts cannot be held in all cash accounts — verify with your broker.\n');
})();
