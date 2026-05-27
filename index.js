require('dotenv').config();
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { imageToWebp, videoToWebp } = require('./lib/sticker');

const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });
const PREFIX = '/';
const BOT_NAME = 'lixx-bot';

async function startBot() {
  
  // Local File Auth
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');


  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: true,
    browser: [BOT_NAME, 'Chrome', '1.0'],
  });

  store.bind(sock.ev);

  // ─── Connection Update ──────────────────────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr: newQR }) => {
    
    if (connection === 'open') {
      console.log('\n✅ WhatsApp Connected!');
    }
    if (newQR) {
      qrcode.generate(newQR, { small: true });
    }
    if (!sock.authState.creds.registered) {
      const phoneNumber = process.env.PHONE_NUMBER;
      if (phoneNumber) {
        const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
        console.log('\n🔑 Pairing Code:', code);
      }
    }

    if (connection === 'close') {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus, reconnect:', shouldReconnect);
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ─── Message Handler ────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;

      const from = m.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const sender = isGroup ? m.key.participant : from;
      const body = m.message?.conversation
        || m.message?.extendedTextMessage?.text
        || m.message?.imageMessage?.caption
        || m.message?.videoMessage?.caption
        || '';

      // Group info
      let participants = [];
      if (isGroup) {
        const metadata = await sock.groupMetadata(from).catch(() => null);
        participants = metadata?.participants || [];
      }

      if (!body.startsWith(PREFIX) && PREFIX !== '') continue;

      const args = body.slice(PREFIX.length).trim().split(' ');
      const cmd = args[0].toLowerCase();

      try {
        
    // Command: ping
    if (cmd === 'ping') {
      const now = Date.now();
      await sock.sendMessage(from, { text: `🏓 Pong! ${now - (m.messageTimestamp * 1000)}ms` }, { quoted: m });
    }

    // Command: menu
    if (cmd === 'menu' || cmd === 'help') {
      const menuText = `
╔══════════════════╗
║  🤖 lixx-bot  ║
╚══════════════════╝
📋 *DAFTAR COMMAND*

  /antilink - Auto hapus pesan berisi link\n  /ping - Command ping/pong\n  /group - Kick, add, promote member\n  /dl - Download YT/IG/TikTok\n  /ai - Integasi AI (OpenAI/Gemini)\n  /menu - List semua command\n  /sticker - Buat sticker dari gambar\n  /welcome - Auto sambut member baru

_Powered by Baileys_`;
      await sock.sendMessage(from, { text: menuText }, { quoted: m });
    }

    // Command: sticker
    if (cmd === 'sticker' || cmd === 's') {
      const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!quoted) {
        return sock.sendMessage(from, { text: '❌ Reply ke gambar/video dulu!' }, { quoted: m });
      }
      // Implementasi sticker ada di lib/sticker.js
      await sock.sendMessage(from, { text: '🖼 Proses sticker...' }, { quoted: m });
    }

    // Command: ai
    if (cmd === 'ai' || cmd === 'gpt') {
      const query = body.slice(('/' + cmd).length).trim();
      if (!query) return sock.sendMessage(from, { text: '❓ Ketik pertanyaan setelah command!' }, { quoted: m });
      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: query }],
            max_tokens: 500
          })
        });
        const data = await res.json();
        await sock.sendMessage(from, { text: data.choices[0].message.content }, { quoted: m });
      } catch(e) {
        await sock.sendMessage(from, { text: '❌ Error AI: ' + e.message }, { quoted: m });
      }
    }

    // Anti Link (auto delete)
    if (isGroup && body.match(/(https?:\/\/)|(wa\.me)/gi)) {
      const isAdmin = participants.find(p => p.id === sender)?.admin;
      const isBotAdmin = participants.find(p => p.id === sock.user.id)?.admin;
      if (!isAdmin && isBotAdmin) {
        await sock.sendMessage(from, { delete: m.key });
        await sock.sendMessage(from, { text: `⚠️ @${sender.split('@')[0]} tidak boleh kirim link!`, mentions: [sender] });
      }
    }

    // (Welcome handler ada di events.group-participants.update)

    // Command: kick
    if (cmd === 'kick') {
      const isAdmin = participants.find(p => p.id === sender)?.admin;
      if (!isAdmin) return sock.sendMessage(from, { text: '❌ Kamu bukan admin!' }, { quoted: m });
      const target = m.message?.extendedTextMessage?.contextInfo?.participant;
      if (!target) return sock.sendMessage(from, { text: '❌ Reply ke pesan target!' }, { quoted: m });
      await sock.groupParticipantsUpdate(from, [target], 'remove');
      await sock.sendMessage(from, { text: `✅ @${target.split('@')[0]} telah di-kick.`, mentions: [target] });
    }

    // Command: ytdl (placeholder)
    if (cmd === 'ytdl' || cmd === 'yt') {
      const url = body.slice(('/' + cmd).length).trim();
      if (!url) return sock.sendMessage(from, { text: '❌ Masukkan URL YouTube!' }, { quoted: m });
      await sock.sendMessage(from, { text: `⬇️ Mengunduh: ${url}\n(Implementasi butuh library ytdl-core / yt-dlp)` }, { quoted: m });
    }

      } catch (e) {
        console.error('Error command:', e);
        await sock.sendMessage(from, { text: `❌ Error: ${e.message}` }, { quoted: m });
      }
    }
  });

  
  // ─── Welcome Member Baru ──────────────────────────────────────────────────
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (action === 'add') {
      for (const participant of participants) {
        await sock.sendMessage(id, {
          text: `👋 Selamat datang @${participant.split('@')[0]}!\nSenang kamu bergabung 🎉`,
          mentions: [participant]
        });
      }
    }
  });


  console.log(`🚀 ${BOT_NAME} siap!`);
  return sock;
}

startBot().catch(console.error);
