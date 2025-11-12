// src/commands/link.ts
import { SlashCommandBuilder, ChatInputCommandInteraction, Message, TextChannel } from "discord.js";
import crypto from "crypto";
import fs from "fs";
import { LASTFM_API_KEY} from "../index";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import path from "path";
import { pendingAuth } from "../scripts/sharedState";

const cmd = {
  data: new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Last.fm account to Discord"),
  async execute(interaction: ChatInputCommandInteraction) {
    const isPrefix = (interaction as any).isPrefix;
    if (isPrefix) {
      try {
        (interaction.channel as TextChannel).sendTyping();
      } catch (err) {
        console.warn("Typing indicator failed:", err);
      }
    }

    try {
      const state = crypto.randomUUID();
      pendingAuth.set(state, interaction.user.id);

  let CALLBACK_BASE = process.env.CALLBACK_BASE;
  try {
    // --- THIS IS THE FIX ---
    const jsonPath = path.join(__dirname, "../../data/callback.json");
    const fileData = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    // --- END FIX ---

    CALLBACK_BASE = fileData.CALLBACK_BASE || CALLBACK_BASE;
  } catch (e) {
    console.warn("⚠️ Could not read callback.json, falling back to .env value.");
  }

      const authUrl = `https://www.last.fm/api/auth/?api_key=${LASTFM_API_KEY}&cb=${CALLBACK_BASE}/callback?state=${state}`;

      if (isPrefix) {
        // Add artificial delay to mimic processing time (5+ seconds)
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      await interaction.reply({
        content: `🔗 Click to link your Last.fm account:\n${authUrl}`,
        ephemeral: true,
      });
    } catch (err) {
      console.error("Overall link error:", err);
      const content = "⚠️ Failed to generate link.";
      if (isPrefix) {
        await interaction.reply({ content });
      } else if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content, ephemeral: true });
      } else {
        await interaction.editReply({ content });
      }
    }
  },
  async prefixExecute(message: Message, args: string[]) {
    const interaction = createInteractionFromMessage(message, args);
    await (this as any).execute(interaction as any);
  },
};

export default cmd;