import { Client, GatewayIntentBits, Partials, Collection } from "discord.js";
import { DISCORD_TOKEN } from "./config";
import { CommandHandler } from "./handlers/CommandHandler";
import { EventHandler } from "./handlers/EventHandler";
import "./types/types";

// 1. Initialize Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// 2. Initialize State
export const previewMap = new Map<string, string>();

// 3. Initialize Handlers
const commandHandler = new CommandHandler(client);
const eventHandler = new EventHandler(client);

(async () => {
  // Load Commands & Events
  await commandHandler.loadCommands();
  eventHandler.loadEvents();

  // Login
  await client.login(DISCORD_TOKEN);
})();