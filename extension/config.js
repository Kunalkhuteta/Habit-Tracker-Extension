/* =========================================================
   config.js  —  Single source of truth for the API URL.

   HOW TO GO LIVE:
   1. Deploy your server (Railway / Render / any host)
   2. Change PROD_API_URL to your deployed URL
   3. Set IS_PRODUCTION = true
   4. Reload the extension

   That's the ONLY file you need to change.
========================================================= */

const IS_PRODUCTION = true; // ← flip to true when deployed

const PROD_API_URL = "https://habit-tracker-extension.onrender.com"; // ← your deployed URL here
const DEV_API_URL  = "http://localhost:5000";

const API_BASE = IS_PRODUCTION ? PROD_API_URL : DEV_API_URL;