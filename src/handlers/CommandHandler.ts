import { Client, REST, Routes, Collection } from "discord.js";
import fs from "fs";
import path from "path";
import { CLIENT_ID, GUILD_ID, DISCORD_TOKEN } from "../config";

export class CommandHandler {
  private client: Client;
  private commandsPath: string;

  constructor(client: Client) {
    this.client = client;
    this.commandsPath = path.join(__dirname, "../commands");
  }

  public async loadCommands() {
    this.client.commands = new Collection();
    this.client.prefixCommands = new Collection();
    const commandDefs: any[] = [];

    // 1. Read command files
    const commandFiles = fs
      .readdirSync(this.commandsPath)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".js"));

    for (const file of commandFiles) {
      const filePath = path.join(this.commandsPath, file);
      // Handle both default exports and named exports
      const cmd = require(filePath).default ?? require(filePath);

      // Slash Commands
      if (cmd.data && cmd.execute) {
        this.client.commands.set(cmd.data.name, cmd);
        commandDefs.push(cmd.data.toJSON());
      }

      // Prefix Commands
      if (cmd.prefixExecute) {
        this.client.prefixCommands.set(cmd.data.name, cmd);
      }
    }

    // 2. Register with Discord API
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

    try {
      console.log(`⏳ Registering ${commandDefs.length} slash commands...`);
      
      const route = GUILD_ID
        ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
        : Routes.applicationCommands(CLIENT_ID);

      // If using Guild commands, we clean up first to avoid duplicates
      if (GUILD_ID) {
        const existing = (await rest.get(route)) as any[];
        for (const cmd of existing) {
           const deleteRoute = `${Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)}/${cmd.id}`;
           await rest.delete(deleteRoute as any);
        }
      }

      await rest.put(route, { body: commandDefs });
      console.log("✅ Slash commands registered successfully.");
    } catch (err) {
      console.error("🔥 Failed to register commands:", err);
    }
  }
}