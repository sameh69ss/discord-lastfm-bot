// scripts/clear-guild-commands.ts
import "dotenv/config";
import { REST, Routes } from "discord.js";

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!);
const clientId = process.env.CLIENT_ID!;
const guildId = process.env.GUILD_ID!;

(async () => {
  try {
    console.log(`🧹 Clearing commands from guild ${guildId}...`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
    console.log("✅ Done — all guild commands removed!");
  } catch (err) {
    console.error("❌ Failed to clear guild commands:", err);
  }
})();
