# ⏱️ Focus Tracker & Sites Blocker Extension

> A privacy-first Chrome extension that tracks where your time actually goes — and helps you take it back.

Focus Tracker runs silently in the background, recording every site you visit and how long you spend there. It categorises your browsing into **Learning**, **Development**, **Distraction**, and custom categories you define, then surfaces the data in a clean dashboard with a productivity score, top-sites chart, daily reflections, and focus-mode blocking. All data syncs to your own backend — no third-party analytics, no ads.

---

## Features

| Feature | Description |
|---|---|
|  **Automatic time tracking** | Records time per domain continuously — no idle gaps, no missed sessions |
|  **Live dashboard** | Real-time chart, category breakdown, top-sites list, and productivity score |
|  **Focus mode** | Blocks distracting sites during work sessions; hard-lock mode prevents early stops |
|  **Custom categories** | Create your own categories with custom name, emoji, colour, and domain list |
|  **Daily reflections** | End-of-day journal with weekly summary view |
|  **Auth** | Email/password signup + Google OAuth — JWT-based sessions |
|  **Cloud sync** | All blocked sites, categories, and reflections sync to MongoDB via a Node.js backend |
|  **Themes** | Light/dark mode + accent colour picker |
|  **Export** | Download your data as JSON or CSV any time |

---

##  Project Structure

```
focus-tracker/
├── extension/
│   ├── manifest.json          # MV3 Chrome extension manifest
│   ├── background.js          # Service worker — time tracking, focus mode, blocking
│   ├── dashboard.html         # Main popup UI
│   ├── dashboard.js           # Dashboard logic — charts, categories, sync
│   ├── auth.html / auth.js    # Login & signup screens
│   ├── blocked.html           # Redirect page shown when a site is blocked
│   ├── config.js              # API_BASE URL constant
│   └── icon.png
└── server/
    └── server.js              # Express + MongoDB backend (Node.js)
```

---

##  Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/your-username/focus-tracker.git
cd focus-tracker
```

### 2. Set up the backend

```bash
cd server
npm install
```

Create a `.env` file in the `server/` directory:

```env
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/focus-tracker
JWT_SECRET=your-super-secret-key-here
EMAIL_USER=you@gmail.com
EMAIL_PASSWORD=your-gmail-app-password
GOOGLE_CLIENT_ID=your-google-oauth-client-id
PROD_URL=https://your-render-app.onrender.com
PORT=5000
ALLOWED_ORIGINS=chrome-extension://your-extension-id,http://localhost:3000
```

Start the server:

```bash
node server.js
```

### 3. Configure the extension

In `extension/config.js`, set your backend URL:

```js
const API_BASE = "https://your-render-app.onrender.com";
```

### 4. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder

---

##  Backend API Reference

All protected routes require `Authorization: Bearer <token>` header.

### Auth

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/auth/signup` | Register with email + password |
| `POST` | `/auth/login` | Login, returns JWT |
| `POST` | `/auth/google` | Google OAuth login via access token |
| `GET` | `/auth/verify-email` | Email verification link handler |
| `POST` | `/auth/forgot-password` | Sends OTP reset code |
| `POST` | `/auth/reset-password` | Validates OTP, sets new password |
| `GET` | `/auth/me` | Returns current user info |
| `POST` | `/auth/logout` | Logout (client-side token removal) |

### Blocked Sites

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/blocked-sites` | List all blocked domains |
| `POST` | `/blocked-sites` | Add a domain to the blocklist |
| `DELETE` | `/blocked-sites/:site` | Remove a domain |

### Categories

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/categories` | List all domain→category mappings |
| `POST` | `/categories` | Map a domain to a category |
| `DELETE` | `/categories/:domain` | Remove a domain mapping |

Valid category values: `Learning`, `Development`, `Distraction`, `Other`, or any custom name string.

### Reflections

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/reflections` | List reflections (supports `?startDate=&endDate=`) |
| `GET` | `/reflections/:date` | Get a single day's reflection |
| `POST` | `/reflections` | Save or update a reflection |

### Preferences

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/preferences` | Get theme + accent colour |
| `POST` | `/preferences` | Update theme + accent colour |

---

##  How Time Tracking Works

The background service worker (`background.js`) tracks the active tab's domain every second with no idle pause — if your browser is open on a page, that page is counted. Data is buffered in memory and flushed to `chrome.storage.local` every 3 seconds to minimise write overhead.

The MV3 service worker keepalive strategy combines two techniques to prevent Chrome from killing the worker:

- **`chrome.alarms`** fires every ~24 seconds to resurrect the worker if Chrome already killed it
- **Storage heartbeat** writes to `chrome.storage.local` every 20 seconds while alive, resetting Chrome's 30-second idle timer

Category resolution works by checking the domain against server-synced mappings first, then falling back to keyword matching for common sites (e.g. `youtube.com` → Distraction, `github.com` → Development).

---

## 🛡️ Focus Mode

Focus mode uses Chrome's `declarativeNetRequest` API to redirect blocked domains to `blocked.html` in real time — no content scripts required.

**Normal focus** — starts a 25-minute session, can be stopped at any time.

**Hard focus** — locks the session for a user-specified duration. The stop button is disabled until the timer expires. Survives service worker restarts by persisting `focusLockUntil` to storage.

---

##  Data Storage

| Where | What |
|---|---|
| `chrome.storage.local` | `timeData` (per-day per-domain ms), `authToken`, `blockedSites` (local cache), `catCustomizations` (colours/emojis), focus state |
| MongoDB (server) | Users, blocked sites, category mappings, reflections, preferences |

Time data is stored under date keys (`YYYY-MM-DD`) so historical data is preserved and range queries (today / yesterday / 7 days / 30 days) work without extra server calls.

---

##  Deploying to Render (Free Tier)

1. Push `server/server.js` to a GitHub repo
2. Create a new **Web Service** on [render.com](https://render.com)
3. Set the environment variables from the `.env` section above
4. The server includes a built-in self-ping every 14 minutes to prevent Render's free-tier spindown

---

##  Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | ✅ | MongoDB Atlas connection string |
| `JWT_SECRET` | ✅ | Secret for signing auth tokens |
| `EMAIL_USER` | ⚠️ optional | Gmail address for verification emails |
| `EMAIL_PASSWORD` | ⚠️ optional | Gmail app password (not your login password) |
| `GOOGLE_CLIENT_ID` | ⚠️ optional | Google OAuth 2.0 client ID |
| `PROD_URL` | ⚠️ optional | Your deployed server URL (enables self-ping) |
| `ALLOWED_ORIGINS` | ⚠️ optional | Comma-separated list of allowed CORS origins |
| `PORT` | ⚠️ optional | Defaults to `5000` |

> **Gmail note:** Use an [App Password](https://support.google.com/accounts/answer/185833), not your account password. Requires 2FA to be enabled on your Google account.

---

##  Tech Stack

**Extension**
- Manifest V3 Chrome Extension
- Vanilla JS — no build step required
- Chart.js for the time breakdown chart
- `chrome.declarativeNetRequest` for site blocking
- `chrome.alarms` + `chrome.storage` for keepalive

**Backend**
- Node.js + Express
- MongoDB + Mongoose
- bcryptjs — password hashing
- nodemailer — transactional email
- google-auth-library — Google OAuth token verification
- express-rate-limit — brute-force protection

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-idea`
3. Commit your changes: `git commit -m 'Add your feature'`
4. Push and open a Pull Request

Please keep pull requests focused — one feature or fix per PR.

---

##  License

MIT — Kunal Khuteta

---

<p align="center">Built to help you work with intention, not just activity.</p>