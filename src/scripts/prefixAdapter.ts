// src/scripts/prefixAdapter.ts
import { Message } from "discord.js";

type ArgMap = { [k: string]: string };

export function parseArgs(input: string | string[]): { map: ArgMap; unnamed: string[] } {
  const map: ArgMap = {};
  const unnamed: string[] = [];
  let tokens: string[] = [];

  if (typeof input === "string") {
    const raw = input.trim();
    const re = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      if (m[1] !== undefined) tokens.push(m[1]);
      else if (m[2] !== undefined) tokens.push(m[2]);
      else tokens.push(m[0]);
    }
  } else {
    tokens = input.slice();
  }

  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (!a) continue;

    if (a.startsWith("--")) {
      const after = a.slice(2);
      const eqIdx = after.indexOf("=");
      const colonIdx = after.indexOf(":");
      if (eqIdx !== -1) {
        const k = after.slice(0, eqIdx);
        const v = after.slice(eqIdx + 1);
        map[k] = v;
        continue;
      }
      if (colonIdx !== -1) {
        const k = after.slice(0, colonIdx);
        const v = after.slice(colonIdx + 1);
        map[k] = v;
        continue;
      }

      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        map[after] = next;
        i++;
      } else {
        map[after] = "true";
      }
      continue;
    }

    if (a.startsWith("-") && a.length > 1 && !a.startsWith("--")) {
      const flags = a.slice(1).split("");
      for (const f of flags) map[f] = "true";
      continue;
    }

    if (a.includes("=")) {
      const [k, v] = a.split(/=(.+)/);
      map[k] = v;
      continue;
    }
    if (a.includes(":")) {
      const [k, v] = a.split(/:(.+)/);
      map[k] = v;
      continue;
    }

    unnamed.push(a);
  }

  return { map, unnamed };
}

async function sendWithRetry(channel: any, payload: any, maxRetries = 3): Promise<any> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const sent = await channel.send(payload);
      return sent;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError || new Error("All send retries failed");
}

export function createInteractionFromMessage(message: Message, args: string[]) {
  const { map, unnamed } = parseArgs(args || []);

  let deferredMessage: Message | null = null;

  const user = Object.create(message.author);
  Object.defineProperty(user, "displayName", {
    value: message.member?.displayName ?? message.author.username,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  const interaction: any = {
    id: message.id,
    user,
    member: message.member,
    guild: message.guild,
    channel: message.channel,
    client: message.client,
    replied: false,
    deferred: false,
    isPrefix: true,
    isChatInputCommand: () => true,

    options: {
      getString: (name: string) => {
        // Find by --name=value
        let val: string | undefined = map[name];
        
        // If not found, and it's the 'period' option, check unnamed[0]
        if (val === undefined && name === 'period' && unnamed.length > 0) {
            val = unnamed[0];
        } 
        // For any other option, default to joining all unnamed args
        else if (val === undefined) {
            val = unnamed.length > 0 ? unnamed.join(" ") : undefined;
        }

        if (typeof val === "string") val = val.trim();
        return val;
      },

      getBoolean: (name: string) => {
        const v = map[name];
        if (v === undefined) return undefined;
        const s = String(v).toLowerCase();
        if (s === "true" || s === "1" || s === "yes") return true;
        if (s === "false" || s === "0" || s === "no") return false;
        return undefined;
      },

      getUser: (name: string) => {
        // Ignore reply mentions entirely.
        // Only detect typed mentions like ".fm @user"
        const typedMention = message.content.match(/<@!?(\d+)>/);
        if (typedMention) {
          const id = typedMention[1];
          return message.client.users.cache.get(id) ?? message.author;
        }

        // Handle raw IDs or names from args
        const id = map[name] ?? unnamed[0];
        if (id) {
          const cleaned = id.replace(/[^0-9]/g, "");
          return message.client.users.cache.get(cleaned) ?? message.author;
        }

        // Default: command caller
        return message.author;
      },
    },

    deferReply: async () => {
      if (interaction.isPrefix) {
        interaction.deferred = true;
        return;
      }
      interaction.deferred = true;
      try {
        deferredMessage = await message.reply({ content: "⏳ Working..." });
      } catch {
        deferredMessage = null;
      }
    },

    editReply: async (payload: any) => {
      interaction.replied = true;
      try {
        if (deferredMessage) {
          return await deferredMessage.edit(payload as any);
        }
        if (interaction.isPrefix) {
          return await sendWithRetry(message.channel, payload);
        }
        return await message.reply(payload as any);
      } catch {
        try {
          if (interaction.isPrefix) {
            return await sendWithRetry(message.channel, typeof payload === "string" ? payload : payload.content ?? "");
          }
          return await message.reply(typeof payload === "string" ? payload : payload.content ?? "");
        } catch {
          return null;
        }
      }
    },

    reply: async (payload: any) => {
      interaction.replied = true;
      if (interaction.isPrefix) {
        return await sendWithRetry(message.channel, payload);
      }
      return await message.reply(payload as any);
    },
  };

  return interaction;
}