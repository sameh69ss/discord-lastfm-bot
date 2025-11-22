// src/handlers/authHandler.ts
import { ButtonInteraction } from "discord.js";
import fetch from "node-fetch";
import crypto from "crypto";
import { linkUser } from "../scripts/storage";
import { LASTFM_API_KEY, LASTFM_SHARED_SECRET } from "../config";

function generateSignature(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params).sort();
  let stringToSign = "";
  for (const key of keys) {
    stringToSign += key + params[key];
  }
  stringToSign += secret;
  return crypto.createHash("md5").update(stringToSign).digest("hex");
}

export async function handleVerifyLogin(interaction: ButtonInteraction, token: string) {
  await interaction.deferReply({ ephemeral: true });

  try {
    if (!LASTFM_SHARED_SECRET) {
      await interaction.editReply("❌ Bot configuration error: Missing Shared Secret.");
      return;
    }

    const params: Record<string, string> = {
      api_key: LASTFM_API_KEY,
      method: "auth.getSession",
      token: token
    };

    const sig = generateSignature(params, LASTFM_SHARED_SECRET);
    const sessionUrl = `https://ws.audioscrobbler.com/2.0/?method=auth.getSession&api_key=${LASTFM_API_KEY}&token=${token}&api_sig=${sig}&format=json`;
    
    const res = await fetch(sessionUrl);
    const data = await res.json() as any;

    if (data.error) {
      if (data.error === 14) {
        await interaction.editReply("❌ You haven't authorized the app in your browser yet. Click the link, allow access, then click 'Verify' again.");
      } else if (data.error === 4 || data.error === 15) {
        await interaction.editReply("❌ Token expired. Please run `/link` again.");
      } else {
        await interaction.editReply(`❌ Last.fm Error: ${data.message}`);
      }
      return;
    }

    if (data.session) {
      const { name, key } = data.session;
      linkUser(interaction.user.id, name, key);
      
      await interaction.editReply(`✅ Success! Linked **${name}** to your Discord account.`);
      
      // Try to remove the buttons from the original message to clean up
      try {
        if (interaction.message) await interaction.message.edit({ components: [] });
      } catch {}
    }

  } catch (err) {
    console.error("Login verify error:", err);
    await interaction.editReply("❌ Internal error verifying login.");
  }
}