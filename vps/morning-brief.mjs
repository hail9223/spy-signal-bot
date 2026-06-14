/**
 * Morning Brief — Top 5 runners under $15
 * Calls Claude API with web search, sends to Telegram
 */

import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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

async function main() {
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Today is ${today}. You are a stock market morning brief assistant.

Search the web for today's top 5 stock runners under $15 with:
- A clear news catalyst (earnings, FDA approval, acquisition, contract, partnership, etc.)
- Short squeeze potential (high short interest, thin float, or heavy volume)
- Premarket momentum or gap-up activity

Search for:
- "top premarket gainers under $15 today ${today}"
- "short squeeze stocks under $15 ${today} news catalyst"
- "small cap stocks with news catalyst premarket ${today}"

For each stock verify: price under $15, specific news catalyst today, squeeze or momentum potential.

Format your response EXACTLY like this and nothing else:

🌅 MORNING BRIEF — ${today}

📋 TOP 5 RUNNERS UNDER $15
Squeeze Potential + News Catalyst

━━━━━━━━━━━━━━━━━━━━━━━━━━━
1️⃣ [TICKER] — [Company Name]
💲 ~$[price]  |  🔥 [Squeeze Pick / Squeeze Watch]

📰 [One sentence describing the news catalyst]
📈 [Price action / % move]
⚡ [Why it has squeeze potential]
⚠️ [One risk]

━━━━━━━━━━━━━━━━━━━━━━━━━━━
[repeat for each stock]

━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 RULES FOR THESE PLAYS:
• Watch first 15-30 min for direction
• Only enter if volume confirms move
• Set a hard stop — these move FAST both ways
• Never size more than you can afford to lose 100%

🕙 Market opens 9:30am ET
Good luck today! 🚀`
      }]
    });

    // Extract the text response
    const text = response.content.find(b => b.type === 'text')?.text;
    if (text) {
      const result = await sendTelegram(text);
      if (result.ok) {
        console.log('✅ Morning brief sent successfully');
      } else {
        console.error('❌ Telegram error:', JSON.stringify(result));
      }
    }
  } catch (e) {
    await sendTelegram(`⚠️ Morning brief failed: ${e.message}`).catch(() => {});
    console.error('Error:', e.message);
  }
}

main();
