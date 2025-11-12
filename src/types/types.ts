// src/types.ts
import { Collection } from "discord.js";

declare module "discord.js" {
  interface Client {
    commands: Collection<string, any>;
    prefixCommands: Collection<string, any>;
  }
}