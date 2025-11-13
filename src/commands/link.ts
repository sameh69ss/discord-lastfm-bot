import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  TextChannel,
} from "discord.js";
import crypto from "crypto";
import { LASTFM_API_KEY } from "../index";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
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
      // Create a random state and map it to the user ID
      const state = crypto.randomUUID();
      pendingAuth.set(state, interaction.user.id);

      // Get callback base from environment (Railway)
      const CALLBACK_BASE =
        process.env.CALLBACK_URL?.replace(/\/callback$/, "") ||
        "https://discord-lastfm-bot-production.up.railway.app";

      // Construct Last.fm authorization link
      const authUrl = `https://www.last.fm/api/auth/?api_key=${LASTFM_API_KEY}&cb=${CALLBACK_BASE}/callback?state=${state}`;

      if (isPrefix) {
        // Add artificial delay to mimic processing time
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      await interaction.reply({
        content: `🔗 Click below to link your Last.fm account:\n${authUrl}`,
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
