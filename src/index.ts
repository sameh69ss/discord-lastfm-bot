// env + core imports
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Collection,
  Events,
  Partials,
} from "discord.js";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import "./types/types";
import { createInteractionFromMessage } from "./scripts/prefixAdapter";
import sendVoice from "./scripts/sendVoice";
import { downloadAndConvert } from "./scripts/downloader";





// --- CROWNS DATA (FIXED) ---
const crownsFilePath = path.join(__dirname, "../data/crowns.json");

export let crowns: {
  [guildId: string]: {
    [artistLower: string]: { holder: string; plays: number };
  };
} = {};

// Load crowns from the correct path
try {
  if (fs.existsSync(crownsFilePath)) {
    crowns = JSON.parse(fs.readFileSync(crownsFilePath, "utf8"));
    console.log("✅ Crowns data loaded.");
  } else {
    console.log("ℹ️ No crowns.json found, starting fresh.");
  }
} catch (err) {
  console.error("🔥 Failed to load crowns.json:", err);
}

// Save crowns to the correct path
export function saveCrowns() {
  try {
    fs.writeFileSync(crownsFilePath, JSON.stringify(crowns, null, 2));
  } catch (err) {
    console.error("🔥 Failed to save crowns.json:", err);
  }
}


// env loader
dotenv.config();
// ... rest of your file

// env loader
dotenv.config();
const env = (name: string): string => {
  const val = process.env[name];
  if (!val) throw new Error(`Missing env var: ${name}`);
  return val;
};

// env values
const DISCORD_TOKEN = env("DISCORD_TOKEN");
const CLIENT_ID = env("CLIENT_ID");
const GUILD_ID = process.env.GUILD_ID;
export const LASTFM_API_KEY = env("LASTFM_API_KEY");
export const CALLBACK_BASE = process.env.CALLBACK_BASE || "http://localhost:8080";
export const PREFIX = process.env.PREFIX || ".fm";

// shared maps
export const pendingAuth = new Map<string, string>();
export const previewMap = new Map<string, string>();

// client setup
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

// commands loading
client.commands = new Collection<string, any>();
client.prefixCommands = new Collection<string, any>();
const commandDefs: any[] = [];
const commandsPath = path.join(__dirname, "commands");

// load commands
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter((f) => f.endsWith(".ts") || f.endsWith(".js"));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const cmd = require(filePath).default ?? require(filePath);

  if (cmd.data && cmd.execute) {
    client.commands.set(cmd.data.name, cmd);
    commandDefs.push(cmd.data.toJSON());
  }

  if (cmd.prefixExecute) {
    client.prefixCommands.set(cmd.data.name, cmd);
  }
}

// validate commands
for (const c of commandDefs) {
  if (!c.name || c.name.length > 32) console.error("Invalid name:", c);
  if (!c.description || c.description.length > 100)
    console.error("Invalid description:", c);
}

// slash registration
const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering slash commands...");

    const existing = GUILD_ID
      ? ((await rest.get(
          Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
        )) as any[])
      : ((await rest.get(Routes.applicationCommands(CLIENT_ID))) as any[]);

    if (existing.length > 0) {
      for (const cmd of existing) {
        if (GUILD_ID)
          await rest.delete(
            `${Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)}/${cmd.id}`
          );
        else
          await rest.delete(`${Routes.applicationCommands(CLIENT_ID)}/${cmd.id}`);
      }
    }

    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
        body: commandDefs,
      });
      console.log(`Registered ${commandDefs.length} guild commands`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), {
        body: commandDefs,
      });
      console.log(`Registered ${commandDefs.length} global commands`);
    }
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
})();

// hot reload
fs.watch(commandsPath, (event, filename) => {
  if (!filename) return;
  if (!filename.endsWith(".ts") && !filename.endsWith(".js")) return;

  console.log(`Reloading command: ${filename}`);

  try {
    const fullPath = path.join(commandsPath, filename);
    delete require.cache[require.resolve(fullPath)];
    const cmd = require(fullPath).default ?? require(fullPath);

    if (cmd?.data && cmd?.execute) client.commands.set(cmd.data.name, cmd);
    if (cmd?.prefixExecute) client.prefixCommands.set(cmd.data.name, cmd);
  } catch (err) {
    console.error(`Failed to reload ${filename}:`, err);
  }
});

// slash + button interactions
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(err);
      if (!interaction.replied)
        await interaction.reply({
          content: "Error executing command.",
          ephemeral: true,
        });
    }
    return;
  }

  if (interaction.isButton()) {
    const [customId, ...args] = interaction.customId.split(":");

    if (customId === "preview") {
      const originalInteractionId = args[0];
      const previewUrl = previewMap.get(originalInteractionId);
      if (!previewUrl) {
        await interaction.reply({
          content: "Preview expired or missing.",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferUpdate();
      let oggPath: string | null = null;

      try {
        const trackId = originalInteractionId;
        oggPath = await downloadAndConvert(previewUrl, trackId);
        await sendVoice(interaction.channelId, oggPath, interaction.message.id);
      } catch (err) {
        console.error("Voice preview failed:", err);
        await interaction.followUp({
          content: "Failed to retrieve preview.",
          ephemeral: true,
        });
      } finally {
        if (oggPath && fs.existsSync(oggPath)) await fsp.unlink(oggPath);
        previewMap.delete(originalInteractionId);
      }
    }
  }
});

// prefix commands
client.on(Events.MessageCreate, async (message) => {
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

  const command = client.prefixCommands.get(commandName);
  if (!command) return message.reply(`Unknown command: ${PREFIX}${commandName}`);

  try {
    if (command.prefixExecute) return command.prefixExecute(message, args);
    if (command.execute)
      return command.execute(createInteractionFromMessage(message, args) as any);

    await message.reply("Command not executable via prefix.");
  } catch (err) {
    console.error(err);
    try {
      await message.reply("Error.");
    } catch {}
  }
});


// errors
process.on("unhandledRejection", (err) =>
  console.error("Unhandled rejection:", err)
);
process.on("uncaughtException", (err) =>
  console.error("Uncaught exception:", err)
);

// shuffle util
function shuffleArray(array: any[]) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

// avatar load
const avatarsDir = path.join(__dirname, "../bot/avatars");
let avatarFiles: string[] = [];
try {
  avatarFiles = fs
    .readdirSync(avatarsDir)
    .filter((f) => f.endsWith(".png") || f.endsWith(".jpg") || f.endsWith(".gif"));

  if (avatarFiles.length > 0) {
    shuffleArray(avatarFiles);
    console.log(`Loaded ${avatarFiles.length} avatars.`);
  }
} catch (err) {
  console.error("Failed to load avatars:", err);
}

// (This function should be in the block you just moved)

// avatar cycling
let currentAvatarIndex = 0;
export function setNextAvatar() {
  if (avatarFiles.length === 0) {
    console.log("No avatars to set.");
    return Promise.reject("No avatars loaded."); // Return a rejected promise
  }

  const file = avatarFiles[currentAvatarIndex];
  const avatarPath = path.join(avatarsDir, file);
  
  // Get the promise from setAvatar
  const setPromise = client.user?.setAvatar(avatarPath);

  // Increment index immediately so the next call (manual or auto) gets the next file
  currentAvatarIndex++;
  if (currentAvatarIndex >= avatarFiles.length) {
    shuffleArray(avatarFiles);
    currentAvatarIndex = 0;
  }

  if (setPromise) {
    // Return the promise so the command can await it
    return setPromise
      .then(() => {
        console.log(`Avatar changed to ${file}`);
        return file; // Resolve with the file name
      })
      .catch((e) => {
        console.error("Avatar error:", e);
        throw e; // Re-throw for the command's catch block
      });
  } else {
    // Should not happen after login, but good to check
    return Promise.reject("Client user not available.");
  }
}


// ready
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user?.tag}`);


  setNextAvatar();
  setInterval(() => setNextAvatar(), 1800000);
});

// login
client.login(DISCORD_TOKEN);
