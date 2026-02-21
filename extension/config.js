
const RENDER_URL = "https://habit-tracker-extension.onrender.com";

// Set to true since your server is deployed on Render
const IS_PRODUCTION = true;

const PROD_API_URL = RENDER_URL;
const DEV_API_URL  = "http://localhost:5000";

const API_BASE = IS_PRODUCTION ? PROD_API_URL : DEV_API_URL;