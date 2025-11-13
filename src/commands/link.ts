import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
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
      } catch {}
    }

    try {
      const state = crypto.randomUUID();
      pendingAuth.set(state, interaction.user.id);

      const CALLBACK_BASE =
        process.env.CALLBACK_URL?.replace(/\/callback$/, "") ||
        "https://discord-lastfm-bot-production.up.railway.app";

      const authUrl = `https://www.last.fm/api/auth/?api_key=${LASTFM_API_KEY}&cb=${CALLBACK_BASE}/callback?state=${state}`;

      const embed = new EmbedBuilder()
        .setTitle("Link Your Last.fm Account")
        .setDescription("Click the button below to log in and link your account.")
        .setColor(0xff0000)
        .setFooter({ text: "Last.fm Account Linking" });

      const button = new ButtonBuilder()
        .setLabel("Login with Last.fm")
        .setStyle(ButtonStyle.Link)
        .setURL(authUrl);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

      // Try to DM the user the link
      try {
        await interaction.user.send({ embeds: [embed], components: [row] });
      } catch {
        return interaction.reply({
          content:
            "⚠️ I couldn’t DM you the login link. Please enable DMs and try again.",
          ephemeral: true,
        });
      }

      // Respond in chat (ephemeral if slash)
      if (isPrefix) {
        await interaction.reply({
          content: "✅ Check your DMs for the Last.fm login link!",
        });
      } else {
        await interaction.reply({
          content: "✅ Check your DMs for the Last.fm login link!",
          ephemeral: true,
        });
      }
    } catch (err) {
      console.error("Link error:", err);
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
