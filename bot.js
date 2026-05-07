require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const SparkMD5 = require('sparkmd5');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('BOT_TOKEN missing'); process.exit(1); }

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── Storage ───────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { token: process.env.VSPHONE_TOKEN || '', userId: '', pendingOtp: false }; }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

let state = loadState();

// ─── Helpers ───────────────────────────────────────────────────────────────
const ALLOWED = (process.env.ALLOWED_USER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function isAllowed(userId) {
  if (ALLOWED.length === 0) return true;
  return ALLOWED.includes(String(userId));
}

function deny(chatId) {
  bot.sendMessage(chatId, '⛔ Kamu tidak punya akses ke bot ini.');
}

const VSPHONE_HEADERS = {
  'Content-Type': 'application/json',
  'clientType': 'web',
  'appVersion': '2.5.600',
  'requestsource': 'wechat-miniapp',
  'SupplierType': '0',
  'Origin': 'https://cloud.vsphone.com',
  'Referer': 'https://cloud.vsphone.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en',
};

function authHeaders() {
  const h = { ...VSPHONE_HEADERS };
  if (state.token) h['Token'] = state.token;
  if (state.userId) h['userId'] = state.userId;
  return h;
}

async function vsphoneAPI(path, body = null, method = 'POST') {
  const url = `https://api.vsphone.com/vsphone${path}`;
  const opts = {
    method,
    headers: authHeaders(),
  };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

// ─── Login Flow ────────────────────────────────────────────────────────────
const pendingOtpChats = new Map(); // chatId → { email, password }

async function doLogin(email, passwordMd5, verifyCode) {
  const body = {
    mobilePhone: email,
    password: passwordMd5,
    loginType: 0,
    channel: 'web',
  };
  if (verifyCode) body.verifyCode = verifyCode;
  return vsphoneAPI('/api/user/login', body);
}

async function requestOtp(email) {
  return vsphoneAPI('/api/sms/smsSend', {
    mobilePhone: email,
    smsType: 2,
  });
}

// ─── Device List ───────────────────────────────────────────────────────────
async function getDevices(page = 1, rows = 50) {
  return vsphoneAPI('/api/padApi/userPadList', { page, rows });
}

// ─── Set Proxy ─────────────────────────────────────────────────────────────
// proxyType: 'proxy' | 'vpn'
// proxyName: 'socks5' | 'http-relay'
// sUoT: 0 | 1 (UDP on/off)
async function setProxy({ padCodes, ip, port, account, password, enable = 1, proxyType = 'proxy', proxyName = 'socks5', sUoT = 0 }) {
  return vsphoneAPI('/api/padApi/setProxy', {
    padCodes,
    ip,
    port: String(port),
    account,
    password,
    enable,
    proxyType,
    proxyName,
    sUoT,
  });
}

async function clearProxy(padCodes) {
  return vsphoneAPI('/api/padApi/setProxy', {
    padCodes,
    ip: '',
    port: '',
    account: '',
    password: '',
    enable: 0,
    proxyType: 'proxy',
    proxyName: 'socks5',
    sUoT: 0,
  });
}

// ─── Format helpers ────────────────────────────────────────────────────────
function parseProxy(proxyStr) {
  // Format: http://user:pass@host:port  OR  socks5://user:pass@host:port  OR  host:port:user:pass
  try {
    let url;
    if (proxyStr.startsWith('http') || proxyStr.startsWith('socks')) {
      url = new URL(proxyStr);
      return {
        ip: url.hostname,
        port: url.port,
        account: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        proxyName: proxyStr.startsWith('socks5') ? 'socks5' : 'http-relay',
      };
    }
    // Try host:port:user:pass
    const parts = proxyStr.split(':');
    if (parts.length >= 2) {
      return {
        ip: parts[0],
        port: parts[1],
        account: parts[2] || '',
        password: parts[3] || '',
        proxyName: 'http-relay',
      };
    }
  } catch {}
  return null;
}

function fmtDevice(d, idx) {
  const status = d.onlineStatus === 1 ? '🟢' : '🔴';
  const proxy = d.proxyIp ? `🌐 ${d.proxyIp}:${d.proxyPort}` : '🚫 No proxy';
  return `${idx + 1}. ${status} <b>${d.padName || d.padCode}</b>\n   ID: <code>${d.padCode}</code>\n   ${proxy}`;
}

// ─── Commands ──────────────────────────────────────────────────────────────
const HELP_TEXT = `
<b>vsPhone Bot — Perintah</b>

/devices — Daftar semua cloud phone
/setproxy &lt;padCode&gt; &lt;proxy&gt; — Set proxy ke device
  <i>Contoh:</i> /setproxy ABC123 http://user:pass@host:port
  <i>atau:</i> /setproxy ABC123 socks5://user:pass@host:port

/setproxy_all &lt;proxy&gt; — Set proxy ke semua device sekaligus

/clearproxy &lt;padCode&gt; — Hapus proxy dari device
/clearproxy_all — Hapus proxy semua device

/settoken &lt;token&gt; — Set vsphone session token manual
  <i>(Copy dari browser: F12 → Network → header "Token")</i>

/login — Login ulang ke vsphone

/status — Cek status token saat ini
/help — Tampilkan bantuan ini
`.trim();

bot.onText(/\/start/, (msg) => {
  if (!isAllowed(msg.from.id)) return deny(msg.chat.id);
  bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'HTML' });
});

bot.onText(/\/help/, (msg) => {
  if (!isAllowed(msg.from.id)) return deny(msg.chat.id);
  bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'HTML' });
});

// /status
bot.onText(/\/status/, async (msg) => {
  if (!isAllowed(msg.from.id)) return deny(msg.chat.id);
  if (!state.token) {
    return bot.sendMessage(msg.chat.id, '❌ Belum ada token. Gunakan /settoken atau /login');
  }
  const res = await vsphoneAPI('/api/user/getUserInfo', {});
  if (res.code === 200) {
    const u = res.data;
    bot.sendMessage(msg.chat.id,
      `✅ <b>Token aktif</b>\n👤 ${u.nickName || u.mobilePhone || u.userId}\n📧 ${u.email || '-'}\n💰 Balance: ${u.balance || 0}`,
      { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(msg.chat.id, `❌ Token tidak valid (${res.code}: ${res.msg})\n\nGunakan /settoken atau /login`);
  }
});

// /settoken <token>
bot.onText(/\/settoken (.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return deny(msg.chat.id);
  const token = match[1].trim();
  state.token = token;
  saveState(state);
  bot.sendMessage(msg.chat.id, '✅ Token disimpan! Cek dengan /status');
  // Delete the message for security
  bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
});

// /login
bot.onText(/\/login/, async (msg) => {
  if (!isAllowed(msg.from.id)) return deny(msg.chat.id);
  const email = process.env.VSPHONE_EMAIL;
  const pass = process.env.VSPHONE_PASSWORD;
  if (!email || !pass) {
    return bot.sendMessage(msg.chat.id,
      '❌ VSPHONE_EMAIL / VSPHONE_PASSWORD belum diset di environment.\n\nGunakan /settoken untuk set token manual.');
  }
  const pwdMd5 = SparkMD5.hash(pass);
  bot.sendMessage(msg.chat.id, '⏳ Mencoba login ke vsphone...');
  
  const res = await doLogin(email, pwdMd5, null);
  if (res.code === 200 && res.data?.token) {
    state.token = res.data.token;
    state.userId = String(res.data.userId || '');
    saveState(state);
    bot.sendMessage(msg.chat.id, `✅ Login berhasil!\n👤 ${res.data.nickName || email}`);
  } else if (res.code === 1005) {
    // Need OTP
    pendingOtpChats.set(msg.chat.id, { email, pwdMd5 });
    // Try to send OTP
    const otpRes = await requestOtp(email);
    if (otpRes.code === 200) {
      bot.sendMessage(msg.chat.id,
        `📧 Kode verifikasi dikirim ke <b>${email}</b>.\n\nBalas dengan kode 6 digit yang kamu terima:`,
        { parse_mode: 'HTML' });
    } else {
      bot.sendMessage(msg.chat.id,
        `⚠️ Login butuh kode verifikasi tapi gagal kirim OTP (${otpRes.code}: ${otpRes.msg}).\n\n` +
        `Coba /settoken dengan token dari browser:\n` +
        `1. Buka cloud.vsphone.com → login\n` +
        `2. F12 → Network → klik request manapun\n` +
        `3. Copy nilai header <code>Token</code>\n` +
        `4. /settoken &lt;nilai token&gt;`,
        { parse_mode: 'HTML' });
    }
  } else {
    bot.sendMessage(msg.chat.id, `❌ Login gagal: ${res.code} — ${res.msg}`);
  }
});

// Handle OTP reply
bot.on('message', async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const pending = pendingOtpChats.get(msg.chat.id);
  if (!pending) return;
  const text = (msg.text || '').trim();
  if (!/^\d{4,8}$/.test(text)) return; // Only process 4-8 digit codes
  
  pendingOtpChats.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, '⏳ Memverifikasi kode...');
  const res = await doLogin(pending.email, pending.pwdMd5, text);
  if (res.code === 200 && res.data?.token) {
    state.token = res.data.token;
    state.userId = String(res.data.userId || '');
    saveState(state);
    bot.sendMessage(msg.chat.id, `✅ Login berhasil!\n👤 ${res.data.nickName || pending.email}`);
  } else {
    bot.sendMessage(msg.chat.id, `❌ Verifikasi gagal: ${res.code} — ${res.msg}`);
  }
});

// /devices
bot.onText(/\/devices/, async (msg) => {
  if (!isAllowed(msg.from.id)) return deny(msg.chat.id);
  if (!state.token) return bot.sendMessage(msg.chat.id, '❌ Belum login. Gunakan /login atau /settoken');
  
  const wait = await bot.sendMessage(msg.chat.id, '⏳ Mengambil daftar device...');
  const res = await getDevices();
  bot.deleteMessage(msg.chat.id, wait.message_id).catch(() => {});

  if (res.code !== 200) {
    return bot.sendMessage(msg.chat.id, `❌ Gagal: ${res.code} — ${res.msg}`);
  }
  const devices = res.data?.list || res.data?.rows || res.data || [];
  if (!devices.length) {
    return bot.sendMessage(msg.chat.id, '📱 Tidak ada device ditemukan.');
  }
  const text = `📱 <b>Cloud Phone (${devices.length})</b>\n\n` + devices.map(fmtDevice).join('\n\n');
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

// /setproxy <padCode> <proxyUrl>
bot.onText(/\/setproxy (\S+) (.+)/, async (msg, match) => {
  if (!isAllowed(msg.from.id)) return deny(msg.chat.id);
  if (!state.token) return bot.sendMessage(msg.chat.id, '❌ Belum login. Gunakan /login atau /settoken');

  const padCode = match[1].trim();
  const proxyStr = match[2].trim();
  const parsed = parseProxy(proxyStr);
  if (!parsed) {
    return bot.sendMessage(msg.chat.id,
      '❌ Format proxy tidak dikenali.\n\nFormat yang didukung:\n' +
      '• <code>http://user:pass@host:port</code>\n' +
      '• <code>socks5://user:pass@host:port</code>\n' +
      '• <code>host:port:user:pass</code>',
      { parse_mode: 'HTML' });
  }

  const wait = await bot.sendMessage(msg.chat.id, `⏳ Setting proxy untuk device <code>${padCode}</code>...`, { parse_mode: 'HTML' });
  const res = await setProxy({ padCodes: [padCode], ...parsed });
  bot.deleteMessage(msg.chat.id, wait.message_id).catch(() => {});

  if (res.code === 200) {
    bot.sendMessage(msg.chat.id,
      `✅ Proxy berhasil diset!\n📱 Device: <code>${padCode}</code>\n🌐 ${parsed.ip}:${parsed.port}\n👤 ${parsed.account || '-'}`,
      { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(msg.chat.id, `❌ Gagal: ${res.code} — ${res.msg}`);
  }
});

// /setproxy_all <proxyUrl>
bot.onText(/\/setproxy_all (.+)/, async (msg, match) => {
  if (!isAllowed(msg.from.id)) return deny(msg.chat.id);
  if (!state.token) return bot.sendMessage(msg.chat.id, '❌ Belum login. Gunakan /login atau /settoken');

  const proxyStr = match[1].trim();
  const parsed = parseProxy(proxyStr);
  if (!parsed) {
    return bot.sendMessage(msg.chat.id, '❌ Format proxy tidak dikenali. Contoh: http://user:pass@host:port');
  }

  const wait = await bot.sendMessage(msg.chat.id, '⏳ Mengambil daftar device...');
  const devRes = await getDevices(1, 200);
  if (devRes.code !== 200) {
    bot.deleteMessage(msg.chat.id, wait.message_id).catch(() => {});
    return bot.sendMessage(msg.chat.id, `❌ Gagal ambil device: ${devRes.code} — ${devRes.msg}`);
  }
  const devices = devRes.data?.list || devRes.data?.rows || devRes.data || [];
  if (!devices.length) {
    bot.deleteMessage(msg.chat.id, wait.message_id).catch(() => {});
    return bot.sendMessage(msg.chat.id, '📱 Tidak ada device ditemukan.');
  }

  const padCodes = devices.map(d => d.padCode).filter(Boolean);
  bot.editMessageText(`⏳ Setting proxy untuk ${padCodes.length} device...`, {
    chat_id: msg.chat.id, message_id: wait.message_id
  }).catch(() => {});

  const res = await setProxy({ padCodes, ...parsed });
  bot.deleteMessage(msg.chat.id, wait.message_id).catch(() => {});

  if (res.code === 200) {
    bot.sendMessage(msg.chat.id,
      `✅ Proxy diset ke <b>${padCodes.length} device</b>!\n🌐 ${parsed.ip}:${parsed.port}\n👤 ${parsed.account || '-'}`,
      { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(msg.chat.id, `❌ Gagal: ${res.code} — ${res.msg}`);
  }
});

// /clearproxy <padCode>
bot.onText(/\/clearproxy (\S+)/, async (msg, match) => {
  if (!isAllowed(msg.from.id)) return deny(msg.chat.id);
  if (!state.token) return bot.sendMessage(msg.chat.id, '❌ Belum login. Gunakan /login atau /settoken');

  const padCode = match[1].trim();
  if (padCode === 'all') {
    // Redirect to clearproxy_all
    return bot.sendMessage(msg.chat.id, 'Gunakan /clearproxy_all untuk hapus proxy semua device.');
  }

  const wait = await bot.sendMessage(msg.chat.id, `⏳ Menghapus proxy dari device <code>${padCode}</code>...`, { parse_mode: 'HTML' });
  const res = await clearProxy([padCode]);
  bot.deleteMessage(msg.chat.id, wait.message_id).catch(() => {});

  if (res.code === 200) {
    bot.sendMessage(msg.chat.id, `✅ Proxy dihapus dari device <code>${padCode}</code>`, { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(msg.chat.id, `❌ Gagal: ${res.code} — ${res.msg}`);
  }
});

// /clearproxy_all
bot.onText(/\/clearproxy_all/, async (msg) => {
  if (!isAllowed(msg.from.id)) return deny(msg.chat.id);
  if (!state.token) return bot.sendMessage(msg.chat.id, '❌ Belum login. Gunakan /login atau /settoken');

  const wait = await bot.sendMessage(msg.chat.id, '⏳ Mengambil daftar device...');
  const devRes = await getDevices(1, 200);
  if (devRes.code !== 200) {
    bot.deleteMessage(msg.chat.id, wait.message_id).catch(() => {});
    return bot.sendMessage(msg.chat.id, `❌ Gagal ambil device: ${devRes.code} — ${devRes.msg}`);
  }
  const devices = devRes.data?.list || devRes.data?.rows || devRes.data || [];
  if (!devices.length) {
    bot.deleteMessage(msg.chat.id, wait.message_id).catch(() => {});
    return bot.sendMessage(msg.chat.id, '📱 Tidak ada device ditemukan.');
  }

  const padCodes = devices.map(d => d.padCode).filter(Boolean);
  bot.editMessageText(`⏳ Menghapus proxy dari ${padCodes.length} device...`, {
    chat_id: msg.chat.id, message_id: wait.message_id
  }).catch(() => {});

  const res = await clearProxy(padCodes);
  bot.deleteMessage(msg.chat.id, wait.message_id).catch(() => {});

  if (res.code === 200) {
    bot.sendMessage(msg.chat.id, `✅ Proxy dihapus dari <b>${padCodes.length} device</b>!`, { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(msg.chat.id, `❌ Gagal: ${res.code} — ${res.msg}`);
  }
});

// Polling error handler
bot.on('polling_error', (err) => {
  console.error('[polling_error]', err.message);
});

console.log('vsPhone Bot started');
