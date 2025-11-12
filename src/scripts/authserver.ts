// src/authserver.ts
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import "dotenv/config";
import { linkUser } from "./storage";
import { pendingAuth } from "../index";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

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

// ✏️ Update .env + callback.json
function updateEnvCallbackBase(publicUrl: string) {
  const envPath = ".env";
  const jsonPath = path.join(__dirname, "../../data/callback.json");
  let envData = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const newLine = `CALLBACK_BASE="${publicUrl}"`;

  if (envData.includes("CALLBACK_BASE="))
    envData = envData.replace(/CALLBACK_BASE=.*/g, newLine);
  else envData += `\n${newLine}\n`;

  fs.writeFileSync(envPath, envData, "utf8");
  fs.writeFileSync(jsonPath, JSON.stringify({ CALLBACK_BASE: publicUrl }, null, 2));

  console.log(`📝 Updated CALLBACK_BASE → ${publicUrl}`);
}

// 🚀 Start Express + Cloudflare Tunnel
app.listen(PORT, () => {
  console.log(`🌐 Local auth server running on http://localhost:${PORT}/callback`);

  const cloudflaredPath = "C:\\Users\\moha\\AppData\\Roaming\\npm\\cloudflared.cmd";
  const cloudflare = spawn("cmd.exe", [
    "/c",
    cloudflaredPath,
    "tunnel",
    "--url",
    `http://localhost:${PORT}`,
  ]);

  let outputBuffer = "";
  let foundUrl = false;

  const checkOutput = (chunk: Buffer) => {
    const text = chunk.toString();
    outputBuffer += text;
    process.stdout.write(text);

    const match = text.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
    if (match && !foundUrl) {
      foundUrl = true;
      const publicUrl = match[0];
      updateEnvCallbackBase(publicUrl);
      console.log(`✅ Cloudflare tunnel ready at: ${publicUrl}`);
    }
  };

  cloudflare.stdout.on("data", checkOutput);
  cloudflare.stderr.on("data", checkOutput);

  cloudflare.on("error", (err) =>
    console.error("🔥 Failed to start Cloudflare tunnel:", err)
  );

  cloudflare.on("close", (code) =>
    console.log(`⚠️ Cloudflare tunnel closed (code ${code})`)
  );
});
