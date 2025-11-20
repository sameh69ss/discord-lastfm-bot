// env + core imports
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Collection,
  Events,
  Partials,
  EmbedBuilder,
  TextChannel,
} from "discord.js";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import fetch from "node-fetch";
import "./types/types";
import { createInteractionFromMessage } from "./scripts/prefixAdapter";
import sendVoice from "./scripts/sendVoice";
import { downloadAndConvert } from "./scripts/downloader";
import "./scripts/authserver";
import { getUser, getLinkedUserIds } from "./scripts/storage";

// +++ ADDED: Import the handler for the genre picker +++
import { handleGenrePicker } from "./handlers/genrePickerHandler";

// --- CROWNS DATA ---
const crownsFilePath = path.join(__dirname, "../data/crowns.json");

export let crowns: {
  [guildId: string]: {
    [artistLower: string]: { holder: string; plays: number };
  };
} = {};

// Load crowns
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

// Save crowns
export function saveCrowns() {
  try {
    fs.writeFileSync(crownsFilePath, JSON.stringify(crowns, null, 2));
  } catch (err) {
    console.error("🔥 Failed to save crowns.json:", err);
  }
}

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
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// shared maps
import { pendingAuth } from "./scripts/sharedState";
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

/* -------------------------------------------------------------------------- */
/* INTERACTION HANDLER                                                       */
/* -------------------------------------------------------------------------- */
client.on(Events.InteractionCreate, async (interaction) => {
  // 1. Chat Commands
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

  // 2. Buttons
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

  // 3. +++ ADDED: Select Menus (Dropdowns) +++
  else if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'genre-picker') {
      await handleGenrePicker(interaction);
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


/* -------------------------------------------------------------------------- */
/* FEATURED USER / AVATAR CYCLER                       */
/* -------------------------------------------------------------------------- */

// Helper to get Spotify token
async function getSpotifyTokenSimple(): Promise<string | null> {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return null;
  try {
    const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const data = (await res.json()) as any;
    return data.access_token || null;
  } catch {
    return null;
  }
}

// In index.ts

async function cycleBotFeature() {
  try {
    // 1. Pick a random user
    const allIds = getLinkedUserIds();
    if (allIds.length === 0) return;
    
    // Try up to 3 times to find a valid track
    for (let i = 0; i < 3; i++) {
      const randomId = allIds[Math.floor(Math.random() * allIds.length)];
      const user = getUser(randomId);
      if (!user) continue;

      // 2. Randomize Period (Week vs Month) & Fetch Top Tracks
      // This adds variety: sometimes it's a weekly obsession, sometimes a monthly favorite.
      const periods = ["7day", "1month"];
      const selectedPeriod = periods[Math.floor(Math.random() * periods.length)];

      // We fetch 'gettoptracks' with limit=50 to get a large pool of options
      const url = `https://ws.audioscrobbler.com/2.0/?method=user.gettoptracks&user=${encodeURIComponent(
        user.username
      )}&api_key=${LASTFM_API_KEY}&format=json&limit=50&period=${selectedPeriod}&sk=${encodeURIComponent(user.sessionKey)}`;

      const res = await fetch(url);
      if (!res.ok) continue;
      const data = (await res.json()) as any;
      const tracks = data.toptracks?.track; // Note: 'toptracks', not 'recenttracks'

      if (!tracks || !Array.isArray(tracks) || tracks.length === 0) continue;

      // 3. Pick a random track from the Top 50
      const randomTrack = tracks[Math.floor(Math.random() * tracks.length)];
      
      // Handle different data structures (TopTracks uses .name, Recent uses .#text)
      const artistName = randomTrack.artist?.name || randomTrack.artist?.["#text"] || "Unknown";
      const trackName = randomTrack.name || "Unknown";
      
      // 4. Get High Quality Cover (Spotify preferred)
      let imageUrl: string | null = null;
      
      const token = await getSpotifyTokenSimple();
      if (token) {
        try {
          const q = encodeURIComponent(`track:${trackName} artist:${artistName}`);
          const sRes = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          const sData = (await sRes.json()) as any;
          imageUrl = sData.tracks?.items?.[0]?.album?.images?.[0]?.url || null;
        } catch {}
      }

      // Fallback to Last.fm image
      if (!imageUrl) {
        imageUrl = randomTrack.image?.find((img: any) => img.size === "extralarge")?.["#text"] || null;
      }
      
      if (!imageUrl) continue;

      // 5. Update Avatar
      console.log(`Setting avatar to ${trackName} by ${artistName} (User: ${user.username}, Period: ${selectedPeriod})`);
      await client.user?.setAvatar(imageUrl);

      // 6. Send Message
      const targetChannelId = "1425532225864204469";
      const channel = client.channels.cache.get(targetChannelId) as TextChannel;
      
      if (channel && channel.isTextBased()) {
          const artistUrl = `https://www.last.fm/music/${encodeURIComponent(artistName)}`;
          const trackUrl = `https://www.last.fm/music/${encodeURIComponent(artistName)}/_/${encodeURIComponent(trackName)}`;
          
          // Friendly text for the period
          const periodText = selectedPeriod === "7day" ? "weekly" : "monthly";

          const embed = new EmbedBuilder()
            .setColor(0xBA2000)
            .setThumbnail(imageUrl)
            .addFields({
                name: "Featured:",
                value: `[${trackName}](${trackUrl}) \nby [${artistName}](${artistUrl}) \n\nRandom ${periodText} pick from ${user.username}`,
                inline: false
            });

          await channel.send({ embeds: [embed] });
      }

      break; // Success
    }
  } catch (err) {
    console.error("Error cycling bot feature:", err);
  }
}


export async function setNextAvatar() {
    return cycleBotFeature();
}

// ready
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user?.tag}`);
  console.log("Bot PID:", process.pid);

  // Run immediately on startup
  setNextAvatar();

  // Run every 30 minutes
  setInterval(() => setNextAvatar(), 1800000);
});

// login
client.login(DISCORD_TOKEN);