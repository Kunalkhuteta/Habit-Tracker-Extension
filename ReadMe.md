# Focus Tracker

> A full-stack productivity Chrome Extension that tracks browsing time, blocks distractions, and delivers analytics — with a Node.js/Express backend, MongoDB Atlas, and cross-browser Google OAuth 2.0.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4f46e5?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-Express-16a34a?style=flat-square)
![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-15803d?style=flat-square)
![Google OAuth](https://img.shields.io/badge/Google-OAuth_2.0-dc2626?style=flat-square)
![Deployed](https://img.shields.io/badge/Deployed-Render.com-7c3aed?style=flat-square)

---

## Overview

Focus Tracker gives users deep visibility into their browsing habits. It tracks time per domain in real time, enforces distraction blocking via Chrome's `declarativeNetRequest` API, and renders analytics with productivity scoring on an interactive dashboard. A REST API backend on Render.com with MongoDB Atlas handles multi-user auth, category mappings, daily reflections, and theme preferences — all persisted across sessions and browser restarts.

---

## Tech Stack

| Layer | Technologies |
|---|---|
| **Extension** | Chrome MV3, Service Worker, `declarativeNetRequest`, `chrome.storage`, `chrome.alarms` |
| **Frontend** | HTML5, CSS3 (custom design system, CSS variables, dark/light mode), Vanilla JS ES2022 |
| **Charts** | Chart.js — horizontal bar with custom `barLabels` plugin, per-DPR canvas sizing |
| **Backend** | Node.js, Express.js, Mongoose ODM |
| **Database** | MongoDB Atlas |
| **Auth** | HMAC-SHA256 JWT (30-day), bcrypt (cost 12), Google OAuth 2.0 (web-popup, cross-browser) |
| **Email** | Nodemailer + Gmail SMTP (verification + OTP password reset) |
| **Deployment** | Render.com (server), MongoDB Atlas (DB), Google Cloud Console (OAuth) |

---

## Features

### ⏱ Real-Time Time Tracking
- Tracks active tab domain every second via background Service Worker
- Per-user storage keys (`timeData_<userId>`) prevent cross-account data leaks
- Time range views: Today, Yesterday, Last 7 Days, Last 30 Days
- Export full history as **JSON** or **CSV**

### 🔒 Focus & Distraction Blocking
- **Standard Focus** — 25-minute Pomodoro timer with browser notifications
- **Hard Focus** — user-defined duration; lock cannot be bypassed until timer expires
- Site blocking via `declarativeNetRequest` dynamic rules (no content script needed)
- Blocked sites synced between REST API and local storage with deduplication

### 📊 Analytics Dashboard
- Horizontal bar chart with fixed per-row height (fixes blurry first-render bug)
- Custom `barLabels` plugin with `clip: false` + right-padding to show time + % inline
- Productivity Score (0–100): Learning/Development weighted positive, Distractions negative
- Top 8 sites ranked by time with animated progress bars
- Custom categories with emoji, hex color, and mapped domains

### 🔐 Authentication & Security
- Email/password with **bcrypt** (cost 12) + email verification flow
- Custom **HMAC-SHA256** tokens — no external JWT library required
- **Google OAuth 2.0** via web-popup: works on Chrome, Edge, Firefox, Opera
- Rate limiting: 20 req/15 min (auth routes), 100 req/min (API routes)
- OTP password reset: 6-digit code, SHA-256 hashed, 10-minute expiry
- CORS whitelisted for `chrome-extension://`, `moz-extension://`, `ms-browser-extension://`

### 📓 Reflections & Preferences
- Daily journal with three prompts (distractions, wins, improvements)
- Weekly summary view with expand/collapse
- Theme (light/dark) + accent colour (6 options) synced server ↔ all extension pages

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│              CHROME EXTENSION (MV3)              │
│                                                  │
│  popup.html/js ──→ background.js (Service Worker)│
│       ↕                  ↕ chrome.storage.local  │
│  dashboard.html/js    auth.html/js               │
└──────────────────────┬──────────────────────────┘
                       │ HTTPS REST API
┌──────────────────────▼──────────────────────────┐
│           EXPRESS SERVER (Render.com)            │
│                                                  │
│  /auth/*          → JWT + bcrypt + Google OAuth  │
│  /blocked-sites/* → declarativeNetRequest sync   │
│  /categories/*    → domain → category mappings   │
│  /reflections/*   → daily journal entries        │
│  /preferences/*   → theme + accent persistence   │
└──────────────────────┬──────────────────────────┘
                       │ Mongoose ODM
┌──────────────────────▼──────────────────────────┐
│                 MONGODB ATLAS                    │
│  users · blockedsites · categorymappings         │
│  reflections · preferences                       │
└─────────────────────────────────────────────────┘
```

---

## Project Structure

```
focus-tracker/
├── extension/
│   ├── manifest.json         # MV3 manifest — permissions, service worker
│   ├── background.js         # Service Worker: tracking, blocking, focus timer
│   ├── dashboard.html/css/js # Analytics dashboard
│   ├── auth.html/js          # Login/signup + Google OAuth popup
│   ├── popup.html/js         # Browser action: quick stats + focus controls
│   ├── blocked.html          # Redirect shown on blocked sites
│   ├── config.js             # API_BASE constant (swap local ↔ prod)
│   └── chart.min.js          # Chart.js (bundled, no CDN dependency)
│
└── server/
    ├── server.js             # Express app: all routes, schemas, middleware
    └── .env                  # Secrets (see Environment Variables below)
```

---

## Local Development Setup

### 1. Install server dependencies

```bash
git clone https://github.com/yourusername/focus-tracker.git
cd focus-tracker/server
npm install
```

### 2. Create `.env`

```env
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/focus-tracker
JWT_SECRET=your-secret-min-32-chars
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxx
EMAIL_USER=yourapp@gmail.com
EMAIL_PASSWORD=your-gmail-app-password
PROD_URL=http://localhost:5000
PORT=5000
```

### 3. Start the server

```bash
node server.js
# → 🚀 Server running on port 5000
```

### 4. Configure the extension

```js
// extension/config.js
const API_BASE = 'http://localhost:5000';
```

### 5. Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer Mode**
3. Click **Load unpacked** → select the `extension/` folder

### 6. Google OAuth (Google Cloud Console)

- Create a **Web Application** OAuth 2.0 credential (not "Chrome Extension" type)
- Add Authorized redirect URI: `http://localhost:5000/auth/google/callback`
- Verify config at: `http://localhost:5000/auth/google/debug`

---

## Production Deployment (Render.com)

1. Push `server/` to GitHub and connect to Render as a **Web Service**
2. Add all `.env` variables in Render → **Environment**
3. Set `PROD_URL = https://your-app.onrender.com` (no trailing slash)
4. Add `https://your-app.onrender.com/auth/google/callback` to Google Cloud Console
5. Update `config.js` to point to the production URL before packaging the extension
6. Server self-pings every 14 minutes to prevent Render free-tier sleep

---

## API Reference

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/signup` | ✗ | Register with email + password; sends verification email |
| `POST` | `/auth/login` | ✗ | Authenticate; returns HMAC-SHA256 JWT |
| `POST` | `/auth/google` | ✗ | Sign in via Google access token (chrome.identity fallback) |
| `GET` | `/auth/google/popup` | ✗ | Initiate cross-browser web OAuth popup |
| `GET` | `/auth/google/callback` | ✗ | Exchange auth code; return JWT via postMessage |
| `POST` | `/auth/forgot-password` | ✗ | Send 6-digit OTP (SHA-256 hashed, 10-min expiry) |
| `POST` | `/auth/reset-password` | ✗ | Verify OTP + set new bcrypt password |
| `GET` | `/auth/me` | ✓ | Validate token; return user profile |
| `GET` | `/blocked-sites` | ✓ | List blocked domains |
| `POST` | `/blocked-sites` | ✓ | Add a domain to block list |
| `DELETE` | `/blocked-sites/:site` | ✓ | Remove a blocked domain |
| `GET` | `/categories` | ✓ | Get all domain → category mappings |
| `POST` | `/categories` | ✓ | Create / update a domain mapping |
| `DELETE` | `/categories/:domain` | ✓ | Remove a domain mapping |
| `GET` | `/reflections` | ✓ | Get reflections (supports `?startDate=&endDate=`) |
| `POST` | `/reflections` | ✓ | Save daily reflection (upsert by date) |
| `GET` | `/preferences` | ✓ | Get theme + accentColor |
| `POST` | `/preferences` | ✓ | Save theme + accentColor |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | ✅ | MongoDB Atlas connection string |
| `JWT_SECRET` | ✅ | HMAC-SHA256 signing secret — min 32 chars |
| `GOOGLE_CLIENT_ID` | ✅ | Web Application OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | OAuth client secret — required for code exchange |
| `EMAIL_USER` | ✅ | Gmail address for transactional email |
| `EMAIL_PASSWORD` | ✅ | Gmail App Password (requires 2FA enabled) |
| `PROD_URL` | ✅ | Public server URL — no trailing slash |
| `PORT` | ✗ | Server port (default: 5000) |
| `ALLOWED_ORIGINS` | ✗ | Comma-separated CORS origins override |

---

## Known Limitations

- `chrome.identity` is Chrome-only; other browsers use the web popup OAuth flow
- Render free tier may have ~15 s cold starts (self-ping mitigates but doesn't eliminate)
- Service Workers are throttled by Chrome when the browser is minimised — tracking may drift slightly
- Hard Focus has no OS-level enforcement; uninstalling the extension bypasses it

---

## License

MIT — see [LICENSE](LICENSE)

---

