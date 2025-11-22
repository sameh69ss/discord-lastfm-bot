import { Client } from "discord.js";
import fs from "fs";
import path from "path";

export class EventHandler {
  private client: Client;
  private eventsPath: string;

  constructor(client: Client) {
    this.client = client;
    this.eventsPath = path.join(__dirname, "../events");
  }

  public loadEvents() {
    if (!fs.existsSync(this.eventsPath)) return;

    const eventFiles = fs
      .readdirSync(this.eventsPath)
      .filter((file) => file.endsWith(".ts") || file.endsWith(".js"));

    for (const file of eventFiles) {
      const filePath = path.join(this.eventsPath, file);
      const event = require(filePath).default ?? require(filePath);

      if (event.once) {
        this.client.once(event.name, (...args) => event.execute(...args));
      } else {
        this.client.on(event.name, (...args) => event.execute(...args));
      }
    }
    console.log(`✅ Loaded ${eventFiles.length} events.`);
  }
}