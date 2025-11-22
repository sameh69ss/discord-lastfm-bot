import { Client, Events } from "discord.js";
import { cycleBotFeature } from "../scripts/avatarRotator";

export default {
  name: Events.ClientReady,
  once: true, // Run only once
  execute(client: Client) {
    console.log(`🟢 Logged in as ${client.user?.tag}`);
    
    // Start background tasks
    cycleBotFeature(client);
    setInterval(() => cycleBotFeature(client), 1800000);
  },
};