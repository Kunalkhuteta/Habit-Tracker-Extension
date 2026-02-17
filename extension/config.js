/* =========================================================
   config.js  —  Single source of truth for the API URL.

   HOW TO GO LIVE:
   1. Deploy your server (Railway / Render / any host)
   2. Change PROD_API_URL to your deployed URL
   3. Set IS_PRODUCTION = true
   4. Reload the extension

   That's the ONLY file you need to change.
========================================================= */

// ↓↓↓ PASTE YOUR RENDER URL HERE ↓↓↓
// Find it in: Render Dashboard → your service → top of the page
// Example: https://focus-tracker-api.onrender.com
const RENDER_URL = "https://habit-tracker-extension.onrender.com";

// Set to true since your server is deployed on Render
const IS_PRODUCTION = true;

const PROD_API_URL = RENDER_URL;
const DEV_API_URL  = "http://localhost:5000";

const API_BASE = IS_PRODUCTION ? PROD_API_URL : DEV_API_URL;