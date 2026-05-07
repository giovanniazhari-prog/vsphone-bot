# vsphone-bot

Telegram bot untuk manage proxy settings pada cloud phone vsphone.

## Fitur

- `/devices` — Lihat semua cloud phone dan status proxy-nya
- `/setproxy <padCode> <proxy>` — Set proxy ke satu device
- `/setproxy_all <proxy>` — Set proxy ke semua device sekaligus
- `/clearproxy <padCode>` — Hapus proxy dari device
- `/clearproxy_all` — Hapus proxy dari semua device
- `/settoken <token>` — Set vsphone session token manual
- `/login` — Login ke vsphone (butuh env credentials)
- `/status` — Cek status token saat ini

## Format Proxy yang Didukung

```
http://user:pass@host:port
socks5://user:pass@host:port
host:port:user:pass
```

## Setup

### 1. Environment Variables

Copy `.env.example` → `.env` dan isi:

| Variable | Keterangan |
|---|---|
| `BOT_TOKEN` | Token dari @BotFather |
| `VSPHONE_TOKEN` | Session token vsphone (dari browser) |
| `VSPHONE_EMAIL` | Email akun vsphone |
| `VSPHONE_PASSWORD` | Password akun vsphone |
| `ALLOWED_USER_IDS` | Telegram user ID yang boleh akses (kosong = semua) |

### 2. Cara dapat VSPHONE_TOKEN

1. Buka [cloud.vsphone.com](https://cloud.vsphone.com) di browser
2. Login ke akun vsphone
3. Tekan **F12** → tab **Network**
4. Klik request apapun ke `api.vsphone.com`
5. Di **Request Headers**, copy nilai header **`Token`**
6. Set ke env `VSPHONE_TOKEN` atau gunakan `/settoken` di bot

### 3. Deploy ke Railway

1. Fork/import repo ini ke Railway
2. Set semua environment variables di Railway dashboard
3. Deploy

### 4. Run Lokal

```bash
npm install
cp .env.example .env
# edit .env
node bot.js
```
