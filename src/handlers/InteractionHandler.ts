import { Interaction, CacheType, Events } from "discord.js";
import { handleGenrePicker } from "./genrePickerHandler";
import { handleVerifyLogin } from "./authHandler";
import { handlePreview } from "./previewHandler";

export async function handleInteraction(interaction: Interaction<CacheType>) {
  // 1. Chat Commands (Slash)
  if (interaction.isChatInputCommand()) {
    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(err);
      if (!interaction.replied && !interaction.deferred)
        await interaction.reply({ content: "Error executing command.", ephemeral: true });
    }
  }

  // 2. Buttons
  else if (interaction.isButton()) {
    const [customId, ...args] = interaction.customId.split(":");

    if (customId === "verify_login") {
      await handleVerifyLogin(interaction, args[0]);
    }
    else if (customId === "preview") {
      await handlePreview(interaction, args[0]);
    }
  }

  // 3. Select Menus
  else if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'genre-picker') {
      await handleGenrePicker(interaction);
    }
  }
}