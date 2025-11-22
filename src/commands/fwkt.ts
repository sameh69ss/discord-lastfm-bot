// src/commands/fwkt.ts
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  Message,
  GuildMember,
  SlashCommandBuilder,
  TextChannel,
} from "discord.js";
import { SlashCommandStringOption } from "@discordjs/builders";
import fetch from "node-fetch";
import { getUser, getLinkedUserIds } from "../scripts/storage";
import { LASTFM_API_KEY } from "../config";
import { createInteractionFromMessage, parseArgs } from "../scripts/prefixAdapter";
import fs from "fs";
import path from "path";

// --- Start: Added from 'fwk.ts' ---
// This path points to the file storing friend relationships
const friendsPath = path.resolve(__dirname, "../../data/friend.json");

// Reads the friend.json storage file
function getFriendsStorage(): Record<string, string[]> {
  if (!fs.existsSync(friendsPath)) {
    fs.writeFileSync(friendsPath, "{}");
  }
  return JSON.parse(fs.readFileSync(friendsPath, "utf8"));
}
// --- End: Added from 'fwk.ts' ---

// --- Start: Copied from 'wkt.ts' ---
function safeNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function isRTL(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

async function fetchWithTimeout(url: string, options?: any, timeoutMs = 10000): Promise<any> {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), timeoutMs))
  ]);
}

async function getSpotifyAccessToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID!;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;
  const token = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  try {
    const res = await fetchWithTimeout("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  } catch (err) {
    console.error("Spotify token fetch failed:", err);
    throw err;
  }
}

async function getImage(type: 'artist' | 'track' | 'album', params: { artist: string; track?: string; album?: string }): Promise<string | null> {
  
  try {
    const accessToken = await getSpotifyAccessToken();
    let query = '';
    let spType = '';
    if (type === 'artist') {
      query = `artist:${encodeURIComponent(params.artist)}`;
      spType = 'artist';
    } else if (type === 'track') {
      query = `track:${encodeURIComponent(params.track!)} artist:${encodeURIComponent(params.artist)}`;
      spType = 'track';
    } else {
      query = `album:${encodeURIComponent(params.album!)} artist:${encodeURIComponent(params.artist)}`;
      spType = 'album';
    }
    const res = await fetchWithTimeout(`https://api.spotify.com/v1/search?q=${query}&type=${spType}&limit=1`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json() as any;
    let cover: string | undefined;
    if (type === 'artist') cover = data.artists?.items?.[0]?.images?.[0]?.url;
    else if (type === 'track') cover = data.tracks?.items?.[0]?.album?.images?.[0]?.url;
    else cover = data.albums?.items?.[0]?.images?.[0]?.url;
    if (cover) return cover;
  } catch (err) {
    console.warn("Spotify image fetch failed, falling back to Last.fm:", err);
  }

  
  try {
    let url = `https://ws.audioscrobbler.com/2.0/?method=${type}.getinfo&api_key=${LASTFM_API_KEY}&format=json`;
    url += `&artist=${encodeURIComponent(params.artist)}`;
    if (type === 'track') url += `&track=${encodeURIComponent(params.track!)}`;
    if (type === 'album') url += `&album=${encodeURIComponent(params.album!)}`;
    const res = await fetchWithTimeout(url);
    const data = await res.json() as any;
    const img = data[type]?.image?.find((i: any) => i.size === 'extralarge')?.['#text'] || null;
    // Placeholder detection
    if (!img) return null;
    if (img.includes("2a96cbd8b46e442fc41c2b86b821562f.png")) return null;
    if (img.includes("/i/u/300x300/")) return null;
    return img;
  } catch (err) {
    console.error("Last.fm image fetch failed:", err);
    return null;
  }
}

async function getRecent(userId: string): Promise<{ artist: string; track: string; album: string }> {
  const userData = getUser(userId);
  if (!userData) throw new Error('No linked account');
  const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(userData.username)}&limit=1&format=json&sk=${encodeURIComponent(userData.sessionKey)}`;
  try {
    const res = await fetchWithTimeout(url);
    const data = await res.json() as any;
    const track = data.recenttracks?.track?.[0];
    if (!track) throw new Error('No recent tracks');
    return {
      artist: track.artist['#text'],
      track: track.name,
      album: track.album['#text'],
    };
  } catch (err) {
    console.error("Recent tracks fetch failed:", err);
    throw err;
  }
}



async function getLinkedMembers(guild: any): Promise<{ member: GuildMember; data: NonNullable<ReturnType<typeof getUser>>; }[]> {
  console.log("Fetching playcounts for linked members...");
  const allLinkedIds = getLinkedUserIds();
  if (allLinkedIds.length === 0) {
    console.log("No linked users in database.");
    return [];
  }
  let fetchedMembers;
  try {
    fetchedMembers = await guild.members.fetch({ user: allLinkedIds });
  } catch (err) {
    console.warn("Could not fetch all linked members, some may be missing:", err);
    fetchedMembers = new Map();
  }
  console.log(`Found ${fetchedMembers.size} linked members in this guild.`);
  const results: { member: GuildMember; data: NonNullable<ReturnType<typeof getUser>>; }[] = [];
  fetchedMembers.forEach((member: GuildMember) => {
    const userData = getUser(member.id);
    if (!member.user.bot && userData) {
      results.push({
        member: member,
        data: userData
      });
    }
  });
  return results;
}


async function getPlaycount(method: string, params: { artist: string; track?: string; album?: string }, username: string, sessionKey: string): Promise<number> {
  if (method === 'track.getinfo' && params.track) {
    let url = `https://ws.audioscrobbler.com/2.0/?method=user.gettrackscrobbles&api_key=${LASTFM_API_KEY}&format=json&username=${encodeURIComponent(username)}&sk=${encodeURIComponent(sessionKey)}&autocorrect=1`;
    url += `&artist=${encodeURIComponent(params.artist)}`;
    url += `&track=${encodeURIComponent(params.track)}`;
    try {
      const res = await fetchWithTimeout(url);
      const data = (await res.json()) as any;
      if (data?.trackscrobbles?.["@attr"]) {
        const plays = safeNum(data.trackscrobbles["@attr"].total);
        return plays; 
      }
      console.warn(`user.gettrackscrobbles missing '@attr' for ${username} on ${params.track}`);
    } catch (err) {
      console.warn(`user.gettrackscrobbles failed for ${username}, falling back:`, err);
    }
  }

  let url = `https://ws.audioscrobbler.com/2.0/?method=${method}&api_key=${LASTFM_API_KEY}&format=json&username=${encodeURIComponent(username)}&sk=${encodeURIComponent(sessionKey)}&autocorrect=1`;
  url += `&artist=${encodeURIComponent(params.artist)}`;
  if (params.track) url += `&track=${encodeURIComponent(params.track)}`;
  if (params.album) url += `&album=${encodeURIComponent(params.album)}`;
  try {
    const res = await fetchWithTimeout(url);
    const data = await res.json() as any;
    const type = method.split('.')[0];
    if (type === 'artist') {
      return safeNum(data[type]?.stats?.userplaycount);
    } else {
      return safeNum(data[type]?.userplaycount); 
    }
  } catch (err) {
    console.warn(`Playcount fetch (fallback) failed for ${username}:`, err);
    return 0;
  }
}
// --- End: Copied from 'wkt.ts' ---

export const data = new SlashCommandBuilder()
  .setName("fwkt")
  .setDescription("Shows who of your friends listen to a track")
  .addStringOption((option: SlashCommandStringOption) =>
    option.setName("track").setDescription("The track to check (defaults to currently playing)").setRequired(false)
  )
  .addStringOption((option: SlashCommandStringOption) =>
    option.setName("artist").setDescription("The artist (optional, will try to find if blank)").setRequired(false)
  );

interface SpotifyTrackSearchResult {
  tracks: {
    items: Array<{
      name: string;
      artists: Array<{ name: string }>;
      album: { name: string; images: Array<{ url: string }> };
    }>;
  };
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const isPrefix = (interaction as any).isPrefix;

  if (isPrefix) {
    try {
      (interaction.channel as TextChannel).sendTyping();
    } catch (err) {
      console.warn("Typing indicator failed:", err);
    }
  } else {
    try {
      await interaction.deferReply();
    } catch (err) {
      console.error("Failed to defer reply:", err);
      return; 
    }
  }

  try {
    // --- Start: New logic to get friends (from fwk.ts) ---
    const callerId = interaction.user.id;
    const callerData = getUser(callerId);

    if (!callerData) {
      const content = "❌ You need to link your Last.fm account first with `/link`.";
      if (isPrefix) await interaction.reply({ content });
      else await interaction.editReply({ content });
      return;
    }

    const friendsStorage = getFriendsStorage();
    const friendUsernames = new Set(friendsStorage[callerId] || []);
    // --- End: New logic to get friends ---

    // --- Start: Track/Artist logic (from wkt.ts) ---
    let track = interaction.options.getString("track")?.trim();
    let artist = interaction.options.getString("artist")?.trim();
    
    if (!track && !artist) {
      const recent = await getRecent(interaction.user.id);
      artist = recent.artist;
      track = recent.track;
    } else if (!artist && track) {
      const accessToken = await getSpotifyAccessToken();
      const query = `track:${encodeURIComponent(track)}`;
      const res = await fetchWithTimeout(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json() as SpotifyTrackSearchResult;
      const item = data.tracks?.items?.[0];
      if (!item) {
        throw new Error(`No matching track found for "${track}"`);
      }
      artist = item.artists[0].name;
      console.log(`Resolved artist for "${track}" to "${artist}" via Spotify`);
    } else if (!track) {
      throw new Error("Need track name");
    }
    // --- End: Track/Artist logic ---
    
    const guild = interaction.guild!;
    const linked = await getLinkedMembers(guild); // Get all linked users in server

    // --- Start: New logic to filter for friends (from fwk.ts) ---
    const friendsToScan = linked.filter(l => {
      const isFriend = friendUsernames.has(l.data.username.toLowerCase());
      const isCaller = l.member.id === callerId;
      return isFriend || isCaller; // Include user and their friends
    });
    // --- End: New logic to filter for friends ---
    
    if (friendsToScan.length === 0) {
      const content = "You have no linked friends in this server."; // Should be rare
      if (isPrefix) await interaction.reply({ content });
      else await interaction.editReply({ content });
      return;
    }
    
    console.log(`Fetching playcounts for ${friendsToScan.length} users (friends)...`);
    const playcounts = await Promise.allSettled( 
      friendsToScan.map(async (l: { member: GuildMember; data: NonNullable<ReturnType<typeof getUser>>; }) => {
        try {
          return {
            userId: l.member.id,
            displayName: l.member.displayName,
            username: l.data.username,
            plays: await getPlaycount('track.getinfo', { artist: artist!, track: track! }, l.data.username, l.data.sessionKey),
          };
        } catch (err) {
          console.warn(`Individual playcount error for ${l.data.username}:`, err);
          return {
            userId: l.member.id,
            displayName: l.member.displayName,
            username: l.data.username,
            plays: 0,
          };
        }
      })
    );
    const validPlaycounts = playcounts
      .filter((p): p is PromiseFulfilledResult<any> => p.status === 'fulfilled')
      .map(p => p.value);
    
    const ranks: { userId: string; displayName: string; username: string; plays: number; }[] = validPlaycounts
      .filter((p) => p.plays > 0 || p.userId === interaction.user.id)
      .sort((a, b) => b.plays - a.plays);
    
    const image = await getImage('track', { artist: artist!, track: track! }).catch(() => null);

    const listeners = ranks.length;
    const totalPlays = ranks.reduce((sum: number, r: { plays: number; }) => sum + r.plays, 0);
    const avgPlays = listeners > 0 ? Math.round(totalPlays / listeners) : 0;
    const listenerText = listeners === 1 ? 'listener' : 'listeners';

    let description = '\u200E';
    
    // --- Start: "Working Amazing" Formatting ---
    const rankLines = ranks.map((r: { displayName: string; username: string; plays: number; }, i: number) => {
      const nameFormatted = isRTL(r.displayName) ? `\u2067${r.displayName}\u2069` : r.displayName;
      const userLink = `[**\u200E${nameFormatted}\u200E**](https://www.last.fm/user/${encodeURIComponent(r.username)})`;
      return `\u200E${i + 1}.\u200E ${userLink} - \u200E**\u200E${r.plays}\u200E** plays`;
    }).join('\n');
    
    if (rankLines) {
      description += rankLines;
    } else {
      description += 'You and your friends have 0 plays for this track.';
    }
    // --- End: "Working Amazing" Formatting ---

    const trackUrl = `https://www.last.fm/music/${encodeURIComponent(artist!)}/_/${encodeURIComponent(track!)}`;
    
    // --- Start: New Footer Format (from fwk.ts / JSON example) ---
    const footerText = `${listeners} ${listenerText} - ${totalPlays} plays - ${avgPlays} avg\nFriends WhoKnow track for ${interaction.user.displayName}`;
    // --- End: New Footer Format ---

    const embed = new EmbedBuilder()
      .setColor(0xd51007) // Last.fm Red
      .setTitle(`${track} by ${artist} with friends`) // New Title
      .setURL(trackUrl)
      .setDescription(description)
      .setThumbnail(image)
      .setFooter({ text: footerText }); // New Footer

    if (isPrefix) {
      await interaction.reply({ embeds: [embed] });
    } else {
      await interaction.editReply({ embeds: [embed] });
    }
    console.log(`✅ FWKT response sent for ${artist} - ${track}`);
  } catch (err) {
    console.error("Overall FWKT error:", err);
    const content = `⚠️ Failed to fetch data. ${err instanceof Error ? err.message : ''}`;
    
    try {
      if (isPrefix) {
        await interaction.reply({ content });
      } else if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    } catch (e) {
      console.error("Failed to send error reply:", e);
    }
  }
}

export async function prefixExecute(message: Message, args: string[]) {
  // --- This prefix logic is from wkt.ts ---
  const { map, unnamed } = parseArgs(args);
  
  let track: string | undefined;
  let artist: string | undefined;
  
  if (map.track) {
    track = map.track;
  } else if (unnamed.length > 0) {
    const full = unnamed.join(' ');
    const match = full.match(/(.+) by (.+)/i);
    if (match) {
      track = match[1].trim();
      artist = match[2].trim();
    } else {
      track = full.trim();
    }
  }
  
  if (map.artist) {
    artist = map.artist;
  }
  
  let trackArg = track ? `--track=${track}` : '';
  let artistArg = artist ? `--artist=${artist}` : '';
  
  const simArgs = [trackArg, artistArg].filter(a => a !== '');
  
  const interaction = createInteractionFromMessage(message, simArgs);
  await execute(interaction as any);
}