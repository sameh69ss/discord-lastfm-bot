// src/commands/help.ts
import { SlashCommandBuilder, ChatInputCommandInteraction, Message, EmbedBuilder, TextChannel } from "discord.js";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";

// Avoid importing PREFIX from ../index to prevent a circular import during command registration.
// Use the environment value directly with a fallback.
const PREFIX = process.env.PREFIX || ".fm";

async function execute(interaction: ChatInputCommandInteraction) {
  const isPrefix = (interaction as any).isPrefix;
  if (isPrefix) {
    try {
      (interaction.channel as TextChannel).sendTyping();
    } catch (err) {
      console.warn("Typing indicator failed:", err);
    }
  }

  try {
    const embed = new EmbedBuilder()
      .setTitle("Bot Commands")
      .setDescription(
        isPrefix
          ? `Here are the available commands (prefix: \`${PREFIX}\`):\n` +
            interaction.client.prefixCommands
              .map((cmd: { data: { name: string; description: string } }) => `**${PREFIX} ${cmd.data.name}**: ${cmd.data.description}`)
              .join("\n") || "No prefix commands available."
          : "Here are the available slash commands:\n" +
            interaction.client.commands
              .map((cmd: { data: { name: string; description: string } }) => `**/${cmd.data.name}**: ${cmd.data.description}`)
              .join("\n") || "No commands available."
      )
      .setColor("#ff0000");

    if (isPrefix) {
      // Add artificial delay to mimic processing time (5+ seconds)
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    if (isPrefix) {
      await interaction.reply({ embeds: [embed] });
    } else {
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  } catch (err) {
    console.error("Overall help error:", err);
    const content = "⚠️ Failed to fetch command list.";
    if (isPrefix) {
      await interaction.reply({ content });
    } else if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content, ephemeral: true });
    } else {
      await interaction.editReply({ content });
    }
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("List all available commands."),

  async execute(interaction: ChatInputCommandInteraction) {
    await execute(interaction);
  },

  async prefixExecute(message: Message, args: string[]) {
    const interaction = createInteractionFromMessage(message, args);
    await execute(interaction as any);
  },
};