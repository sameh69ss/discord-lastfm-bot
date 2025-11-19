
// src/commands/fwkgenre.ts
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  Message,
  GuildMember,
  TextChannel,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  Interaction,
  Guild,
} from "discord.js";
import fetch from "node-fetch";
import { getUser, getLinkedUserIds } from "../scripts/storage";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const LASTFM_API_KEY = process.env.LASTFM_API_KEY!;
const LASTFM_SHARED_SECRET = process.env.LASTFM_SHARED_SECRET!;
export const FM_COLOR = 0xd51007;

// Paths
const friendsPath = path.resolve(__dirname, "../../data/friend.json");
const artistGenresPath = path.resolve(__dirname, "../../data/artistGenres.json");

// Load storages
export function getFriendsStorage(): Record<string, string[]> {
  if (!fs.existsSync(friendsPath)) {
    fs.writeFileSync(friendsPath, "{}");
  }
  return JSON.parse(fs.readFileSync(friendsPath, "utf8"));
}

export function getArtistGenresStorage(): Record<string, string[]> {
  if (!fs.existsSync(artistGenresPath)) {
    fs.writeFileSync(artistGenresPath, "{}");
  }
  return JSON.parse(fs.readFileSync(artistGenresPath, "utf8"));
}

export function saveArtistGenresStorage(storage: Record<string, string[]>) {
  fs.writeFileSync(artistGenresPath, JSON.stringify(storage, null, 2));
}

// Helper functions (copied/adapted from fwk.ts and fm.ts)
export function safeNum(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

export function isRTL(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

export async function getSpotifyAccessToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn('Spotify credentials not set, skipping.');
    return '';
  }
  const token = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`Spotify token fetch failed with status ${res.status}: ${text}`);
      return '';
    }

    const text = await res.text();
    try {
      const data = JSON.parse(text);
      return data.access_token || '';
    } catch (e) {
      console.warn('Spotify token response not JSON:', text);
      return '';
    }
  } catch (err) {
    console.warn('Spotify token fetch error:', err);
    return '';
  }
}

export async function getImage(type: "artist", params: { artist: string }): Promise<string | null> {
  // Spotify priority
  try {
    const accessToken = await getSpotifyAccessToken();
    if (accessToken) {
      const q = encodeURIComponent(`artist:${params.artist}`);
      const res = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=artist&limit=1`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          const item = data.artists?.items?.[0];
          if (item?.images?.[0]?.url) return item.images[0].url;
        } catch {
          console.warn('Spotify image response not JSON:', text);
        }
      }
    }
  } catch {}

  // Last.fm fallback
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(params.artist)}&format=json`;
    const res = await fetch(url);
    const data = (await res.json()) as any;
    const img = data.artist?.image?.find((i: any) => i.size === "extralarge")?.["#text"] || null;
    if (img && !img.includes("2a96cbd8b46e442fc41c2b86b821562f.png") && !img.includes("/i/u/300x300/")) return img;
  } catch {}
  return null;
}

export async function getArtistGenres(artist: string): Promise<string[]> {
  const lowerArtist = artist.toLowerCase();
  const storage = getArtistGenresStorage();
  if (storage[lowerArtist]) return storage[lowerArtist];

  try {
    const accessToken = await getSpotifyAccessToken();
    if (!accessToken) return [];
    const query = encodeURIComponent(`artist:${artist}`);
    const res = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=artist&limit=1`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`Spotify search failed with status ${res.status}: ${text}`);
      return [];
    }
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      const foundArtist = data.artists?.items?.[0];
      if (foundArtist && foundArtist.name.toLowerCase() === lowerArtist) {
        const genres = foundArtist.genres || [];
        if (genres.length > 0) {
          storage[lowerArtist] = genres;
          saveArtistGenresStorage(storage);
        }
        return genres;
      }
    } catch {
      console.warn('Spotify search response not JSON:', text);
    }
    return [];
  } catch (err) {
    console.warn("Spotify genres failed:", err);
    return [];
  }
}

// src/commands/fwkg.ts

export async function getArtistTags(artist: string): Promise<string[]> {
  const lowerArtist = artist.toLowerCase();
  const storage = getArtistGenresStorage();
  
  // --- FIX 1: Check cache *before* fetching ---
  if (storage[lowerArtist]) {
    return storage[lowerArtist];
  }

  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.gettoptags&artist=${encodeURIComponent(
      artist
    )}&api_key=${LASTFM_API_KEY}&format=json`;
    
    const res = await fetch(url);
    if (!res.ok) {
      storage[lowerArtist] = []; // Cache failure as empty to prevent retries
      saveArtistGenresStorage(storage);
      return [];
    }
    
    const data = (await res.json()) as any;
    const tags = data.toptags?.tag?.slice(0, 5).map((t: any) => t.name) || [];

    // --- FIX 2: Save successful fetch to cache ---
    storage[lowerArtist] = tags;
    saveArtistGenresStorage(storage);
    
    return tags;
  } catch {
    storage[lowerArtist] = []; // Cache error as empty to prevent retries
    saveArtistGenresStorage(storage);
    return [];
  }
}


// src/commands/fwkg.ts

export async function getGenrePlays(username: string, genre: string): Promise<number> {
  try {
    const topArtistsUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopartists&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(
      username
    )}&limit=500&format=json`;
    
    const res = await fetch(topArtistsUrl);
    if (!res.ok) {
      console.warn(`Failed to fetch top artists for ${username}: ${res.status}`);
      return 0;
    }

    const data = (await res.json()) as any;
    const artists = data.topartists?.artist || [];
    let total = 0;

    for (const a of artists) {
      // Small delay to be nice to APIs, but caching will do most of the work
      await new Promise((resolve) => setTimeout(resolve, 50)); 

      // --- SIMPLIFIED LOGIC ---
      // 1. Tries getArtistGenres (which uses cache + Spotify)
      // 2. If it returns empty, it means Spotify had no genres for this artist.
      // 3. Then, try getArtistTags (which now uses cache + Last.fm)
      
      let gs = await getArtistGenres(a.name);
      
      if (gs.length === 0) {
        gs = await getArtistTags(a.name); 
      }
      // --- End of new logic ---

      if (gs.map((g: string) => g.toLowerCase()).includes(genre.toLowerCase())) {
        total += safeNum(a.playcount);
      }
    }
    return total;
  } catch (err) {
    console.warn(`Failed to get genre plays for ${username}:`, err);
    return 0;
  }
}





export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function getUserStorage() {
  const dataPath = path.resolve(__dirname, "../../data/data.json");
  if (!fs.existsSync(dataPath)) {
    fs.writeFileSync(dataPath, "{}");
  }
  return JSON.parse(fs.readFileSync(dataPath, "utf8"));
}

export async function getDisplayName(interaction: Interaction, guild: Guild | null, username: string, discordId: string | null): Promise<string> {
  if (discordId) {
    if (guild) {
      const member = await guild.members.fetch(discordId).catch(() => null);
      if (member) return member.displayName;
    }
    const user = interaction.client.users.cache.get(discordId) || await interaction.client.users.fetch(discordId).catch(() => null);
    if (user) return user.globalName || user.username;
  }
  return capitalize(username);
}

export function getDiscordIdForLastfm(lowerUsername: string): string | null {
  const storage = getUserStorage();
  for (const uid in storage) {
    if (storage[uid].username.toLowerCase() === lowerUsername) {
      return uid;
    }
  }
  return null;
}

// Command data
export const data = new SlashCommandBuilder()
  .setName("fwkgenre")
  .setDescription("Shows who of your friends listen to a genre")
  .addStringOption((option) =>
    option
      .setName("search")
      .setDescription("The genre or artist you want to view")
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addBooleanOption((option) =>
    option
      .setName("private")
      .setDescription("Only show response to you")
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const isPrefix = (interaction as any).isPrefix;
  if (isPrefix) {
    try {
      (interaction.channel as TextChannel).sendTyping();
    } catch {}
  } else {
    await interaction.deferReply();
  }

  const replyMethod = isPrefix ? "reply" : "editReply";

  try {
    const target = interaction.user;
    const linkedUser = getUser(target.id);
    if (!linkedUser) {
      await interaction[replyMethod]({ content: "❌ You haven’t linked your Last.fm account yet. Use `/link` first.", ephemeral: true });
      return;
    }

    const username = linkedUser.username;
    const sessionKey = linkedUser.sessionKey;
    const search = interaction.options.getString("search")?.trim();

    let artist: string | undefined;
    let genre: string | undefined;
    let isGenreMode = false;

    if (search) {
      const genres = await getArtistGenres(search);
      if (genres.length > 0) {
        artist = search;
      } else {
        genre = search;
        isGenreMode = true;
      }
    } else {
      // Get current artist from recent track
      let recentUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(username)}&limit=1&format=json`;
      const params: Record<string, string> = {
        method: "user.getrecenttracks",
        api_key: LASTFM_API_KEY,
        user: username,
        limit: "1",
      };
      if (sessionKey) {
        params.sk = sessionKey;
      }
      let sig = "";
      Object.keys(params).sort().forEach(key => {
        sig += key + params[key];
      });
      sig += LASTFM_SHARED_SECRET;
      const api_sig = crypto.createHash("md5").update(sig, "utf-8").digest("hex");
      recentUrl += `&api_key=${LASTFM_API_KEY}&api_sig=${api_sig}`;
      if (sessionKey) {
        recentUrl += `&sk=${encodeURIComponent(sessionKey)}`;
      }
      console.log('Recent tracks URL:', recentUrl); // For debugging
      const recentRes = await fetch(recentUrl);
      if (!recentRes.ok) {
        const text = await recentRes.text();
        console.warn('Recent tracks fetch failed:', recentRes.status, text);
        await interaction[replyMethod]({ content: "⚠️ Failed to fetch recent tracks." });
        return;
      }
      const recentData = (await recentRes.json()) as any;
      const track = recentData.recenttracks?.track?.[0];
      if (!track) {
        await interaction[replyMethod]({ content: "😢 No recent tracks found." });
        return;
      }
      artist = track.artist["#text"];
    }

    const guild = interaction.guild;
    const callerId = interaction.user.id;
    const friendsStorage = getFriendsStorage();
    const friends = friendsStorage[callerId] || [];

    // Add caller themselves if not included
    const allUsernames = new Set([username.toLowerCase(), ...friends]);

    const playcountPromises = [];
    const displayNames: Record<string, string> = {};

    for (const lowerUsername of allUsernames) {
      const discordId = getDiscordIdForLastfm(lowerUsername);
      const disp = await getDisplayName(interaction, guild, lowerUsername, discordId);
      displayNames[lowerUsername] = disp;
      if (isGenreMode) {
        playcountPromises.push(getGenrePlays(lowerUsername, genre!));
      }
    }

    let embed: EmbedBuilder;
    let components: any[] = [];

    if (isGenreMode) {
      // Direct genre mode
      const playsList = await Promise.all(playcountPromises);
      const ranks: { lowerUsername: string; plays: number }[] = [];
      let i = 0;
      for (const lowerUsername of allUsernames) {
        const plays = playsList[i++];
        if (plays > 0 || lowerUsername === username.toLowerCase()) {
          ranks.push({ lowerUsername, plays });
        }
      }
      ranks.sort((a, b) => b.plays - a.plays);

      let description = "\u200E";
      if (ranks.length === 0) {
        description += "You and your friends have 0 plays for this genre.";
      } else {
        description += ranks
          .map((r, idx) => {
            const name = displayNames[r.lowerUsername];
            const nameFormatted = isRTL(name) ? `\u2067${name}\u2069` : name;
            const userLink = `[**${nameFormatted}**](https://www.last.fm/user/${encodeURIComponent(r.lowerUsername)})`;
            return `\u200E${idx + 1}.\u200E \u200E${userLink}\u200E - \u200E**${r.plays}** plays`;
          })
          .join("\n");
      }

      const listeners = ranks.length;
      const totalPlays = ranks.reduce((sum, r) => sum + r.plays, 0);
      const avgPlays = listeners > 0 ? Math.round(totalPlays / listeners) : 0;
      const listenerText = listeners === 1 ? "listener" : "listeners";

      embed = new EmbedBuilder()
        .setColor(FM_COLOR)
        .setTitle(`${capitalize(genre!)} with friends`)
        .setDescription(description)
        .setFooter({ text: `Friends WhoKnow genre for ${displayNames[username.toLowerCase()]}\nGenre - ${listeners} ${listenerText} - ${totalPlays} plays - ${avgPlays} avg` });
    } else {
      // Artist genres mode
      let genres = await getArtistGenres(artist!);
      let source = "Spotify";
      if (genres.length === 0) {
        genres = await getArtistTags(artist!);
        source = "Last.fm";
      }

      const description = genres.map((g) => `- **${g}**`).join("\n") || "No genres found.";
      const footer = `Genre source: ${source}\nAdd a genre to this command to see Friends WhoKnow genre`;

      const image = await getImage("artist", { artist: artist! });

      embed = new EmbedBuilder()
        .setColor(FM_COLOR)
        .setTitle(`Genres for '${artist}'`)
        .setURL(`https://www.last.fm/music/${encodeURIComponent(artist!)}`)
        .setDescription(description)
        .setThumbnail(image)
        .setFooter({ text: footer });

      if (genres.length > 0) {
        const options = genres.map((g) => ({
          label: capitalize(g),
          value: `${callerId}~${callerId}~friendwhoknows~${g.toLowerCase()}~${artist}`,
        }));
        const select = new StringSelectMenuBuilder()
          .setCustomId("genre-picker")
          .setPlaceholder("Select genre to view Friends WhoKnow")
          .addOptions(options);

        const row = new ActionRowBuilder().addComponents(select);
        components = [row as any];
      }
    }

    await interaction[replyMethod]({ embeds: [embed], components });
  } catch (err) {
    console.error("FWKGenre error:", err);
    await interaction[replyMethod]({ content: "⚠️ Failed to fetch data." });
  }
}

export async function prefixExecute(message: Message, args: string[]) {
  const interaction = createInteractionFromMessage(message, args);
  await execute(interaction as any);
}
