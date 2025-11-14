// src/commands/fwk.ts
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  Message,
  GuildMember,
  TextChannel,
} from "discord.js";
import { SlashCommandStringOption } from "@discordjs/builders";
import fetch from "node-fetch";
import { getUser, getLinkedUserIds } from "../scripts/storage";
import { LASTFM_API_KEY } from "../index"; // Removed crown imports
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import fs from "fs";
import path from "path";

// --- Start: Added from 'addfriend.ts' / 'profile.ts' ---
// This path points to the file storing friend relationships
const friendsPath = path.resolve(__dirname, "../../data/friend.json");

// Reads the friend.json storage file
function getFriendsStorage(): Record<string, string[]> {
  if (!fs.existsSync(friendsPath)) {
    fs.writeFileSync(friendsPath, "{}");
  }
  return JSON.parse(fs.readFileSync(friendsPath, "utf8"));
}
// --- End: Added from 'addfriend.ts' / 'profile.ts' ---

// --- Start: Copied from 'wk.ts' ---
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

async function getImage(
  type: "artist" | "track" | "album",
  params: { artist: string; track?: string; album?: string }
): Promise<string | null> {

  // --- Spotify priority ---
  try {
    const accessToken = await getSpotifyAccessToken();
    let q = "";
    let spType = "";
    if (type === "artist") {
      q = encodeURIComponent(params.artist);
      spType = "artist";
    } else if (type === "track") {
      q = encodeURIComponent(`${params.track} ${params.artist}`);
      spType = "track";
    } else {
      q = encodeURIComponent(`${params.album} ${params.artist}`);
      spType = "album";
    }
    const res = await fetchWithTimeout(
      `https://api.spotify.com/v1/search?q=${q}&type=${spType}&limit=5`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = (await res.json()) as any;
    let item: any = null;
    if (spType === "artist") {
      const items = data.artists?.items || [];
      item =
        items.find(
          (x: any) => x.name.toLowerCase() === params.artist.toLowerCase()
        ) || items[0];
      if (item?.images?.[0]?.url) return item.images[0].url;
    }
    if (spType === "track") {
      const item = data.tracks?.items?.[0];
      const img = item?.album?.images?.[0]?.url;
      if (img) return img;
    }
    if (spType === "album") {
      const item = data.albums?.items?.[0];
      const img = item?.images?.[0]?.url;
      if (img) return img;
    }
  } catch (err) {
    console.warn("Spotify image fetch failed, fallback to Last.fm:", err);
  }

  // --- Last.fm fallback with placeholder detection ---
  try {
    let url = `https://ws.audioscrobbler.com/2.0/?method=${type}.getinfo&api_key=${LASTFM_API_KEY}&format=json`;
    url += `&artist=${encodeURIComponent(params.artist)}`;
    if (type === "track") url += `&track=${encodeURIComponent(params.track!)}`;
    if (type === "album") url += `&album=${encodeURIComponent(params.album!)}`;
    const res = await fetchWithTimeout(url);
    const data = (await res.json()) as any;
    const img =
      data[type]?.image?.find((i: any) => i.size === "extralarge")?.["#text"] ||
      null;
    if (!img) return null;
    if (img.includes("2a96cbd8b46e442fc41c2b86b821562f.png")) return null;
    if (img.includes("/i/u/300x300/")) return null;
    return img;
  } catch (err) {
    console.error("Last.fm image fetch failed:", err);
    return null;
  }
}


async function getGenres(artist: string): Promise<string> {
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${encodeURIComponent(artist)}&api_key=${LASTFM_API_KEY}&format=json`;
    const res = await fetchWithTimeout(url);
    const data = await res.json() as any;
    const tags = data.artist?.tags?.tag?.slice(0, 3).map((t: any) => t.name) || []; // Get 3 tags
    return tags.join(' - ');
  } catch (err) {
    console.error("Genres fetch failed:", err);
    return '';
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
      const plays = safeNum(data?.trackscrobbles?.["@attr"]?.total);
      if (plays > 0) return plays;
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
    console.warn(`Playcount fetch failed for ${username}:`, err);
    return 0; // Graceful fallback: treat as 0 plays
  }
}
// --- End: Copied from 'wk.ts' ---


export const data = new SlashCommandBuilder()
  .setName("fwk") // Changed name
  .setDescription("Shows who of your friends listen to an artist") // Changed description
  .addStringOption((option: SlashCommandStringOption) =>
    option.setName("artist").setDescription("The artist to check (defaults to currently playing)").setRequired(false)
  );

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
    // --- Start: New logic to get friends ---
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

    let artist = interaction.options.getString("artist")?.trim();
    if (!artist) {
      const recent = await getRecent(interaction.user.id);
      artist = recent.artist;
    }
    const guild = interaction.guild!;
    const linked = await getLinkedMembers(guild); // Get all linked users in server

    // --- Start: New logic to filter for friends ---
    const friendsToScan = linked.filter(l => {
      const isFriend = friendUsernames.has(l.data.username.toLowerCase());
      const isCaller = l.member.id === callerId;
      return isFriend || isCaller; // Include user and their friends
    });
    // --- End: New logic to filter for friends ---
    
    if (friendsToScan.length === 0) {
      const content = "No one in this server has linked their Last.fm account."; // Should be rare
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
            displayName: l.member.displayName, // Use server display name
            username: l.data.username, // Use Last.fm username for links
            plays: await getPlaycount('artist.getinfo', { artist }, l.data.username, l.data.sessionKey),
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
    
    // Always include user, even with 0 plays
    const ranks: { userId: string; displayName: string; username: string; plays: number; }[] = validPlaycounts
      .filter((p) => p.plays > 0 || p.userId === interaction.user.id)
      .sort((a, b) => b.plays - a.plays);
    
    const image = await getImage('artist', { artist }).catch(() => null);
    const genres = await getGenres(artist).catch(() => '');

    const listeners = ranks.length;
    const totalPlays = ranks.reduce((sum: number, r: { plays: number; }) => sum + r.plays, 0);
    const avgPlays = listeners > 0 ? Math.round(totalPlays / listeners) : 0;
    const listenerText = listeners === 1 ? 'listener' : 'listeners';

    let description = '\u200E'; // Start with LTR mark

    // --- Start: Modified description logic ---
    const rankLines = ranks
      .map((r, i) => {
        const nameFormatted = isRTL(r.displayName) ? `\u2067${r.displayName}\u2069` : r.displayName;
        
        // --- START OF FIX ---
        // Apply the "working" wk.ts logic: Bold name inside link, bold plays separately.
        // Do this for ALL ranks to ensure consistent formatting.
        
        // Use Last.fm username for the link, with the name bolded *inside*
        const userLink = `[**${nameFormatted}**](https://www.last.fm/user/${encodeURIComponent(r.username)})`;
        const rankNum = i + 1;
        
        // Consistent format for all lines:
        return `\u200E${rankNum}.\u200E \u200E${userLink}\u200E - \u200E**${r.plays}** plays`;
        // --- END OF FIX ---

      }).join('\n');
    
    if (rankLines) {
      description += rankLines;
    } else {
      description += 'You and your friends have 0 plays for this artist.';
    }
    // --- End: Modified description logic ---

    const artistUrl = `https://www.last.fm/music/${encodeURIComponent(artist)}`;

    // --- Start: New footer format ---
    let footerText = `${listeners} ${listenerText} - ${totalPlays} plays - ${avgPlays} avg\nFriends WhoKnow artist for ${interaction.user.displayName}`;
    if (genres) {
      footerText = `${genres}\n${footerText}`;
    }
    // --- End: New footer format ---

    const embed = new EmbedBuilder()
      .setColor(0xd51007) // Changed to Last.fm Red
      .setTitle(`${artist} with friends`) // Changed title
      .setURL(artistUrl)
      .setDescription(description)
      .setThumbnail(image)
      .setFooter({ text: footerText });

    if (isPrefix) {
      await interaction.reply({ embeds: [embed] });
    } else {
      await interaction.editReply({ embeds: [embed] });
    }
    console.log(`✅ FWK response sent for ${artist}`);
  } catch (err) {
    console.error("Overall FWK error:", err);
    const content = "⚠️ Failed to fetch data.";
    
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
  const interaction = createInteractionFromMessage(message, args);
  await execute(interaction as any);
}