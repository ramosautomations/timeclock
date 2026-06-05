# 🕐 TimeClock — Employee Time Tracking App

A self-hosted web app for employee clock-in/out with PIN access, overtime tracking, and admin reporting.

---

## Features
- **PIN-based login** — each employee has their own 4-digit PIN
- **Clock In / Clock Out** — live timer shows elapsed time
- **Overtime tracking** — flags >8h/day and >40h/week automatically
- **Bi-weekly pay periods** — admin can view any historical period
- **Admin dashboard** — see all employees, total hours, overtime, drill into daily entries
- **Add/remove employees** — right from the admin panel
- **Works anywhere** — runs as a web server, accessible on any device on your network (or internet)

---

## Default Logins

| Name           | PIN  | Role     |
|----------------|------|----------|
| Admin          | 0000 | Admin    |
| Alex Martinez  | 1111 | Employee |
| Sam Chen       | 2222 | Employee |
| Jordan Lee     | 3333 | Employee |
| Taylor Brooks  | 4444 | Employee |

**Change these PINs immediately!** (Use the Admin panel → Add Employee, then delete old ones)

---

## Setup & Run (Local / Home Network)

### Requirements
- Node.js 18+ (https://nodejs.org)

### Steps

```bash
# 1. Install dependencies
cd timeclock
npm install

# 2. Start the server
npm start

# 3. Open in browser
http://localhost:3000
```

To access from **other devices on your network**, find your computer's local IP:
- Mac: System Settings → Network → your IP (e.g. 192.168.1.42)
- Windows: `ipconfig` in terminal → IPv4 Address

Then visit `http://192.168.1.42:3000` from any phone, tablet, or computer on the same Wi-Fi.

---

## Deploy to the Internet (Free Options)

### Option A: Railway.app (Recommended — easiest)
1. Create a free account at https://railway.app
2. Click "New Project" → "Deploy from GitHub"
3. Push this folder to a GitHub repo, connect it
4. Railway auto-detects Node.js and deploys
5. You get a public URL like `https://timeclock-xyz.railway.app`

> **Note:** The SQLite database resets on redeploy with Railway's free tier.  
> For persistent data, upgrade to a paid plan or use Railway's Postgres addon and update `server.js` to use `pg` instead of `better-sqlite3`.

### Option B: Render.com
1. Sign up at https://render.com
2. New → Web Service → connect GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add a disk (Render → your service → Disks) mounted at `/app/data` for persistent SQLite

### Option C: Run on a home server / Raspberry Pi
```bash
# Install PM2 to keep it running
npm install -g pm2
pm2 start server.js --name timeclock
pm2 startup   # auto-start on reboot
pm2 save
```
Then use your router to forward port 3000 to the server's local IP.

---

## Overtime Rules

| Rule | Threshold |
|------|-----------|
| Daily OT | > 8 hours in a single shift |
| Weekly OT | > 40 hours in a Mon–Sun week |

Overtime shows with a ⚡ icon in both the employee view and admin reports.

---

## Data Storage

Data is stored in `data/timeclock.db` (SQLite). Back this file up regularly to preserve records.

---

## Customizing

- **Pay period anchor**: Change the `anchor` date in `getPayPeriods()` in `server.js`
- **OT threshold**: Change `2400` (40hrs in minutes) and `480` (8hrs) in `server.js`
- **Port**: Set `PORT` environment variable or change default in `server.js`
