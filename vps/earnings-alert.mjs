/**
 * Earnings Alert — Top 3 stocks under $30
 * Beat + Profitable + Buy-rated + High Short Interest
 * Pass argument: "405" | "415" | "502"
 */

import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const slot = process.argv[2] || '405';

async function sendTelegramChunk(text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
  });
  return res.json();
}

async function sendTelegram(text) {
  if (text.length <= 4000) return sendTelegramChunk(text);
  const parts = text.split(/(?=━━━)/);
  let chunk = '';
  for (const part of parts) {
    if ((chunk + part).length > 4000) {
      if (chunk) await sendTelegramChunk(chunk.trim());
      chunk = part;
    } else {
      chunk += part;
    }
  }
  if (chunk.trim()) await sendTelegramChunk(chunk.trim());
  return { ok: true };
}

function isEarningsSeason() {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  const day = now.getDate();
  // Mid-Jan through mid-Feb (Q4), Mid-Apr through mid-May (Q1)
  // Mid-Jul through mid-Aug (Q2), Mid-Oct through mid-Nov (Q3)
  if (month === 1 && day >= 15) return true;
  if (month === 2 && day <= 15) return true;
  if (month === 4 && day >= 15) return true;
  if (month === 5 && day <= 15) return true;
  if (month === 7 && day >= 15) return true;
  if (month === 8 && day <= 15) return true;
  if (month === 10 && day >= 15) return true;
  if (month === 11 && day <= 15) return true;
  return false;
}

async function main() {
  if (!isEarningsSeason()) {
    console.log('Not earnings season — skipping');
    process.exit(0);
  }

  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const slotLabel = slot === '405' ? '4:05pm' : slot === '415' ? '4:15pm' : '5pm Final';
  const isUpdate = slot === '415';
  const isFinal = slot === '502';

  const sweepNote = isUpdate
    ? 'This is the 4:15pm sweep — focus on reports released in the last 15 minutes only. Skip any already covered in the 4:05pm alert.'
    : isFinal
    ? 'This is the 5pm final sweep — search ALL earnings reported today both before and after close. Be thorough.'
    : 'This is the 4:05pm first sweep — focus on reports released today after market close.';

  const header = isFinal
    ? `EARNINGS FINAL ALERT - ${today} 5pm ET\n\nTOP 3 UNDER $30 | BEAT + PROFITABLE + BUY + HIGH SHORT INTEREST\nRanked by short interest (squeeze potential)`
    : isUpdate
    ? `EARNINGS ALERT (4:15pm Update) - ${today}\n\nTOP 3 UNDER $30 | BEAT + PROFITABLE + BUY + HIGH SHORT INTEREST`
    : `EARNINGS ALERT - ${today} 4:05pm ET\n\nTOP 3 UNDER $30 | BEAT + PROFITABLE + BUY + HIGH SHORT INTEREST`;

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Today is ${today}. ${sweepNote}

Search for stocks that reported earnings today matching ALL of these criteria:
1. Stock price UNDER $30
2. Earnings BEAT vs analyst consensus (EPS or revenue)
3. PROFITABLE company (positive net income — not just beat a loss)
4. Analyst rating of Buy or Strong Buy (majority consensus)
5. HIGH short interest (10%+ of float preferred, higher = better squeeze potential)

Search queries to use:
- "earnings beat today ${today} stock under $30 after hours"
- "top earnings surprises ${today} small cap beat estimate"
- "high short interest earnings beat ${today}"

Find the TOP 3 ONLY that meet all criteria. Rank by short interest % (highest first).

Format your entire response EXACTLY like this — no extra commentary:

${header}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
1 [TICKER] - [Company Name]
$ [price]  |  Short Interest: [X]% of float

Earnings: EPS $[actual] vs est $[estimate] ([+X%] beat)
Revenue: $[actual] vs est $[estimate]
Analyst Rating: [Buy/Strong Buy - X of Y analysts]
Squeeze: [1 sentence why it has squeeze potential]
Risk: [1 sentence]

━━━━━━━━━━━━━━━━━━━━━━━━━━━
[repeat for 2nd and 3rd stock]

━━━━━━━━━━━━━━━━━━━━━━━━━━━
${isFinal ? `PLAYBOOK FOR TOMORROW:
- Watch premarket for gap-up confirmation
- Enter only if volume is 2x+ average in first 15 min
- Set hard stop below today's close
- High-risk high-reward — size accordingly

Market opens 9:30am ET tomorrow` : `Post-earnings plays — price action tomorrow matters.
Watch for gap-ups with volume confirmation at open.`}

If fewer than 3 stocks qualify, only include those that meet ALL criteria.
If none qualify, respond with just: "${isFinal ? 'EARNINGS FINAL ALERT' : 'EARNINGS ALERT'} — no stocks met all criteria today."`
      }]
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    const text = textBlocks[textBlocks.length - 1]?.text;
    if (text) {
      const result = await sendTelegram(text);
      if (result.ok) {
        console.log(`✅ Earnings alert (${slot}) sent`);
      } else {
        console.error('❌ Telegram error:', JSON.stringify(result));
      }
    }
  } catch (e) {
    await sendTelegram(`Warning: Earnings alert ${slot} failed: ${e.message}`).catch(() => {});
    console.error('Error:', e.message);
  }
}

main();
