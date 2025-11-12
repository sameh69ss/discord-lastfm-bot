// src/commands/unlink.ts
import { SlashCommandBuilder, ChatInputCommandInteraction, Message, TextChannel } from "discord.js";
import { getUser, unlinkUser } from "../scripts/storage";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";

const cmd = {
  data: new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Unlink your Last.fm account"),
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
      const user = getUser(interaction.user.id);

      if (!user) {
        const content = "ℹ️ You don’t have a linked Last.fm account.";
        if (isPrefix) {
          await interaction.reply({ content });
        } else {
          await interaction.reply({ content, ephemeral: true });
        }
        return;
      }

      unlinkUser(interaction.user.id);
      const content = "🧹 Successfully unlinked your Last.fm account.";

      if (isPrefix) {
        // Add artificial delay to mimic processing time (5+ seconds)
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      await interaction.reply({
        content,
        ephemeral: true,
      });
    } catch (err) {
      console.error("Overall unlink error:", err);
      const content = "⚠️ Failed to unlink.";
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