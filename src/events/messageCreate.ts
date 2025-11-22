import { Events, Message } from "discord.js";
import { PREFIX } from "../config";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";

export default {
  name: Events.MessageCreate,
  once: false,
  async execute(message: Message) {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;

    const raw = message.content.slice(PREFIX.length).trim();
    const args: string[] = [];
    const re = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m[1]) args.push(m[1]);
      else if (m[2]) args.push(m[2]);
      else args.push(m[0]);
    }
    const commandName = args.shift()?.toLowerCase();
    if (!commandName) return;

    const client = message.client;
    const command = client.prefixCommands.get(commandName);
    
    if (!command) {
        await message.reply(`Unknown command: ${PREFIX}${commandName}`);
        return;
    }

    try {
      if (command.prefixExecute) return command.prefixExecute(message, args);
      if (command.execute)
        return command.execute(createInteractionFromMessage(message, args) as any);

      await message.reply("Command not executable via prefix.");
    } catch (err) {
      console.error(err);
      try { await message.reply("Error executing command."); } catch {}
    }
  },
};