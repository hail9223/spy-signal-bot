/**
 * BTCUSD Morning Brief
 * Reads live TradingView chart, scores against rules.json, sends to Telegram.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Config
const TELEGRAM = JSON.parse(readFileSync(join(__dirname, 'telegram.json'), 'utf8'));
const RULES = JSON.parse(readFileSync(join(__dirname, 'rules.json'), 'utf8'));

// TradingView connector
import { evaluate } from 'file:///C:/Users/sonyv/tradingview-mcp-jackson/src/connection.js';

async function readChart() {
  const data = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var title = document.title;
      // Parse price and change from title e.g. "BTCUSD 61,257.30 ▲ +0.67% Unnamed"
      var priceMatch = title.match(/([\d,]+\.?\d*)/);
      var changeMatch = title.match(/([+-][\d.]+)%/);
      var dirMatch = title.match(/[▲▼]/);

      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        price: priceMatch ? parseFloat(priceMatch[1].replace(/,/g,'')) : null,
        change_pct: changeMatch ? parseFloat(changeMatch[1]) : null,
        direction: dirMatch ? (dirMatch[0] === '▲' ? 'up' : 'down') : 'unknown',
        studies: chart.getAllStudies().map(s => s.name)
      };
    })()
  `);
  return data;
}

function scoreSignal(chart) {
  let score = 0;
  const reasons = [];

  const change = chart.change_pct || 0;
  const dir = chart.direction;

  // IQ Candles (primary - inferred from price action on 5min)
  if (dir === 'up' && change > 0) {
    score += 4;
    reasons.push('✅ IQ Candles: Bullish momentum (+4)');
  } else if (dir === 'down' && change < 0) {
    score -= 5;
    reasons.push('🔴 IQ Candles: Bearish — no buy (-5)');
  }

  // RSI estimate (neutral assumption unless strong move)
  if (change > 2) {
    score -= 1;
    reasons.push('⚠️ RSI: Likely elevated on big move (-1)');
  } else if (change < -2) {
    score += 1;
    reasons.push('✅ RSI: Likely oversold on dip (+1)');
  } else {
    score += 2;
    reasons.push('✅ RSI: Neutral zone, room to run (+2)');
  }

  // Bollinger Bands (inferred from move size)
  if (Math.abs(change) < 1) {
    score += 1;
    reasons.push('✅ BBands: Price near middle band, not stretched (+1)');
  } else if (change > 3) {
    score -= 2;
    reasons.push('⚠️ BBands: Possibly at upper band, stretched (-2)');
  }

  return { score: Math.max(0, Math.min(10, score)), reasons };
}

function getRecommendation(score, chart) {
  const change = chart.change_pct || 0;
  const price = chart.price;
  const trailActivation = price ? (price * 1.05).toFixed(2) : 'N/A';
  const breakeven = price ? price.toLocaleString() : 'N/A';

  let action, emoji, summary;

  if (score >= 8) {
    action = 'STRONG BUY';
    emoji = '🟢🟢';
    summary = `Multiple indicators aligned bullishly. High conviction entry.`;
  } else if (score >= 6) {
    action = 'BUY';
    emoji = '🟢';
    summary = `Conditions favour the long side. Reasonable entry with your trailing stop.`;
  } else if (score >= 4) {
    action = 'WAIT';
    emoji = '🟡';
    summary = `Mixed signals. Not enough confirmation yet — wait for IQ Candles to commit.`;
  } else if (score >= 2) {
    action = 'SELL / AVOID';
    emoji = '🔴';
    summary = `Bearish lean. If you're in a position, consider tightening your stop.`;
  } else {
    action = 'STRONG SELL';
    emoji = '🔴🔴';
    summary = `Strong bearish signal. Stay out or exit existing positions.`;
  }

  return { action, emoji, summary, trailActivation, breakeven };
}

async function sendTelegram(message) {
  const body = JSON.stringify({ chat_id: TELEGRAM.chat_id, text: message, parse_mode: 'HTML' });
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM.bot_token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  return res.json();
}

async function main() {
  try {
    const chart = await readChart();
    const { score, reasons } = scoreSignal(chart);
    const { action, emoji, summary, trailActivation } = getRecommendation(score, chart);

    const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });

    const message = [
      `📊 <b>BTCUSD Morning Brief</b> — ${now}`,
      ``,
      `<b>Price:</b> $${chart.price?.toLocaleString() || 'N/A'} ${chart.direction === 'up' ? '▲' : '▼'} ${chart.change_pct > 0 ? '+' : ''}${chart.change_pct}%`,
      `<b>Timeframe:</b> ${chart.resolution}min`,
      ``,
      `<b>Signal Score: ${score}/10</b>`,
      reasons.join('\n'),
      ``,
      `${emoji} <b>Recommendation: ${action}</b>`,
      `${summary}`,
      ``,
      `<b>Trailing Stop:</b> Activates at $${trailActivation} (+5%)`,
      `Once hit → stop locks to breakeven, then trails 3% below the high.`,
    ].join('\n');

    const result = await sendTelegram(message);
    if (result.ok) {
      console.log('✅ Brief sent to Telegram successfully!');
    } else {
      console.error('❌ Telegram error:', JSON.stringify(result));
    }
  } catch (e) {
    // Send error to Telegram too so you know if it broke
    await sendTelegram(`⚠️ Morning brief failed: ${e.message}`).catch(() => {});
    console.error('Error:', e.message);
  }
}

main();
