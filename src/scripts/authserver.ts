// src/authserver.ts
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import "dotenv/config";
import { linkUser } from "./storage";
import { pendingAuth } from "./sharedState";
// Removed 'spawn', 'fs', and 'path' imports, as Docker Compose handles this now.

const app = express();
const PORT = 8080;

const { LASTFM_API_KEY, LASTFM_SHARED_SECRET } = process.env;

if (!LASTFM_API_KEY || !LASTFM_SHARED_SECRET) {
  console.error("❌ Missing Last.fm keys in environment variables.");
  process.exit(1);
}

interface LastfmSessionResponse {
  session?: { name: string; key: string };
  error?: number;
  message?: string;
}

// 🔗 Handle Last.fm callback
app.get("/callback", async (req, res) => {
  const token = req.query.token as string | undefined;
  const state = req.query.state as string | undefined;

  if (!token || !state) {
    res.status(400).send("Missing token or state.");
    return;
  }

  const uid = pendingAuth.get(state);
  if (!uid) {
    res.status(400).send("Invalid or expired state token.");
    return;
  }

  const sig = crypto
    .createHash("md5")
    .update(
      `api_key${LASTFM_API_KEY}methodauth.getSessiontoken${token}${LASTFM_SHARED_SECRET}`
    )
    .digest("hex");

  try {
    const response = await fetch(
      `https://ws.audioscrobbler.com/2.0/?method=auth.getSession&api_key=${LASTFM_API_KEY}&token=${token}&api_sig=${sig}&format=json`
    );

    const data = (await response.json()) as LastfmSessionResponse;

    if (!data.session) {
      console.error("⚠️ Failed to get session from Last.fm:", data);
      res.status(400).send(`Failed to link account. ${data.message || ""}`);
      return;
    }

    const { name: username, key: sessionKey } = data.session;
    linkUser(uid, username, sessionKey);
    pendingAuth.delete(state);

    console.log(`✅ Linked Discord user ${uid} → Last.fm user ${username}`);

    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; margin-top: 3em;">
          <h2>تم تهكير جهازك بنجاح يرياسة</h2>
          <p>نهارك سعيد.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("🔥 Error during session exchange:", err);
    res.status(500).send("Internal Server Error while linking account.");
  }
});

// 🚀 Start Express
// All the old logic for spawning cloudflared and updating .env is removed.
// Docker Compose now handles the tunnel.
app.listen(PORT, () => {
  console.log(`🌐 Local auth server running on http://localhost:${PORT}/callback`);
  console.log("   Waiting for Cloudflared service to connect...");
});