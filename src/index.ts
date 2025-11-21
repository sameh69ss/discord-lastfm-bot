// src/index.ts
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
import crypto from "crypto"; 
import "./types/types";
import { createInteractionFromMessage } from "./scripts/prefixAdapter";
import sendVoice from "./scripts/sendVoice";
import { downloadAndConvert } from "./scripts/downloader";
// IMPORTANT: Ensure linkUser is exported from storage!
import { getUser, getLinkedUserIds, linkUser } from "./scripts/storage"; 

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
  if (!val) {
    console.warn(`⚠️ Missing env var: ${name}`);
    return "";
  }
  return val;
};

// env values
const DISCORD_TOKEN = env("DISCORD_TOKEN");
const CLIENT_ID = env("CLIENT_ID");
const GUILD_ID = process.env.GUILD_ID;
export const LASTFM_API_KEY = env("LASTFM_API_KEY");
const LASTFM_SHARED_SECRET = env("LASTFM_SHARED_SECRET"); 
export const PREFIX = process.env.PREFIX || ".fm";
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// shared maps
export const previewMap = new Map<string, string>();

// ------------------------------------------------------------------
// HELPER: Last.fm Signature Generator
// ------------------------------------------------------------------
function generateSignature(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params).sort();
  let stringToSign = "";
  for (const key of keys) {
    stringToSign += key + params[key];
  }
  stringToSign += secret;
  return crypto.createHash("md5").update(stringToSign).digest("hex");
}

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

// slash registration
const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering slash commands...");
    const existing = GUILD_ID
      ? ((await rest.get(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID))) as any[])
      : ((await rest.get(Routes.applicationCommands(CLIENT_ID))) as any[]);

    if (existing.length > 0) {
      for (const cmd of existing) {
        const route = GUILD_ID 
            ? `${Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)}/${cmd.id}`
            : `${Routes.applicationCommands(CLIENT_ID)}/${cmd.id}`;
        
        // FIX: Cast to 'any' to satisfy the strict string type
        await rest.delete(route as any);
      }
    }

    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commandDefs });
      console.log(`Registered ${commandDefs.length} guild commands`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandDefs });
      console.log(`Registered ${commandDefs.length} global commands`);
    }
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
})();

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
        await interaction.reply({ content: "Error executing command.", ephemeral: true });
    }
    return;
  }

  // 2. Buttons
  if (interaction.isButton()) {
    const [customId, ...args] = interaction.customId.split(":");

    // --- START NEW: Handle Verify Login Button ---
    if (customId === "verify_login") {
        await interaction.deferReply({ ephemeral: true });
        const token = args[0]; 

        try {
            if (!LASTFM_SHARED_SECRET) {
                await interaction.editReply("❌ Bot configuration error: Missing Shared Secret.");
                return;
            }

            // Prepare params for signature
            const params: Record<string, string> = {
                api_key: LASTFM_API_KEY,
                method: "auth.getSession",
                token: token
            };

            // Generate signature
            const sig = generateSignature(params, LASTFM_SHARED_SECRET);
            
            // Call Last.fm auth.getSession
            const sessionUrl = `https://ws.audioscrobbler.com/2.0/?method=auth.getSession&api_key=${LASTFM_API_KEY}&token=${token}&api_sig=${sig}&format=json`;
            const res = await fetch(sessionUrl);
            const data = await res.json() as any;

            if (data.error) {
                if (data.error === 14) {
                    await interaction.editReply("❌ You haven't authorized the app in your browser yet. Click the link, allow access, then click 'Verify' again.");
                } else if (data.error === 4 || data.error === 15) {
                    await interaction.editReply("❌ Token expired. Please run `/link` again.");
                } else {
                    await interaction.editReply(`❌ Last.fm Error: ${data.message}`);
                }
                return;
            }

            if (data.session) {
                // SUCCESS! We got the session key.
                const { name, key } = data.session;
                
                linkUser(interaction.user.id, name, key); 
                
                await interaction.editReply(`✅ Success! Linked **${name}** to your Discord account.`);
                
                try {
                    await interaction.message.edit({ components: [] }); 
                } catch {}
            }

        } catch (err) {
            console.error("Login verify error:", err);
            await interaction.editReply("❌ Internal error verifying login.");
        }
        return;
    }
    // --- END NEW: Handle Verify Login Button ---

    if (customId === "preview") {
      const originalInteractionId = args[0];
      const previewUrl = previewMap.get(originalInteractionId);
      if (!previewUrl) {
        await interaction.reply({ content: "Preview expired or missing.", ephemeral: true });
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
        await interaction.followUp({ content: "Failed to retrieve preview.", ephemeral: true });
      } finally {
        if (oggPath && fs.existsSync(oggPath)) await fsp.unlink(oggPath);
        previewMap.delete(originalInteractionId);
      }
    }
  }

  // 3. Select Menus (Dropdowns)
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
    try { await message.reply("Error."); } catch {}
  }
});

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

async function cycleBotFeature() {
  try {
    const allIds = getLinkedUserIds();
    if (allIds.length === 0) return;
    
    for (let i = 0; i < 3; i++) {
      const randomId = allIds[Math.floor(Math.random() * allIds.length)];
      const user = getUser(randomId);
      if (!user) continue;

      const periods = ["7day", "1month"];
      const selectedPeriod = periods[Math.floor(Math.random() * periods.length)];

      const url = `https://ws.audioscrobbler.com/2.0/?method=user.gettoptracks&user=${encodeURIComponent(
        user.username
      )}&api_key=${LASTFM_API_KEY}&format=json&limit=50&period=${selectedPeriod}&sk=${encodeURIComponent(user.sessionKey)}`;

      const res = await fetch(url);
      if (!res.ok) continue;
      const data = (await res.json()) as any;
      const tracks = data.toptracks?.track; 

      if (!tracks || !Array.isArray(tracks) || tracks.length === 0) continue;

      const randomTrack = tracks[Math.floor(Math.random() * tracks.length)];
      
      const artistName = randomTrack.artist?.name || randomTrack.artist?.["#text"] || "Unknown";
      const trackName = randomTrack.name || "Unknown";
      
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

      if (!imageUrl) {
        imageUrl = randomTrack.image?.find((img: any) => img.size === "extralarge")?.["#text"] || null;
      }
      
      if (!imageUrl) continue;

      console.log(`Setting avatar to ${trackName} by ${artistName}`);
      await client.user?.setAvatar(imageUrl);

      const targetChannelId = "1437890858849538068";
      const channel = client.channels.cache.get(targetChannelId) as TextChannel;
      
      if (channel && channel.isTextBased()) {
          const artistUrl = `https://www.last.fm/music/${encodeURIComponent(artistName)}`;
          const trackUrl = `https://www.last.fm/music/${encodeURIComponent(artistName)}/_/${encodeURIComponent(trackName)}`;
          
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

      break; 
    }
  } catch (err) {
    console.error("Error cycling bot feature:", err);
  }
}

export async function setNextAvatar() {
    return cycleBotFeature();
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user?.tag}`);
  setNextAvatar();
  setInterval(() => setNextAvatar(), 1800000);
});

client.login(DISCORD_TOKEN);