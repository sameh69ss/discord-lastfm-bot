// src/authserver.ts
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import "dotenv/config";
import { linkUser } from "./storage";
import { pendingAuth } from "./sharedState";

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const CALLBACK_URL = process.env.CALLBACK_URL || "https://discord-lastfm-bot-production.up.railway.app/callback";

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

// ✅ Health check (optional but useful for Railway)
app.get("/", (_, res) => {
  res.send("✅ Auth server running");
});

// 🔗 Handle Last.fm callback
app.get("/callback", async (req, res) => {
  const token = req.query.token as string | undefined;
  const state = req.query.state as string | undefined;

  if (!token || !state) {
    return res.status(400).send("Missing token or state.");
  }

  const uid = pendingAuth.get(state);
  if (!uid) {
    return res.status(400).send("Invalid or expired state token.");
  }

  const sig = crypto
    .createHash("md5")
    .update(`api_key${LASTFM_API_KEY}methodauth.getSessiontoken${token}${LASTFM_SHARED_SECRET}`)
    .digest("hex");

  try {
    const response = await fetch(
      `https://ws.audioscrobbler.com/2.0/?method=auth.getSession&api_key=${LASTFM_API_KEY}&token=${token}&api_sig=${sig}&format=json`
    );

    const data = (await response.json()) as LastfmSessionResponse;

    if (!data.session) {
      console.error("⚠️ Failed to get session from Last.fm:", data);
      return res.status(400).send(`Failed to link account. ${data.message || ""}`);
    }

    const { name: username, key: sessionKey } = data.session;
    linkUser(uid, username, sessionKey);
    pendingAuth.delete(state);

    console.log(`✅ Linked Discord user ${uid} → Last.fm user ${username}`);

    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; margin-top: 3em;">
          <h2>تم تهكير ديك ام جهازك</h2>
          <p>اجري من هنا قبل ما انشر صورك عالانترنت</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("🔥 Error during session exchange:", err);
    res.status(500).send("Internal Server Error while linking account.");
  }
});

// 🚀 Start Express server on all interfaces (needed for Railway)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Auth server running on port ${PORT}`);
  console.log(`Callback URL: ${CALLBACK_URL}`);
});
