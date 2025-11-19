import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  Message,
  GuildMember,
  SlashCommandBuilder,
  TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ButtonInteraction,
  Guild
} from "discord.js";
import { SlashCommandStringOption } from "@discordjs/builders";
import fetch from "node-fetch";
import { getUser, getLinkedUserIds } from "../scripts/storage";
import { LASTFM_API_KEY } from "../index";
import { createInteractionFromMessage, parseArgs } from "../scripts/prefixAdapter";

/* --- Helpers --- */
function safeNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function toTitleCase(value: string | undefined): string {
  if (!value) return "";
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function formatPlay(count: number): string {
  return `${count} play${count === 1 ? "" : "s"}`;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeBasic(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[’‘`]/g, "'")
    .toLowerCase()
    .trim();
}

function normalizeTrackKey(name: string): string {
  return normalizeBasic(name)
    .replace(/\s*-\s*remaster(ed)?\s*(\d{4})?/i, "") 
    .replace(/\s*\(remaster(ed)?\s*(\d{4})?\)/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(html: string): string {
  let text = html.replace(/<[^>]+>/g, "");
  text = text.replace(/Read more on Last\.fm.*/si, "");
  text = text.replace(/User-contributed text is available.*/si, "");
  text = text.replace(/Creative Commons By-SA License.*/si, "");
  text = text.replace(/additional terms may apply.*/si, "");
  return text.trim();
}

function getDemonym(input: string): string | null {
    if (!input) return null;
    const c = input.toLowerCase().trim();
    const map: Record<string, string> = {
        "united states": "US", "usa": "US", "us": "US", "america": "US",
        "united kingdom": "UK", "uk": "UK", "great britain": "UK",
        "canada": "Canadian", "australia": "Australian", "japan": "Japanese",
        "france": "French", "germany": "German", "sweden": "Swedish",
        "russia": "Russian", "italy": "Italian", "spain": "Spanish",
        "south korea": "Korean", "korea": "Korean", "brazil": "Brazilian",
        "norway": "Norwegian", "finland": "Finnish", "denmark": "Danish",
        "ireland": "Irish", "netherlands": "Dutch", "china": "Chinese",
        "palestine": "Palestinian", "israel": "Israeli", "greece": "Greek",
        "turkey": "Turkish", "poland": "Polish", "mexico": "Mexican",
        "colombia": "Colombian", "argentina": "Argentine", "egypt": "Egyptian",
        "lebanon": "Lebanese", "jordan": "Jordanian", "syria": "Syrian"
    };
    return map[c] || null;
}

/* --- API Handling --- */

async function fetchWithTimeout(url: string, options?: any, timeoutMs = 10000): Promise<any> {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), timeoutMs))
  ]);
}

async function fetchMusicBrainzInfo(mbid: string): Promise<{ socials: Record<string, string>, lifeSpan: any, area: string, type: string, gender: string }> {
  if (!mbid) return { socials: {}, lifeSpan: null, area: "", type: "", gender: "" };
  try {
    const res = await fetchWithTimeout(`https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels+artist-rels&fmt=json`, {
      headers: { "User-Agent": "FMBotClone/1.0.0 ( discord@example.com )" } 
    }, 5000);
    
    const data = await res.json() as any;
    const relations = data.relations || [];
    const links: Record<string, string> = {};

    for (const rel of relations) {
      const url = rel.url?.resource || "";
      if (!url) continue;
      if (url.includes("twitter.com") || url.includes("x.com")) links.twitter = url;
      else if (url.includes("instagram.com")) links.instagram = url;
      else if (url.includes("facebook.com")) links.facebook = url;
      else if (url.includes("tiktok.com")) links.tiktok = url;
      else if (url.includes("open.spotify.com")) links.spotify = url;
      else if (url.includes("music.apple.com")) links.apple = url;
      else if (url.includes("soundcloud.com")) links.soundcloud = url;
      else if (url.includes("youtube.com") || url.includes("youtu.be")) links.youtube = url;
      else if (url.includes("bandcamp.com")) links.bandcamp = url;
    }
    
    return {
        socials: links,
        lifeSpan: data["life-span"],
        area: data.area?.name || data.country || "",
        type: data.type,
        gender: data.gender 
    };
  } catch (e) {
    return { socials: {}, lifeSpan: null, area: "", type: "", gender: "" };
  }
}

async function fetchAllUserArtistTracks(username: string, artist: string, sessionKey: string): Promise<{ name: string; count: number }[]> {
  const limit = 1000;
  let page = 1;
  const trackCounts = new Map<string, { name: string; count: number }>();
  
  while (true) {
    let url = `https://ws.audioscrobbler.com/2.0/?method=user.getartisttracks&user=${encodeURIComponent(username)}&artist=${encodeURIComponent(artist)}&api_key=${LASTFM_API_KEY}&format=json&limit=${limit}&page=${page}`;
    if (sessionKey) url += `&sk=${encodeURIComponent(sessionKey)}`;
    
    try {
      const res = await fetchWithTimeout(url);
      const data = await res.json() as any;
      const tracks = toArray(data.artisttracks?.track);

      if (!tracks.length) break;

      for (const t of tracks) {
        const name = t.name;
        if (!name) continue;
        const key = normalizeTrackKey(name);
        const existing = trackCounts.get(key);
        if (existing) {
          existing.count++;
          if (name.length < existing.name.length) existing.name = name; 
        } else {
          trackCounts.set(key, { name, count: 1 });
        }
      }
      const totalPages = safeNum(data.artisttracks?.['@attr']?.totalPages);
      if (page >= totalPages || page >= 5) break; 
      page++;
    } catch (err) {
      break;
    }
  }
  return Array.from(trackCounts.values()).sort((a, b) => b.count - a.count);
}

async function fetchUserTopAlbumsDeep(username: string, artist: string): Promise<{ name: string; count: number }[]> {
    const limit = 1000;
    const maxPages = 5; 
    const concurrency = 5; 
    
    const fetchPage = async (page: number) => {
        const url = `https://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${encodeURIComponent(username)}&api_key=${LASTFM_API_KEY}&limit=${limit}&page=${page}&period=overall&format=json`;
        try {
            const res = await fetchWithTimeout(url);
            const data = await res.json() as any;
            return (data.topalbums?.album || []) as any[];
        } catch {
            return [];
        }
    };

    let allAlbums: any[] = [];
    for (let i = 1; i <= maxPages; i += concurrency) {
        const batch = [];
        for (let j = 0; j < concurrency && (i + j) <= maxPages; j++) {
            batch.push(fetchPage(i + j));
        }
        const results = await Promise.all(batch);
        
        let foundEnd = false;
        results.forEach(r => {
            allAlbums.push(...r);
            if (r.length < limit) foundEnd = true;
        });
        if (foundEnd) break;
    }

    return allAlbums
        .filter(a => a.artist?.name?.toLowerCase() === artist.toLowerCase())
        .map(a => ({ name: a.name, count: safeNum(a.playcount) }))
        .sort((a: any, b: any) => b.count - a.count);
}

async function fetchUserCountsFromGlobalTracks(username: string, sessionKey: string, artist: string): Promise<{ name: string; count: number }[]> {
  try {
    const globalUrl = `https://ws.audioscrobbler.com/2.0/?method=artist.gettoptracks&artist=${encodeURIComponent(artist)}&api_key=${LASTFM_API_KEY}&limit=100&format=json&autocorrect=1`;
    const globalRes = await fetchWithTimeout(globalUrl);
    const globalData = await globalRes.json() as any;
    const globalTracks = globalData.toptracks?.track || [];
    if (!globalTracks.length) return [];

    const checkPromises = globalTracks.map(async (gt: any) => {
      try {
        const checkUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettrackscrobbles&user=${encodeURIComponent(username)}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(gt.name)}&api_key=${LASTFM_API_KEY}&format=json&autocorrect=1&sk=${encodeURIComponent(sessionKey)}`;
        const checkRes = await fetchWithTimeout(checkUrl);
        const checkData = await checkRes.json() as any;
        const count = safeNum(checkData.trackscrobbles?.["@attr"]?.total);
        if (count > 0) return { name: gt.name, count };
      } catch {}
      return null;
    });

    const results = await Promise.all(checkPromises);
    return results.filter((t): t is { name: string; count: number } => t !== null);
  } catch (err) {
    return [];
  }
}

async function getSpotifyAccessToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID!;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;
  const token = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetchWithTimeout("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function getImage(type: 'artist' | 'track' | 'album', params: { artist: string; track?: string; album?: string }): Promise<{ url: string; source: 'spotify' | 'lastfm' } | null> {
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
    if (cover) return { url: cover, source: 'spotify' };
  } catch (err) {}
  try {
    let url = `https://ws.audioscrobbler.com/2.0/?method=${type}.getinfo&api_key=${LASTFM_API_KEY}&format=json`;
    url += `&artist=${encodeURIComponent(params.artist)}`;
    if (type === 'track') url += `&track=${encodeURIComponent(params.track!)}`;
    if (type === 'album') url += `&album=${encodeURIComponent(params.album!)}`;
    const res = await fetchWithTimeout(url);
    const data = await res.json() as any;
    const lastfmCover = data[type]?.image?.find((i: any) => i.size === 'extralarge')?.['#text'];
    return lastfmCover ? { url: lastfmCover, source: 'lastfm' } : null;
  } catch (err) {
    return null;
  }
}

async function getRecent(userId: string): Promise<{ artist: string; track: string; album: string }> {
  const userData = getUser(userId);
  if (!userData) throw new Error('No linked account');
  const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(userData.username)}&limit=1&format=json&sk=${encodeURIComponent(userData.sessionKey)}`;
  const res = await fetchWithTimeout(url);
  const data = await res.json() as any;
  const track = data.recenttracks?.track?.[0];
  if (!track) throw new Error('No recent tracks');
  return { artist: track.artist['#text'], track: track.name, album: track.album['#text'] };
}

async function getUserTotalPlays(username: string): Promise<number> {
  const url = `https://ws.audioscrobbler.com/2.0/?method=user.getinfo&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&format=json`;
  const res = await fetchWithTimeout(url);
  const data = await res.json() as any;
  return safeNum(data.user?.playcount);
}

async function getUserWeeklyArtistPlays(username: string, artist: string, sessionKey: string): Promise<number> {
  const url = `https://ws.audioscrobbler.com/2.0/?method=user.gettopartists&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&period=7day&limit=1000&format=json&sk=${encodeURIComponent(sessionKey)}`;
  try {
    const res = await fetchWithTimeout(url);
    const data = await res.json() as any;
    const artists = data.topartists?.artist || [];
    const found = artists.find((a: any) => a.name.toLowerCase() === artist.toLowerCase());
    return safeNum(found?.playcount);
  } catch { return 0; }
}

async function getArtistFullInfo(artist: string, username: string): Promise<any> {
  const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(artist)}&username=${encodeURIComponent(username)}&autocorrect=1&format=json`;
  const res = await fetchWithTimeout(url);
  const data = await res.json() as any;
  return data.artist || null;
}

async function getServerStats(guild: any, artist: string): Promise<{ listeners: number; totalPlays: number; avg: number; weeklyPlays: number }> {
  const allLinkedIds = getLinkedUserIds();
  if (allLinkedIds.length === 0) return { listeners: 0, totalPlays: 0, avg: 0, weeklyPlays: 0 };
  
  let linkedMembers;
  try {
      linkedMembers = await guild.members.fetch({ user: allLinkedIds }); 
  } catch {
      linkedMembers = guild.members.cache.filter((m: any) => allLinkedIds.includes(m.id));
  }
  
  const linkedData: { data: NonNullable<ReturnType<typeof getUser>> }[] = [];
  linkedMembers.forEach((m: GuildMember) => {
    const d = getUser(m.id);
    if (d) linkedData.push({ data: d });
  });

  let listeners = 0;
  let totalPlays = 0;
  let weeklyPlays = 0;

  const chunks = [];
  for (let i = 0; i < linkedData.length; i += 5) {
      chunks.push(linkedData.slice(i, i + 5));
  }

  for (const chunk of chunks) {
      await Promise.all(chunk.map(async (l) => {
         try {
            const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(artist)}&username=${encodeURIComponent(l.data.username)}&format=json&autocorrect=1`;
            const res = await fetchWithTimeout(url);
            const d = await res.json() as any;
            const p = safeNum(d.artist?.stats?.userplaycount);
            if (p > 0) {
               listeners++;
               totalPlays += p;
               try {
                   const w = await getUserWeeklyArtistPlays(l.data.username, artist, l.data.sessionKey);
                   weeklyPlays += w;
               } catch {}
            }
         } catch {}
      }));
  }
  
  const avg = listeners > 0 ? Math.round(totalPlays / listeners) : 0;
  return { listeners, totalPlays, avg, weeklyPlays };
}

async function getSpotifyArtistUrl(artist: string): Promise<string | null> {
  try {
    const accessToken = await getSpotifyAccessToken();
    const query = `artist:${encodeURIComponent(artist)}`;
    const res = await fetchWithTimeout(`https://api.spotify.com/v1/search?q=${query}&type=artist&limit=1`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json() as any;
    return data.artists?.items?.[0]?.external_urls?.spotify || null;
  } catch { return null; }
}

/* --- Command Data --- */

export const data = new SlashCommandBuilder()
  .setName("at")
  .setDescription("Show your top tracks for an artist")
  .addStringOption((option: SlashCommandStringOption) =>
    option.setName("artist").setDescription("The artist to show top tracks for").setRequired(false)
  )
  .addUserOption(option =>
    option.setName("user").setDescription("The user to show for (defaults to you)").setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const isPrefix = (interaction as any).isPrefix;
  if (isPrefix) {
    try { (interaction.channel as TextChannel).sendTyping(); } catch {}
  }

  const target = interaction.options.getUser("user") || interaction.user;
  let displayName = target.username;
  let avatarURL = target.displayAvatarURL({ size: 128 });

  if (interaction.guild) {
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (member) {
        displayName = member.displayName;
        avatarURL = member.displayAvatarURL({ size: 128 });
    }
  }

  const linkedUser = getUser(target.id);
  if (!linkedUser) {
    const msg = target.id === interaction.user.id
      ? "❌ You haven’t linked your Last.fm account yet. Use `/link` first."
      : `❌ ${displayName} hasn’t linked their Last.fm account yet.`;
    if (isPrefix) await interaction.reply({ content: msg });
    else await interaction.reply({ content: msg, ephemeral: true });
    return;
  }

  if (!isPrefix) await interaction.deferReply();
  const { username, sessionKey } = linkedUser;

  try {
    let inputArtist = interaction.options.getString("artist") || "";
    if (!inputArtist) {
      const recent = await getRecent(target.id);
      inputArtist = recent.artist;
    }
    inputArtist = inputArtist.trim();

    const fullArtistInfo = await getArtistFullInfo(inputArtist, username);
    if (!fullArtistInfo) {
      const msg = `⚠️ Artist "${inputArtist}" not found on Last.fm.`;
      if (isPrefix) await interaction.reply(msg); else await interaction.editReply(msg);
      return;
    }

    const artist = fullArtistInfo.name; 
    const totalScrobbles = safeNum(fullArtistInfo.stats?.userplaycount);
    const mbid = fullArtistInfo.mbid;

    // Cleaned Bio
    const bio = stripHtml(fullArtistInfo.bio?.content || fullArtistInfo.bio?.summary || "");

    const artistUrl = fullArtistInfo.url;
    const globalListeners = safeNum(fullArtistInfo.stats?.listeners);
    const globalPlays = safeNum(fullArtistInfo.stats?.playcount);
    const tagList = toArray<any>(fullArtistInfo.tags?.tag);
    const tags = tagList.map((t: any) => t.name.toLowerCase());

    // --- Parallel Fetches ---
    const [mbInfo, userTotal, weekly, serverStats, imageInfo] = await Promise.all([
        fetchMusicBrainzInfo(mbid),
        getUserTotalPlays(username),
        getUserWeeklyArtistPlays(username, artist, sessionKey),
        getServerStats(interaction.guild, artist),
        getImage('artist', { artist })
    ]);

    const socials = mbInfo.socials;
    const spotifyUrl = socials.spotify || await getSpotifyArtistUrl(artist);

    // --- FETCH TRACKS ---
    let topTracks: { name: string; count: number }[] = [];
    if (totalScrobbles > 0) {
        topTracks = await fetchAllUserArtistTracks(username, artist, sessionKey);
    }
    if (topTracks.length === 0 && totalScrobbles > 0) {
        topTracks = await fetchUserCountsFromGlobalTracks(username, sessionKey, artist);
        topTracks.sort((a, b) => b.count - a.count);
    }

    // --- FETCH ALBUMS (Deep Scan) ---
    let topAlbums = await fetchUserTopAlbumsDeep(username, artist);

    const uniqueTracks = topTracks.length;
    const uniqueAlbums = topAlbums.length;
    const percent = userTotal > 0 ? ((totalScrobbles / userTotal) * 100).toFixed(2) : "0.00";
    const image = imageInfo?.url || null;
    const imageSourceLabel = imageInfo?.source === 'spotify' ? 'Spotify' : imageInfo?.source === 'lastfm' ? 'Last.fm' : 'Unknown';

    // --- BUILD DESCRIPTION ---
    const buildDescription = () => {
        // 1. Determine Type (Person, Group) and Noun (Rapper, Artist)
        let type = mbInfo.type || "Artist";
        let typeNoun = type;

        // If tag contains rap/hip-hop and it's a person, call them a Rapper
        const isRapper = tags.some(t => t.includes("rap") || t.includes("hip hop") || t.includes("hip-hop"));
        if (type === "Person" && isRapper) {
            typeNoun = "Rapper";
        }
        else if (type === "Group") {
             if (tags.includes("band") || tags.includes("rock")) typeNoun = "Band";
             else typeNoun = "Group";
        }

        // 2. Determine Demonym
        // First try MusicBrainz Area
        let location = mbInfo.area || "";
        let demonym = getDemonym(location);

        // Fallback: check tags for country names if demonym is missing
        if (!demonym) {
            for (const t of tags) {
                const d = getDemonym(t);
                if (d) {
                    demonym = d;
                    break;
                }
            }
        }

        // 3. Determine Genre Tag (exclude the demonym if it appears in tags)
        let genreTag = tags[0] || "";
        // If the first tag is just the country (e.g. "palestine"), skip to the next tag
        if (genreTag && getDemonym(genreTag) && tags.length > 1) {
             genreTag = tags[1];
        }
        
        // 4. Build Line 1: **[Demonym] [Genre] [Type]** from **[Location]**
        let descLine1 = "**";
        if (demonym) descLine1 += `${demonym} `;
        
        // Only add genre if it's not part of the noun (e.g. avoid "Rap Rapper")
        if (genreTag && !typeNoun.toLowerCase().includes(genreTag.toLowerCase())) {
             descLine1 += `${toTitleCase(genreTag)} `;
        }
        
        descLine1 += `${typeNoun}**`; // e.g. "**Palestinian Rapper**"

        if (location) {
            descLine1 += ` from **${location}**`;
        }

        let desc = `${descLine1}\n`;

        // 5. Line 2: Type - Gender (e.g. "Person - Male")
        let entityTypeLine = type; 
        if (mbInfo.gender) {
            entityTypeLine += ` - ${mbInfo.gender}`; 
        }
        desc += `${toTitleCase(entityTypeLine)}\n`;

        // 6. Line 3: Dates
        if (mbInfo.lifeSpan?.begin) {
            const dateStr = mbInfo.lifeSpan.begin; 
            const parts = dateStr.split("-");
            const date = new Date(Date.UTC(parseInt(parts[0]), (parseInt(parts[1] || "1") - 1), parseInt(parts[2] || "1")));
            const ts = Math.floor(date.getTime() / 1000);
            const verb = (type === "Person") ? "Born" : "Started";
            desc += `${verb}: <t:${ts}:D>`;
            
            if (mbInfo.lifeSpan.end) {
                const endParts = mbInfo.lifeSpan.end.split("-");
                const endDate = new Date(Date.UTC(parseInt(endParts[0]), (parseInt(endParts[1] || "1") - 1), parseInt(endParts[2] || "1")));
                const endTs = Math.floor(endDate.getTime() / 1000);
                const endVerb = (type === "Person") ? "Died" : "Stopped";
                desc += `\n${endVerb}: <t:${endTs}:D>`;
            }
        }
        return desc;
    };

    const coolDescription = buildDescription();

    const buildTrackEmbed = (page: number) => {
        const perPage = 10;
        const maxPage = Math.max(1, Math.ceil(uniqueTracks / perPage));
        const startIdx = (page - 1) * perPage;
        const slice = topTracks.slice(startIdx, startIdx + perPage);
        let desc = slice.map((t, i) => `${startIdx + i + 1}. **${t.name}** - *${formatPlay(t.count)}*`).join('\n');
        if (!desc) desc = "No individual tracks found.";
        const footerLines = [
            `Page ${page}/${maxPage} - ${uniqueTracks} different tracks`,
            `${displayName} has ${totalScrobbles} total scrobbles on this artist`,
            "Some tracks outside of top 6000 might not be visible"
        ];
        return new EmbedBuilder()
            .setColor(0xBA2000)
            .setAuthor({ name: `Your top tracks for '${artist}'`, iconURL: avatarURL, url: artistUrl })
            .setDescription(desc)
            .setFooter({ text: footerLines.join("\n") });
    };

    const buildAlbumEmbed = (page: number) => {
        const perPage = 10;
        const maxPage = Math.max(1, Math.ceil(uniqueAlbums / perPage));
        const startIdx = (page - 1) * perPage;
        const slice = topAlbums.slice(startIdx, startIdx + perPage);
        let desc = slice.map((t, i) => `\`${startIdx + i + 1}\` **${t.name}** - *${t.count}x*`).join('\n');
        if (!desc) desc = "No albums found.";
        const footerLines = [
            "Some albums outside of top 5,000 might not be visible",
            `Page ${page}/${maxPage} - ${displayName} has ${totalScrobbles} total scrobbles on this artist`
        ];
        return new EmbedBuilder()
            .setColor(0xBA2000)
            .setAuthor({ name: `Your top albums for '${artist}'`, iconURL: avatarURL, url: `https://www.last.fm/user/${username}/library/music/${encodeURIComponent(artist)}` })
            .setDescription(desc)
            .setFooter({ text: footerLines.join("\n") });
    };

    const buildOverviewEmbed = () => {
         const trackList = topTracks.slice(0, 8).map((t, i) => `\`${i+1}\` **${t.name}** - *${t.count}x*`).join('\n') || "No tracks found";
         const albumList = topAlbums.slice(0, 8).map((t, i) => `\`${i+1}\` **${t.name}** - *${t.count}x*`).join('\n') || "No albums found";
         
         const desc = `-# *${totalScrobbles} plays on this artist${weekly >= 0 ? ` — ${weekly} plays last week` : ""}*`;

         return new EmbedBuilder()
            .setColor(0xBA2000)
            .setAuthor({ name: `Artist overview about ${artist} for ${displayName}`, iconURL: avatarURL, url: artistUrl })
            .setDescription(desc)
            .addFields(
                { name: "Your top tracks", value: trackList, inline: true },
                { name: "Your top albums", value: albumList, inline: true }
            )
            .setFooter({ text: `${percent}% of all your scrobbles are on this artist` });
    };

    // --- ARTIST EMBED ---
    const buildArtistEmbed = () => {
         const serverStr = `\`${serverStats.listeners}\` listener${serverStats.listeners === 1 ? "" : "s"}\n` +
            `\`${serverStats.totalPlays}\` total plays\n` +
            `\`${serverStats.avg}\` avg plays\n` +
            `\`${serverStats.weeklyPlays}\` plays last week`;
         
         const globalStr = `\`${globalListeners.toLocaleString()}\` listeners\n` +
            `\`${globalPlays.toLocaleString()}\` global plays\n` +
            `\`${totalScrobbles}\` plays by you\n` +
            `\`${weekly}\` by you last week`;

         // Smart Truncate Summary (~380 chars)
         let trimmedBio = bio;
         if (trimmedBio.length > 380) {
             const cut = trimmedBio.slice(0, 380);
             const lastDot = cut.lastIndexOf(".");
             trimmedBio = lastDot > 0 ? cut.slice(0, lastDot + 1) : cut + "...";
         }
         
         const embed = new EmbedBuilder()
            .setColor(0xBA2000)
            .setAuthor({ name: `Artist: ${artist} for ${displayName}`, iconURL: avatarURL, url: artistUrl });
         
         if (coolDescription) embed.setDescription(coolDescription);
         if (image) embed.setThumbnail(image);

         embed.addFields(
            { name: "Server stats", value: serverStr, inline: true },
            { name: "Last.fm stats", value: globalStr, inline: true }
         );

         if (trimmedBio) {
            embed.addFields({ name: "Summary", value: trimmedBio, inline: false });
         }

         // Updated Footer: Genres list instead of POV
         const footerLines = [
            `Image source: ${imageSourceLabel}`,
            `${percent}% of all your plays are on this artist`,
         ];
         
         // Join top 5 genres with " - "
         if (tags.length > 0) {
             const genreStr = tags.slice(0, 5).join(" - ");
             footerLines.push(genreStr);
         }
         
         embed.setFooter({ text: footerLines.join("\n") });

         return embed;
    };

    const getRows = (state: 'tracks' | 'albums' | 'overview' | 'artist', page: number) => {
        const rows: ActionRowBuilder<ButtonBuilder>[] = [];
        
        if (state === 'tracks' || state === 'albums') {
            const total = state === 'tracks' ? uniqueTracks : uniqueAlbums;
            const max = Math.max(1, Math.ceil(total / 10));
            
            const row = new ActionRowBuilder<ButtonBuilder>();
            if (max > 1) {
                row.addComponents(
                    new ButtonBuilder().setCustomId('first').setEmoji({ name: "pages_first", id: "883825508633182208" }).setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
                    new ButtonBuilder().setCustomId('prev').setEmoji({ name: "pages_previous", id: "883825508507336704" }).setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
                    new ButtonBuilder().setCustomId('next').setEmoji({ name: "pages_next", id: "883825508087922739" }).setStyle(ButtonStyle.Secondary).setDisabled(page >= max),
                    new ButtonBuilder().setCustomId('last').setEmoji({ name: "pages_last", id: "883825508482183258" }).setStyle(ButtonStyle.Secondary).setDisabled(page >= max)
                );
            }
            row.addComponents(
                new ButtonBuilder().setCustomId('to_overview').setEmoji("📊").setStyle(ButtonStyle.Secondary)
            );
            rows.push(row);
        }
        else if (state === 'overview') {
            const navRow = new ActionRowBuilder<ButtonBuilder>();
            navRow.addComponents(
                new ButtonBuilder().setCustomId('to_artist').setEmoji({ name: "fmbot_info", id: "1183840696457777153" }).setLabel("Artist").setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('to_tracks').setEmoji("🎶").setLabel("All top tracks").setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('to_albums').setEmoji("💽").setLabel("All top albums").setStyle(ButtonStyle.Secondary)
            );
            rows.push(navRow);
        }
        else if (state === 'artist') {
             const allSocials: ButtonBuilder[] = [];

             if (spotifyUrl) allSocials.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(spotifyUrl).setEmoji({ name: "services_spotify", id: "882221219334725662" }));
             if (socials.apple) allSocials.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(socials.apple).setEmoji({ name: "services_apple_music", id: "1218182727149420544" }));
             if (socials.instagram) allSocials.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(socials.instagram).setEmoji({ name: "social_instagram", id: "1183829878458548224" }));
             if (socials.twitter) allSocials.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(socials.twitter).setEmoji({ name: "social_twitter", id: "1183831922917511298" }));
             if (socials.bandcamp) allSocials.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(socials.bandcamp).setEmoji({ name: "social_bandcamp", id: "1183838619270643823" }));
             
             if (allSocials.length === 0) {
                allSocials.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(artistUrl).setEmoji({ name: "services_lastfm", id: "882227627287515166" }));
             }

             const displayedSocials = allSocials.slice(0, 4);
             displayedSocials.push(new ButtonBuilder().setCustomId('to_overview').setEmoji("📊").setStyle(ButtonStyle.Secondary));

             const row = new ActionRowBuilder<ButtonBuilder>().addComponents(displayedSocials);
             rows.push(row);
        }

        return rows;
    };

    // --- DEFAULT STATE = TRACKS ---
    let currentState: 'tracks' | 'albums' | 'overview' | 'artist' = topTracks.length > 0 ? 'tracks' : 'overview';
    let currentPage = 1;

    let embed = currentState === 'tracks' ? buildTrackEmbed(1) : buildOverviewEmbed();
    let components = getRows(currentState, 1);

    const replyObj = { content: '', embeds: [embed], components: components };
    const sent = isPrefix ? await interaction.reply(replyObj) : await interaction.editReply(replyObj);

    const collector = (sent as Message).createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 });

    collector.on('collect', async (i) => {
        if (i.user.id !== interaction.user.id) {
            await i.reply({ content: "Not your command.", ephemeral: true });
            return;
        }
        await i.deferUpdate();

        const id = i.customId;
        
        if (id === 'to_overview') { currentState = 'overview'; }
        else if (id === 'to_artist') { currentState = 'artist'; }
        else if (id === 'to_tracks') { currentState = 'tracks'; currentPage = 1; }
        else if (id === 'to_albums') { currentState = 'albums'; currentPage = 1; }
        else if (id === 'first') currentPage = 1;
        else if (id === 'prev') currentPage = Math.max(1, currentPage - 1);
        else if (id === 'next') currentPage++;
        else if (id === 'last') {
             const total = currentState === 'tracks' ? uniqueTracks : uniqueAlbums;
             currentPage = Math.max(1, Math.ceil(total / 10));
        }

        let newEmbed;
        if (currentState === 'tracks') newEmbed = buildTrackEmbed(currentPage);
        else if (currentState === 'albums') newEmbed = buildAlbumEmbed(currentPage);
        else if (currentState === 'overview') newEmbed = buildOverviewEmbed();
        else newEmbed = buildArtistEmbed();

        await i.editReply({ embeds: [newEmbed], components: getRows(currentState, currentPage) });
    });

    collector.on('end', async () => {
        try {
            const dis = getRows(currentState, currentPage).map(row => {
                row.components.forEach(c => c.setDisabled(true));
                return row;
            });
            await (sent as Message).edit({ components: dis });
        } catch {}
    });

  } catch (err) {
      console.error(err);
      const msg = "⚠️ Error fetching data.";
      if (isPrefix) await interaction.reply(msg); else await interaction.editReply(msg);
  }
}

export async function prefixExecute(message: Message, args: string[]) {
  const { map, unnamed } = parseArgs(args);
  let artist = map.artist || unnamed.join(' ');
  let simArgs = artist ? [`--artist=${artist}`] : [];
  const interaction = createInteractionFromMessage(message, simArgs);
  await execute(interaction as any);
}