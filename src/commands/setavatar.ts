import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
} from "discord.js";
import { setNextAvatar } from "../index"; // Import the function from index.ts
import { createInteractionFromMessage } from "../scripts/prefixAdapter";

// --- !! IMPORTANT !! ---
// PASTE YOUR DISCORD USER ID HERE
const YOUR_USER_ID = "1133781023134584938";
// PASTE YOUR SERVER (GUILD) ID HERE
const YOUR_GUILD_ID = "1425038775381266484";
// ---------------------

const cmd = {
  data: new SlashCommandBuilder()
    .setName("setavatar")
    .setDescription("Manually changes the bot's avatar to the next one in the queue.")
    .setDMPermission(false), // This prevents it from being used in DMs

  async execute(interaction: ChatInputCommandInteraction) {
    const isPrefix = (interaction as any).isPrefix;

    // --- SLASH COMMAND Permission Check ---
    // This check only runs for REAL slash commands.
    if (!isPrefix) {
      if (
        interaction.guildId !== YOUR_GUILD_ID ||
        interaction.user.id !== YOUR_USER_ID
      ) {
        return; // Silently fail for unauthorized slash command
      }
    }
    // --- End Slash Check ---

    // Acknowledge the command privately
    await interaction.deferReply({ ephemeral: true });

    try {
      // Call the exported function and wait for it to complete
      const newAvatarFile = await setNextAvatar();
      
      // --- Success Reply ---
      // Respond directly to the interaction ephemerally
      await interaction.editReply(
        `✅ Avatar successfully changed to \`${newAvatarFile}\`.`
      );
      // --- End Success Reply ---

    } catch (err) {
      // This 'catch' runs if the setNextAvatar() function fails
      console.error("Manual avatar change failed:", err);
      await interaction.editReply(
        "🔥 Failed to change avatar. Check console logs. (The bot might be rate-limited)."
      );
    }
  },

  async prefixExecute(message: Message, args: string[]) {
    // --- PREFIX COMMAND Permission Check ---
    // We check the ORIGINAL message object, which has the correct IDs.
    if (
      !message.guildId || // Check for DMs
      message.guildId !== YOUR_GUILD_ID || // Check for correct server
      message.author.id !== YOUR_USER_ID // Check for correct user
    ) {
      return; // Silently do nothing
    }
    // --- End Prefix Check ---

    // If permissions are good, create the fake interaction and call execute
    const interaction = createInteractionFromMessage(message, args);
    await (this as any).execute(interaction as any);
  },
};

export default cmd;