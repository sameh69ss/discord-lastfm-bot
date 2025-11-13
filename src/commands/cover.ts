// src/commands/cover.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  Message,
  TextChannel,
  ButtonInteraction,
  ComponentType,
} from "discord.js";
import { SlashCommandStringOption } from "@discordjs/builders";
import { createInteractionFromMessage, parseArgs } from "../scripts/prefixAdapter";
import fetch from "node-fetch";
import { createCanvas, loadImage } from "canvas";
import { getUser } from "../scripts/storage";
import dotenv from "dotenv";

dotenv.config();

const LASTFM_API_KEY = process.env.LASTFM_API_KEY!;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID!;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET!;
const FM_COLOR = 0xd51007;
const MARKET = "EG";

async function getSpotifyToken(): Promise<string> {
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
  return data.access_token;
}

async function fetchSpotifyInfo(
  trackName: string,
  artist?: string
): Promise<{ image: string | null; trackUrl: string | null; albumName: string | null; resolvedArtist: string | null }> {
  try {
    const token = await getSpotifyToken();
    let query = `track:${encodeURIComponent(trackName)}`;
    if (artist) {
      query += ` artist:${encodeURIComponent(artist)}`;
    }
    const res = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = (await res.json()) as any;
    const trackItem = data.tracks?.items?.[0];

    return {
      image: trackItem?.album?.images?.[0]?.url || null,
      trackUrl: trackItem?.external_urls?.spotify || null,
      albumName: trackItem?.album?.name || null,
      resolvedArtist: trackItem?.artists?.[0]?.name || null,
    };
  } catch (err) {
    console.error("⚠️ Spotify fetch error:", err);
    return { image: null, trackUrl: null, albumName: null, resolvedArtist: null };
  }
}

interface LastfmRecentResponse {
  recenttracks?: { track?: any[] | any };
  error?: number;
  message?: string;
}

interface LastfmTrackInfoResponse {
  track?: {
    album?: { title: string; image: Array<{ '#text': string; size: string }> };
  };
  error?: number;
  message?: string;
}

interface SpotifyAlbumSearchResult {
  albums: {
    items: Array<{
      name: string;
      artists: Array<{ name: string }>;
      images: Array<{ url: string }>;
    }>;
  };
}

async function fetchLastfmTrackInfo(artist: string, trackName: string): Promise<{ image: string | null; albumName: string | null }> {
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=track.getinfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(trackName)}&format=json`;
    const res = await fetch(url);
    const data = await res.json() as LastfmTrackInfoResponse;
    if (data.error || !data.track) {
      return { image: null, albumName: null };
    }
    const image = data.track.album?.image?.find(i => i.size === 'extralarge')?.['#text'] || data.track.album?.image?.[0]?.['#text'] || null;
    const albumName = data.track.album?.title || null;
    return { image, albumName };
  } catch (err) {
    console.error("⚠️ Last.fm track info error:", err);
    return { image: null, albumName: null };
  }
}

function safeNum(v: unknown) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

async function searchSpotifyAlbum(artist: string, album: string, expectedTrackCount?: number | null) {
  try {
    const token = await getSpotifyToken();
    if (!token) return null;

    const queries = [
      `artist:${artist} album:${album}`,
      `${artist} ${album}`,
      `${album}`,
      `${artist} ${album.replace(/["'’]/g, "")}`,
    ];

    let item: any = null;
    for (const rawQ of queries) {
      const q = encodeURIComponent(rawQ);
      const res = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=album&limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as any;
      item = data.albums?.items?.[0];
      if (item) break;
    }

    if (!item) {
      try {
        const artQ = encodeURIComponent(artist);
        const artRes = await fetch(`https://api.spotify.com/v1/search?q=${artQ}&type=artist&limit=1`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (artRes.ok) {
          const artData = (await artRes.json()) as any;
          const artistItem = artData.artists?.items?.[0];
          if (artistItem && artistItem.id) {
            const candidates: any[] = [];
            const pageLimit = 50;
            let offset = 0;
            const maxCandidates = 500;
            while (true) {
              const albumsRes = await fetch(`https://api.spotify.com/v1/artists/${artistItem.id}/albums?include_groups=album,single,compilation&limit=${pageLimit}&offset=${offset}`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (!albumsRes.ok) break;
              const albumsData = (await albumsRes.json()) as any;
              const pageItems = albumsData.items ?? [];
              candidates.push(...pageItems);
              if (pageItems.length < pageLimit) break;
              if (candidates.length >= maxCandidates) break;
              offset += pageLimit;
            }

            if (candidates.length > 0) {
              const stripEdition = (s: string) =>
                String(s || "")
                  .toLowerCase()
                  .replace(/\b(deluxe|delux|edition|expanded|expanded edition|remaster(?:ed)?|bonus|anniversary|reissue|special)\b/gi, "")
                  .replace(/[^\w\s]/g, "")
                  .replace(/\s+/g, " ")
                  .trim();

              const normalize = (s: string) => String(s || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();

              const levenshtein = (a: string, b: string) => {
                if (a === b) return 0;
                const al = a.length;
                const bl = b.length;
                if (al === 0) return bl;
                if (bl === 0) return al;
                const v0 = new Array(bl + 1).fill(0).map((_, i) => i);
                const v1 = new Array(bl + 1).fill(0);
                for (let i = 0; i < al; i++) {
                  v1[0] = i + 1;
                  for (let j = 0; j < bl; j++) {
                    const cost = a[i] === b[j] ? 0 : 1;
                    v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
                  }
                  for (let j = 0; j <= bl; j++) v0[j] = v1[j];
                }
                return v1[bl];
              };

              const targetNorm = normalize(album);
              const targetStripped = stripEdition(album);
              let best: { score: number; item: any } | null = null;
              for (const cand of candidates) {
                const candNorm = normalize(cand.name || "");
                if (!candNorm) continue;
                const candStripped = stripEdition(cand.name || "");
                if (candStripped && targetStripped && candStripped === targetStripped) {
                  best = { score: 1, item: cand };
                  break;
                }
                const tTokens = targetNorm.split(' ').filter(Boolean);
                const cTokens = candNorm.split(' ').filter(Boolean);
                const inter = tTokens.filter((t) => cTokens.includes(t));
                const overlap = inter.length / Math.max(tTokens.length || 1, cTokens.length || 1);
                const maxLen = Math.max(targetNorm.length, candNorm.length);
                const dist = levenshtein(targetNorm, candNorm);
                const levSim = maxLen > 0 ? 1 - dist / maxLen : 0;
                let combined = Math.max(overlap, levSim);

                const hasDeluxeInCand = /\b(deluxe|delux)\b/i.test(cand.name || "");
                const hasDeluxeInTarget = /\b(deluxe|delux)\b/i.test(album || "");
                if (hasDeluxeInCand && !hasDeluxeInTarget) combined *= 0.8;

                try {
                  const candTracks = Number(cand.total_tracks ?? cand.tracks?.total ?? 0) || 0;
                  if (expectedTrackCount && candTracks > 0) {
                    const trackMatchScore = 1 - Math.min(1, Math.abs(candTracks - expectedTrackCount) / Math.max(expectedTrackCount, candTracks, 1));
                    combined = combined * 0.7 + trackMatchScore * 0.3;
                  }
                } catch {}

                if (!best || combined > best.score) best = { score: combined, item: cand };
              }
              if (best && best.score >= 0.65) item = best.item;
            }
          }
        }
      } catch {}
    }

    if (!item) return null;

    const albumId = item.id;
    const fullRes = await fetch(`https://api.spotify.com/v1/albums/${albumId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!fullRes.ok) return { spotifyAlbumId: albumId, cover: item.images?.[0]?.url ?? null, url: item.external_urls?.spotify ?? null, label: null, release_date: item.release_date ?? null, images: [], spotifyTrackDurations: {}, id: albumId };
    const fullData = (await fullRes.json()) as any;

    let label = fullData.label ?? null;
    if (!label && fullData.copyrights?.length > 0) {
      const copyrightText = fullData.copyrights[0]?.text || '';
      const match = copyrightText.match(/℗ \d{4} (.*)/);
      if (match) label = match[1].trim();
    }

    const trackDurations: Record<string, number> = {};
    try {
      const items = fullData.tracks?.items ?? [];
      for (const it of items) {
        if (!it || !it.name) continue;
        const nameNorm = String(it.name || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
        const durMs = Number(it.duration_ms ?? 0) || 0;
        trackDurations[nameNorm] = Math.round(durMs / 1000);
      }
    } catch {}

    return {
      spotifyAlbumId: albumId,
      images: Array.isArray(fullData.images) ? fullData.images : [],
      cover: fullData.images?.[0]?.url ?? null,
      url: fullData.external_urls?.spotify ?? null,
      label: label,
      release_date: fullData.release_date ?? null,
      spotifyTrackDurations: trackDurations,
      id: albumId,
    };
  } catch {
    return null;
  }
}

async function fetchSpotifyAlbumTracks(spotifyAlbumId: string, market: string | null = null): Promise<{ name: string; duration: number; track_number: number }[] | null> {
  try {
    const token = await getSpotifyToken();
    if (!token) return null;
    const limit = 50;
    let offset = 0;
    const out: { name: string; duration: number; track_number: number }[] = [];
    while (true) {
      const url = `https://api.spotify.com/v1/albums/${spotifyAlbumId}/tracks?limit=${limit}&offset=${offset}${market ? `&market=${market}` : ""}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) break;
      const data = (await res.json()) as any;
      const items = data.items ?? [];
      for (const it of items) {
        out.push({ name: it.name || "Unknown", duration: Math.round((it.duration_ms ?? 0) / 1000), track_number: Number(it.track_number ?? 0) });
      }
      if (items.length < limit) break;
      offset += limit;
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

async function fetchLabelFromMusicBrainz(mbid: string) {
  try {
    if (!mbid) return null;
    const res = await fetch(`https://musicbrainz.org/ws/2/release/${mbid}?fmt=json&inc=labels`);
    if (res.ok) {
      const data: any = await res.json();
      const lab = data?.["label-info"]?.[0]?.label?.name || data?.labels?.[0]?.name || null;
      if (lab) return lab;
    }
    const res2 = await fetch(`https://musicbrainz.org/ws/2/release-group/${mbid}?fmt=json&inc=releases`);
    if (res2.ok) {
      const data2: any = await res2.json();
      const rel = data2?.releases?.[0];
      const lab = rel?.["label-info"]?.[0]?.label?.name || null;
      if (lab) return lab;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchLastFmJson(url: string) {
  const res = await fetch(url);
  return await res.json();
}

function secondsToTimeString(s: number) {
  if (s <= 0) return "0 minutes";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  let str = '';
  if (h > 0) str += `${h} hour${h > 1 ? 's' : ''}`;
  if (h > 0 && m > 0) str += ', ';
  if (m > 0) str += `${m} minute${m > 1 ? 's' : ''}`;
  return str;
}

function secondsToHMMSS(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  } else {
    return `${m}:${String(sec).padStart(2, '0')}`;
  }
}

const cmd = {
  data: new SlashCommandBuilder()
    .setName("cover")
    .setDescription("Show the album cover of your currently playing or last played track.")
    .addUserOption((option) =>
      option.setName("user").setDescription("Show album cover for another user.")
    )
    .addStringOption((option: SlashCommandStringOption) =>
      option.setName("track").setDescription("The track to get the cover for").setRequired(false)
    )
    .addStringOption((option: SlashCommandStringOption) =>
      option.setName("artist").setDescription("The artist (optional)").setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const isPrefix = (interaction as any).isPrefix;
    if (isPrefix) {
      try {
        (interaction.channel as TextChannel).sendTyping();
      } catch (err) {
        console.warn("Typing indicator failed:", err);
      }
    }

    if (!isPrefix) {
      await interaction.deferReply();
    }
    const replyMethod = isPrefix ? "reply" : "editReply";

    let artist: string;
    let trackName: string;
    let album: string;
    let finalImageUrl: string | null = null;
    let finalSpotifyUrl: string | null = null;
    
    let targetUsername: string;
    let sessionKey: string;

    try {
      const targetUser = interaction.options.getUser("user") || interaction.user;
      const trackOpt = interaction.options.getString("track")?.trim();
      const artistOpt = interaction.options.getString("artist")?.trim();

      const userData = getUser(targetUser.id);
      if (!userData) {
        await interaction[replyMethod]({
          content: "❌ This user hasn’t linked their Last.fm account yet. Use `/link` first."
        });
        return;
      }
      targetUsername = userData.username;
      sessionKey = userData.sessionKey;

      if (trackOpt || artistOpt) {
        if (!trackOpt) {
          throw new Error("Need track name");
        }
        trackName = trackOpt;

        const spotifyInfo = await fetchSpotifyInfo(trackName, artistOpt);

        if (!spotifyInfo.resolvedArtist && !artistOpt) {
          throw new Error(`No matching track found for "${trackName}"`);
        }

        artist = artistOpt || spotifyInfo.resolvedArtist!;
        album = spotifyInfo.albumName || "Unknown Album";
        finalImageUrl = spotifyInfo.image;
        finalSpotifyUrl = spotifyInfo.trackUrl;

        if (!finalImageUrl || album === "Unknown Album") {
          const lastfmInfo = await fetchLastfmTrackInfo(artist, trackName);
          if (lastfmInfo.image) finalImageUrl = lastfmInfo.image;
          if (lastfmInfo.albumName) album = lastfmInfo.albumName;
        }

        if (!finalSpotifyUrl) {
          finalSpotifyUrl = `https://open.spotify.com/search/${encodeURIComponent(`${artist} ${trackName}`)}`;
        }
      
      } else {
        const apiKey = LASTFM_API_KEY;
        const recentUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(targetUsername)}&api_key=${apiKey}&limit=1&format=json&sk=${encodeURIComponent(sessionKey)}`;
        const recentRes = await fetch(recentUrl);
        const recentData = await recentRes.json() as LastfmRecentResponse;

        const track = recentData.recenttracks?.track?.[0];
        if (!track) {
          await interaction[replyMethod]({ content: "⚠️ No recent tracks found." });
          return;
        }

        artist = track.artist?.["#text"] ?? "Unknown Artist";
        album = track.album?.["#text"] ?? "Unknown Album";
        trackName = track.name ?? "Unknown Track";

        const spotifyInfo = await fetchSpotifyInfo(trackName, artist);
        finalImageUrl = spotifyInfo.image;
        finalSpotifyUrl = spotifyInfo.trackUrl;

        if (!finalImageUrl) {
          finalImageUrl =
            track.image?.[track.image.length - 1]?.["#text"] ??
            track.image?.[0]?.["#text"] ??
            null;
        }
        
        if (!finalSpotifyUrl) {
           finalSpotifyUrl = `https://open.spotify.com/search/${encodeURIComponent(`${artist} ${trackName}`)}`;
        }
      }

      if (!finalImageUrl) {
        await interaction[replyMethod]({ content: "⚠️ No album artwork found for this track." });
        return;
      }
      
      if (album === "Unknown Album") {
           await interaction[replyMethod]({ content: "⚠️ Could not determine album for this track." });
           return;
      }

      const imgRes = await fetch(finalImageUrl);
      const arrayBuffer = await imgRes.arrayBuffer();
      const img = await loadImage(Buffer.from(arrayBuffer));
      const canvas = createCanvas(640, 640);
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      (ctx as any).imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, 640, 640);
      const buffer = canvas.toBuffer("image/jpeg", { quality: 0.95 });

      const artistUrl = `https://www.last.fm/music/${encodeURIComponent(artist)}`;
      const albumUrl = `https://www.last.fm/music/${encodeURIComponent(artist)}/${encodeURIComponent(album)}`;
      const trackUrlLastfm = `https://www.last.fm/music/${encodeURIComponent(artist)}/_/${encodeURIComponent(trackName)}`;
      
      const attachment = new AttachmentBuilder(buffer, { name: 'cover.jpg' });

      const contentString = `**[${artist}](${artistUrl}) — [${album}](${albumUrl})**\n[${trackName}](${trackUrlLastfm})\n-# Requested by ${interaction.user.displayName}`;
      const coverEmbed = new EmbedBuilder()
        .setColor(FM_COLOR)
        .setDescription(contentString);

      const spotifyBtn = new ButtonBuilder()
        .setLabel("Spotify")
        .setStyle(ButtonStyle.Link)
        .setURL(finalSpotifyUrl)
        .setEmoji("<:Spotify_icon:1438540261713248390>"); // <-- Make sure this ID is correct

      const albumBtn = new ButtonBuilder()
        .setCustomId("show_album")
        .setLabel("Album")
        .setEmoji("💽")
        .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(spotifyBtn, albumBtn);

      if (isPrefix) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      
      const sent = await interaction[replyMethod]({
        content: '',
        files: [attachment],
        embeds: [coverEmbed],
        components: [row],
      }) as Message;
      
      // --- START: Recursive Collector Fix ---
      // Define a function that creates the "cover" collector
      const startCoverCollector = () => {
        const collector = sent.createMessageComponentCollector({ componentType: ComponentType.Button, time: 5 * 60 * 1000 });

        collector.on("collect", async (btnInt: ButtonInteraction) => {
          if (btnInt.customId !== 'show_album') return;

          try {
            await btnInt.deferUpdate();
            collector.stop(); // Stop this collector
            
            // --- All album logic is fetched *inside* the click ---
            const albumInfoUrl = `https://ws.audioscrobbler.com/2.0/?method=album.getInfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(
              artist
            )}&album=${encodeURIComponent(album)}&format=json&autocorrect=1`;
            const albumInfo = (await fetchLastFmJson(albumInfoUrl)) as any;

            if (albumInfo?.error || !albumInfo?.album) {
              await btnInt.followUp({ content: "⚠️ Could not find that album on Last.fm.", ephemeral: true });
              startCoverCollector(); // Re-start this collector on failure
              return;
            }
            
            const albumData = albumInfo.album;
            const globalListeners = safeNum(albumData.listeners);
            const globalPlaycount = safeNum(albumData.playcount);
            let releaseDateRaw = albumData?.wiki?.published || albumData?.releasedate?.trim() || null;
            
            // --- START: Timestamp Logic ---
            let releaseDateString = "Unknown";
            let dateToParse: string | null = null;
            let coverUrl: string | null = null; // Defined early
            let spotifyAlbumUrl: string | null = null; // Defined early
            let spotifyLabel: string | null = null; // Defined early
            let spotifyReleaseDate: string | null = null; // Defined early
            
            let isSingle = false;
            let isEP = false;
            let tracksArray: any[] = [];
            let spotifyTrackDurations: Record<string, number> = {};
            let albumImageSource = "Last.fm";
            let spotifyAlbumId: string | null = null;

            const sp = await searchSpotifyAlbum(artist, album, null);
            if (sp && sp.spotifyAlbumId) {
              spotifyAlbumId = sp.spotifyAlbumId;
              spotifyTrackDurations = sp.spotifyTrackDurations ?? {};
              spotifyAlbumUrl = sp.url ?? null;
              spotifyLabel = sp.label ?? null;
              spotifyReleaseDate = sp.release_date ?? null; // Get Spotify date
              if (Array.isArray(sp.images) && sp.images.length > 0) {
                coverUrl = sp.images[0]?.url ?? null;
                albumImageSource = "Spotify";
              } else if ((sp as any).cover) {
                coverUrl = (sp as any).cover;
                albumImageSource = "Spotify";
              }

              const spotifyTracks = await fetchSpotifyAlbumTracks(spotifyAlbumId ?? "", MARKET);
              if (spotifyTracks && spotifyTracks.length > 0) {
                tracksArray = spotifyTracks.map((t) => ({ name: t.name, duration: t.duration, track_number: t.track_number }));
              }
            }
            
            if (spotifyReleaseDate) {
                if (spotifyReleaseDate.match(/^\d{4}$/)) { 
                    dateToParse = `${spotifyReleaseDate}-01-01`; 
                } else if (spotifyReleaseDate.match(/^\d{4}-\d{2}$/)) {
                    dateToParse = `${spotifyReleaseDate}-01`;
                } else {
                    dateToParse = spotifyReleaseDate;
                }
            }
            
            if (!dateToParse && releaseDateRaw) {
                dateToParse = releaseDateRaw.replace(/,.*$/, '').trim();
            }

            if (dateToParse) {
                const timestampMs = Date.parse(dateToParse);
                if (!isNaN(timestampMs)) {
                    const timestampSec = Math.floor(timestampMs / 1000);
                    releaseDateString = `<t:${timestampSec}:D>`;
                } else if (releaseDateRaw) {
                    // Fallback for unparsable strings like "Spring 2023"
                    releaseDateString = releaseDateRaw.replace(/,.*$/, '').trim();
                }
            }
            // --- END: Timestamp Logic ---

            if (!tracksArray || tracksArray.length === 0) {
              tracksArray = Array.isArray(albumData?.tracks?.track)
                ? albumData.tracks.track
                : albumData.tracks?.track
                ? [albumData.tracks.track]
                : [];
            }

            const trackCount = tracksArray.length;

            if (albumData.tags && albumData.tags.tag) {
              const tags = Array.isArray(albumData.tags.tag) ? albumData.tags.tag : [albumData.tags.tag];
              isSingle = tags.some((tag: any) => tag.name?.toLowerCase() === 'single');
              isEP = tags.some((tag: any) => tag.name?.toLowerCase() === 'ep');
            }
            if (!isSingle && !isEP) {
              if (trackCount <= 3) isSingle = true;
              else if (trackCount > 3 && trackCount <= 6) isEP = true;
            }

            if (!coverUrl) {
              if (albumData.image) {
                coverUrl = albumData.image?.reverse()?.find((i: any) => i["#text"])?.["#text"] || albumData.image?.[0]?.["#text"] || null;
                albumImageSource = "Last.fm";
              }
            }

            if (!spotifyLabel) {
              try {
                const mbid = albumData?.mbid || albumData?.artist?.mbid || null;
                if (mbid) {
                  const mbLabel = await fetchLabelFromMusicBrainz(mbid);
                  if (mbLabel) spotifyLabel = mbLabel;
                }
              } catch {}
            }

            const albumInfoForUserUrl = `https://ws.audioscrobbler.com/2.0/?method=album.getInfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(
              artist
            )}&album=${encodeURIComponent(album)}&username=${encodeURIComponent(targetUsername)}&format=json&autocorrect=1`;
            const albumInfoForUser = (await fetchLastFmJson(albumInfoForUserUrl)) as any;
            const playsByUser = safeNum(albumInfoForUser?.album?.userplaycount ?? albumData.userplaycount ?? 0);

            const topAlbums7Url = `https://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${encodeURIComponent(
              targetUsername
            )}&period=7day&limit=1000&api_key=${LASTFM_API_KEY}&format=json`;
            const topAlbums7 = (await fetchLastFmJson(topAlbums7Url)) as any;
            const playsByUserLastWeek = (() => {
              const arr = topAlbums7?.topalbums?.album ?? [];
              const match = arr.find(
                (a: any) =>
                  String(a.name ?? "").toLowerCase() === album.toLowerCase() &&
                  String(a.artist?.name ?? "").toLowerCase() === artist.toLowerCase()
              );
              return safeNum(match?.playcount ?? 0);
            })();

            const normalizeTitle = (s: string) =>
              String(s || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
            
            const levenshtein = (a: string, b: string) => {
              if (a === b) return 0;
              const al = a.length;
              const bl = b.length;
              if (al === 0) return bl;
              if (bl === 0) return al;
              const v0 = new Array(bl + 1).fill(0).map((_, i) => i);
              const v1 = new Array(bl + 1).fill(0);
              for (let i = 0; i < al; i++) {
                v1[0] = i + 1;
                for (let j = 0; j < bl; j++) {
                  const cost = a[i] === b[j] ? 0 : 1;
                  v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
                }
                for (let j = 0; j <= bl; j++) v0[j] = v1[j];
              }
              return v1[bl];
            };

            const findSpotifyMatch = (normTitle: string, spotifyMap: Record<string, number>) => {
              if (!normTitle) return { duration: undefined as number | undefined, key: undefined, score: 0 };
              const titleTokens = normTitle.split(" ").filter(Boolean);
              let bestKey: string | null = null;
              let bestScore = 0;

              for (const key of Object.keys(spotifyMap)) {
                if (!key) continue;
                if (key === normTitle) return { duration: spotifyMap[key], key, score: 1 };
                if (key.includes(normTitle) || normTitle.includes(key)) return { duration: spotifyMap[key], key, score: 0.95 };

                const keyTokens = key.split(" ").filter(Boolean);
                const intersection = titleTokens.filter((t) => keyTokens.includes(t));
                const overlap = intersection.length / Math.max(titleTokens.length || 1, keyTokens.length || 1);

                const maxLen = Math.max(normTitle.length, key.length);
                const dist = levenshtein(normTitle, key);
                const levSim = maxLen > 0 ? 1 - dist / maxLen : 0;

                const combined = Math.max(overlap, levSim);

                if (combined > bestScore) {
                  bestScore = combined;
                  bestKey = key;
                }
              }

              if (bestScore >= 0.65 && bestKey) {
                return { duration: spotifyMap[bestKey], key: bestKey, score: bestScore };
              }
              return { duration: undefined as number | undefined, key: undefined, score: 0 };
            };

            let albumTotalSeconds = 0;
            tracksArray.forEach((t: any) => {
              const title = t.name || t.title || "";
              const durFromLastfm = safeNum(t.duration || 0);
              const normTitle = normalizeTitle(title);
              let durFromSpotify: number | undefined = spotifyTrackDurations[normTitle];
              if (durFromSpotify == null) {
                durFromSpotify = findSpotifyMatch(normTitle, spotifyTrackDurations).duration;
              }
              const dur = durFromLastfm || durFromSpotify || 0;
              albumTotalSeconds += dur;
            });
            const albumTotalDuration = secondsToHMMSS(albumTotalSeconds);

            const trackDurationPromises = tracksArray.map(async (t: any) => {
              const title = t.name || t.title || "";
              const durFromLastfm = safeNum(t.duration || 0);
              const normTitle = normalizeTitle(title);
              let durFromSpotify: number | undefined = spotifyTrackDurations[normTitle];
              if (durFromSpotify == null) {
                durFromSpotify = findSpotifyMatch(normTitle, spotifyTrackDurations).duration;
              }
              const durationSec = durFromLastfm || durFromSpotify || 0;
              let trackPlays = 0;
              try {
                const url = `https://ws.audioscrobbler.com/2.0/?method=user.gettrackscrobbles&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(title)}&username=${encodeURIComponent(targetUsername)}&format=json&autocorrect=1&sk=${encodeURIComponent(sessionKey)}`;
                const res = (await fetchLastFmJson(url)) as any;
                trackPlays = safeNum(res?.trackscrobbles?.["@attr"]?.total ?? 0);
              } catch {
                trackPlays = 0;
              }
              return trackPlays * durationSec;
            });
            const trackTimes = await Promise.all(trackDurationPromises);
            let timeSpentSeconds = trackTimes.reduce((a, b) => a + b, 0);
            const timeSpentHuman = secondsToTimeString(timeSpentSeconds);

            let serverListeners = 0;
            let serverTotalPlays = 0;
            let serverAvg = 0;

            if (interaction.guild) {
              try {
                let members = interaction.guild.members.cache;
                if (members.size < 5) {
                  try {
                    const fetched = await interaction.guild.members.fetch();
                    members = fetched;
                  } catch {}
                }

                const linkedMembers = members.filter((m) => getUser(m.id));
                const serverPromises: Promise<void>[] = [];
                for (const m of linkedMembers.values()) {
                  const linked = getUser(m.id);
                  if (!linked) continue;
                  const u = linked.username;
                  serverPromises.push(
                    (async () => {
                      try {
                        const url = `https://ws.audioscrobbler.com/2.0/?method=album.getInfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(
                          artist
                        )}&album=${encodeURIComponent(album)}&username=${encodeURIComponent(u)}&format=json&autocorrect=1`;
                        const data = (await fetchLastFmJson(url)) as any;
                        const userPlays = safeNum(data?.album?.userplaycount ?? 0);
                        if (userPlays > 0) {
                          serverListeners += 1;
                          serverTotalPlays += userPlays;
                        }
                      } catch {}
                    })()
                  );
                }
                await Promise.all(serverPromises);
                serverAvg = serverListeners > 0 ? Math.round(serverTotalPlays / serverListeners) : 0;
              } catch (e) {
                console.warn("Server stats failed:", e);
              }
            }

            const userTotalScrobblesUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getinfo&user=${encodeURIComponent(
              targetUsername
            )}&api_key=${LASTFM_API_KEY}&format=json`;
            const userInfo = (await fetchLastFmJson(userTotalScrobblesUrl)) as any;
            const userTotalScrobbles = safeNum(userInfo?.user?.playcount ?? 0);
            const percentOfUser = userTotalScrobbles > 0 ? ((playsByUser / userTotalScrobbles) * 100).toFixed(2) : "0.00";

            const albumUrlLastfm = `https://www.last.fm/music/${encodeURIComponent(artist)}/${encodeURIComponent(album)}`;
            const artistUrlLastfm = `https://www.last.fm/music/${encodeURIComponent(artist)}`;
            const userAlbumUrl = `https://www.last.fm/user/${encodeURIComponent(targetUsername)}/library/music/${encodeURIComponent(artist)}/${encodeURIComponent(album)}`;

            const albumEmbed = new EmbedBuilder()
              .setColor(FM_COLOR)
              .setTitle(`${isEP ? 'EP' : isSingle ? 'Single' : 'Album'}: ${artist} - ${album} for ${targetUsername}`)
              .setDescription(`Release date: ${releaseDateString}`) // <-- Use new string
              .setURL(albumUrlLastfm);

            if (coverUrl) albumEmbed.setThumbnail(coverUrl);

            albumEmbed.addFields([
              {
                name: "Stats",
                value: `\`${globalListeners.toLocaleString()}\` listeners\n\`${globalPlaycount.toLocaleString()}\` global plays\n\`${playsByUser.toLocaleString()}\` plays by you\n\`${playsByUserLastWeek.toLocaleString()}\` by you last week\n\`${timeSpentHuman}\` spent listening`,
                inline: true,
              },
              {
                name: "Server stats",
                value: `\`${serverListeners.toLocaleString()}\` listeners\n\`${serverTotalPlays.toLocaleString()}\` total plays\n\`${serverAvg.toLocaleString()}\` avg plays`,
                inline: true,
              },
            ]);

            const label = spotifyLabel ?? "Unknown";
            albumEmbed.setFooter({ text: `Label: ${label}\n${percentOfUser}% of all your plays are on this ${isEP ? 'EP' : isSingle ? 'single' : 'album'}` });

            const btnTracks = new ButtonBuilder()
              .setCustomId("album_tracks")
              .setLabel("Album tracks")
              .setEmoji("🎶")
              .setStyle(ButtonStyle.Secondary);

            const btnCover = new ButtonBuilder()
              .setCustomId("album_cover")
              .setLabel("Cover")
              .setEmoji("🖼️")
              .setStyle(ButtonStyle.Secondary);
              
            const albumRow = new ActionRowBuilder<ButtonBuilder>().addComponents(btnTracks, btnCover);

            await btnInt.editReply({ files: [], embeds: [albumEmbed], components: [albumRow] });
            
            const totalPages = Math.max(1, Math.ceil(tracksArray.length / 12));
            startAlbumCollector(albumEmbed, albumRow, tracksArray, spotifyTrackDurations, userAlbumUrl, albumImageSource, playsByUser, isEP, isSingle, albumTotalDuration, spotifyAlbumUrl, totalPages);

          } catch (err) {
            console.error("🔥 Error handling 'show_album' button:", err);
            await btnInt.followUp({ content: "❌ Failed to fetch album info.", ephemeral: true }).catch(() => {});
            startCoverCollector(); // Re-start collector on failure
          }
        });

        collector.on("end", async (collected, reason) => {
          if (reason !== "time") return; // Only disable if it timed out
          try {
            const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
              spotifyBtn,
              albumBtn.setDisabled(true)
            );
            await sent.edit({ components: [disabledRow] });
          } catch {}
        });
      };
      
      // --- This function creates the collector for the ALBUM page ---
      const startAlbumCollector = (
        albumEmbed: EmbedBuilder, 
        albumRow: ActionRowBuilder<ButtonBuilder>,
        tracksArray: any[],
        spotifyTrackDurations: Record<string, number>,
        userAlbumUrl: string,
        albumImageSource: string,
        playsByUser: number,
        isEP: boolean,
        isSingle: boolean,
        albumTotalDuration: string,
        spotifyAlbumUrl: string | null,
        totalPages: number
      ) => {
        const albumCollector = sent.createMessageComponentCollector({ componentType: ComponentType.Button, time: 5 * 60 * 1000 });
        
        // --- Define helper functions *inside* this scope ---
        const normalizeTitle = (s: string) =>
          String(s || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
        
        const levenshtein = (a: string, b: string) => {
          if (a === b) return 0;
          const al = a.length;
          const bl = b.length;
          if (al === 0) return bl;
          if (bl === 0) return al;
          const v0 = new Array(bl + 1).fill(0).map((_, i) => i);
          const v1 = new Array(bl + 1).fill(0);
          for (let i = 0; i < al; i++) {
            v1[0] = i + 1;
            for (let j = 0; j < bl; j++) {
              const cost = a[i] === b[j] ? 0 : 1;
              v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
            }
            for (let j = 0; j <= bl; j++) v0[j] = v1[j];
          }
          return v1[bl];
        };

        const findSpotifyMatch = (normTitle: string, spotifyMap: Record<string, number>) => {
          if (!normTitle) return { duration: undefined as number | undefined, key: undefined, score: 0 };
          const titleTokens = normTitle.split(" ").filter(Boolean);
          let bestKey: string | null = null;
          let bestScore = 0;

          for (const key of Object.keys(spotifyMap)) {
            if (!key) continue;
            if (key === normTitle) return { duration: spotifyMap[key], key, score: 1 };
            if (key.includes(normTitle) || normTitle.includes(key)) return { duration: spotifyMap[key], key, score: 0.95 };
            const keyTokens = key.split(" ").filter(Boolean);
            const intersection = titleTokens.filter((t) => keyTokens.includes(t));
            const overlap = intersection.length / Math.max(titleTokens.length || 1, keyTokens.length || 1);
            const maxLen = Math.max(normTitle.length, key.length);
            const dist = levenshtein(normTitle, key);
            const levSim = maxLen > 0 ? 1 - dist / maxLen : 0;
            const combined = Math.max(overlap, levSim);
            if (combined > bestScore) {
              bestScore = combined;
              bestKey = key;
            }
          }
          if (bestScore >= 0.65 && bestKey) {
            return { duration: spotifyMap[bestKey], key: bestKey, score: bestScore };
          }
          return { duration: undefined as number | undefined, key: undefined, score: 0 };
        };
        // --- End helper functions ---

        const tracksPerPage = 12;
        const totalTracks = tracksArray.length;
        // totalPages is already passed in

        async function buildTracksEmbed(page: number) {
          const start = (page - 1) * tracksPerPage;
          const slice = tracksArray.slice(start, start + tracksPerPage);
          const trackLines: string[] = [];
          for (let i = 0; i < slice.length; i++) {
            const t = slice[i];
            const title = t.name || t.title || "Unknown";
            const durFromLastfm = safeNum(t.duration || 0);
            const normTitle = normalizeTitle(title);
            let durFromSpotify: number | undefined = spotifyTrackDurations[normTitle];
            if (durFromSpotify == null) {
              durFromSpotify = findSpotifyMatch(normTitle, spotifyTrackDurations).duration;
            }
            const durationSec = durFromLastfm || durFromSpotify || 0;
            let trackPlays = 0;
            try {
              const url = `https://ws.audioscrobbler.com/2.0/?method=user.gettrackscrobbles&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(
                artist
              )}&track=${encodeURIComponent(title)}&username=${encodeURIComponent(targetUsername)}&format=json&autocorrect=1&sk=${encodeURIComponent(sessionKey)}`;
              const res = (await fetchLastFmJson(url)) as any;
              trackPlays = safeNum(res?.trackscrobbles?.["@attr"]?.total ?? 0);
            } catch {
              trackPlays = 0;
            }
            const playsStr = trackPlays > 0 ? ` - \`${trackPlays} play${trackPlays !== 1 ? 's' : ''}\`` : '';
            const durationLabel = durationSec > 0 ? `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, "0")}` : "—";
            const index = start + i + 1;
            trackLines.push(`${index}. **${title}**${playsStr} - \`${durationLabel}\``);
          }

          const desc = trackLines.join("\n");

          const emb = new EmbedBuilder()
            .setColor(FM_COLOR)
            .setTitle(`Track playcounts for ${album} by ${artist}`)
            .setURL(userAlbumUrl)
            .setDescription(desc || "No tracks found.")
            .setFooter({ text: `Page ${page}/${totalPages} — ${totalTracks} total tracks — ${albumTotalDuration}\nAlbum source: ${albumImageSource} | ${targetUsername} has ${playsByUser} total scrobbles on this ${isEP ? 'EP' : isSingle ? 'single' : 'album'}` });

          return emb;
        }
        
        const buildPageButtons = (page: number) => {
          const firstBtn = new ButtonBuilder().setCustomId("first").setEmoji("⏮️").setStyle(ButtonStyle.Secondary).setDisabled(page <= 1);
          const prevBtn = new ButtonBuilder().setCustomId("prev").setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(page <= 1);
          const nextBtn = new ButtonBuilder().setCustomId("next").setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages);
          const lastBtn = new ButtonBuilder().setCustomId("last").setEmoji("⏭️").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages);
          const returnBtn = new ButtonBuilder().setCustomId("return_to_album").setLabel("Return to album").setStyle(ButtonStyle.Primary);
          return [new ActionRowBuilder<ButtonBuilder>().addComponents(firstBtn, prevBtn, nextBtn, lastBtn), new ActionRowBuilder<ButtonBuilder>().addComponents(returnBtn)];
        };
        
        albumCollector.on("collect", async (albumBtnInt: ButtonInteraction) => {
          try {
            const id = albumBtnInt.customId;
            await albumBtnInt.deferUpdate();
            
            if (id === "album_tracks") {
              albumCollector.stop();
              const emb = await buildTracksEmbed(1);
              const rows = buildPageButtons(1);
              await albumBtnInt.editReply({ files: [], embeds: [emb], components: rows });
              startTracksCollector(1, albumEmbed, albumRow, buildTracksEmbed, buildPageButtons, totalPages, tracksArray, spotifyTrackDurations, userAlbumUrl, albumImageSource, playsByUser, isEP, isSingle, albumTotalDuration, spotifyAlbumUrl); // Start new collector
              return;
            }
            
            if (id === "album_cover") {
              albumCollector.stop(); // Stop this collector
              await albumBtnInt.editReply({ files: [attachment], embeds: [coverEmbed], components: [row] });
              startCoverCollector(); // RESTART the main collector
              return;
            }
          } catch (e) {
            console.error("Album collector error:", e);
            await albumBtnInt.followUp({ content: "⚠️ Failed to handle that action.", ephemeral: true }).catch(() => {});
          }
        });
        
        albumCollector.on("end", async (collected, reason) => {
          if (reason !== "time") return;
          try {
            const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
              albumRow.components[0].setDisabled(true),
              albumRow.components[1].setDisabled(true)
            );
            await sent.edit({ components: [disabledRow] });
          } catch {}
        });
      };

      // --- This function creates the collector for the TRACKS page ---
      const startTracksCollector = (
        currentPage: number,
        albumEmbed: EmbedBuilder, 
        albumRow: ActionRowBuilder<ButtonBuilder>,
        buildTracksEmbed: (page: number) => Promise<EmbedBuilder>,
        buildPageButtons: (page: number) => ActionRowBuilder<ButtonBuilder>[],
        totalPages: number,
        tracksArray: any[],
        spotifyTrackDurations: Record<string, number>,
        userAlbumUrl: string,
        albumImageSource: string,
        playsByUser: number,
        isEP: boolean,
        isSingle: boolean,
        albumTotalDuration: string,
        spotifyAlbumUrl: string | null
      ) => {
        const tracksCollector = sent.createMessageComponentCollector({ componentType: ComponentType.Button, time: 5 * 60 * 1000 });
        
        let page = currentPage;

        tracksCollector.on("collect", async (tracksBtnInt: ButtonInteraction) => {
          try {
            const id = tracksBtnInt.customId;
            await tracksBtnInt.deferUpdate();
            
            if (["first", "prev", "next", "last"].includes(id)) {
              if (id === "first") page = 1;
              else if (id === "prev") page = Math.max(1, page - 1);
              else if (id === "next") page = Math.min(totalPages, page + 1);
              else if (id === "last") page = totalPages;
              
              const emb = await buildTracksEmbed(page);
              const rows = buildPageButtons(page);
              await tracksBtnInt.editReply({ files: [], embeds: [emb], components: rows });
              return;
            }
            
            if (id === "return_to_album") {
              tracksCollector.stop();
              await tracksBtnInt.editReply({ files: [], embeds: [albumEmbed], components: [albumRow] });
              // Re-create album collector
              startAlbumCollector(albumEmbed, albumRow, tracksArray, spotifyTrackDurations, userAlbumUrl, albumImageSource, playsByUser, isEP, isSingle, albumTotalDuration, spotifyAlbumUrl, totalPages);
              return;
            }

          } catch (e) {
            console.error("Tracks collector error:", e);
            await tracksBtnInt.followUp({ content: "⚠️ Failed to handle that action.", ephemeral: true }).catch(() => {});
          }
        });

        tracksCollector.on("end", async (collected, reason) => {
          if (reason !== "time") return;
          try {
            const rows = buildPageButtons(page).map(row => {
              row.components.forEach(c => c.setDisabled(true));
              return row;
            });
            await sent.edit({ components: rows });
          } catch {}
        });
      };

      // Start the very first collector
      startCoverCollector();

    } catch (err) {
      console.error("🔥 Error fetching album cover:", err);
      if (interaction.replied || interaction.deferred || isPrefix) {
        await interaction[replyMethod]({ 
          content: "❌ Failed to fetch album cover.",
          embeds: [], files: [], components: [] 
        }).catch(() => {});
      } else {
        await interaction.reply({ 
          content: "❌ Failed to fetch album cover.", 
          ephemeral: true 
        }).catch(() => {});
      }
    }
  },
  
  async prefixExecute(message: Message, args: string[]) {
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
    
    let simArgs = [];
    if (track) simArgs.push(`--track=${track}`);
    if (artist) simArgs.push(`--artist=${artist}`);
    
    const interaction = createInteractionFromMessage(message, simArgs);
    await cmd.execute(interaction as any);
  },
};

export default cmd;