// src/commands/album.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  Message,
  ButtonInteraction,
  ComponentType,
  TextChannel,
} from "discord.js";
import { createInteractionFromMessage, parseArgs } from "../scripts/prefixAdapter";
import fetch from "node-fetch";
import { createCanvas, loadImage } from "canvas";
import { getUser } from "../scripts/storage";
import dotenv from "dotenv";

dotenv.config();

const LASTFM_API_KEY = process.env.LASTFM_API_KEY!;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID!;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET!;
// user-supplied market
const MARKET = "EG";

function safeNum(v: unknown) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

async function getSpotifyToken(): Promise<string | null> {
  try {
    const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return data.access_token;
  } catch {
    return null;
  }
}

// Search spotify album and return useful metadata plus album id and a map of normalized title->duration(seconds)
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

// fetch full spotify album tracks (ordered). returns array of {name, duration_sec, track_number}
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

interface SpotifyAlbumSearchResult {
  albums: {
    items: Array<{
      name: string;
      artists: Array<{ name: string }>;
      images: Array<{ url: string }>;
    }>;
  };
}

const cmd = {
  data: new SlashCommandBuilder()
    .setName("album")
    .setDescription("Show album info for what you're listening to or search by name.")
    .addStringOption((o) => o.setName("artist").setDescription("Artist name (optional)"))
    .addStringOption((o) => o.setName("album").setDescription("Album name (optional)"))
    .addUserOption((o) => o.setName("user").setDescription("Show album stats for another linked user (optional)")),

  async execute(interaction: ChatInputCommandInteraction) {
    const isPrefix = (interaction as any).isPrefix;
    if (isPrefix) {
      try {
        (interaction.channel as TextChannel).sendTyping();
      } catch (err) {
        console.warn("Typing indicator failed:", err);
      }
    }

    await interaction.deferReply();

    try {
      const optArtist = interaction.options.getString("artist")?.trim();
      const optAlbum = interaction.options.getString("album")?.trim();
      const optUser = interaction.options.getUser("user") || interaction.user;

      const targetUserData = getUser(optUser.id);
      if (!targetUserData) {
        await interaction.editReply("❌ That user hasn't linked Last.fm. They need to run `/link`.");
        return;
      }
      const targetUsername = targetUserData.username;
      const sessionKey = targetUserData.sessionKey;

      let artist = optArtist ?? "";
      let album = optAlbum ?? "";

      if (!artist && !album) {
        const recentUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(
          targetUsername
        )}&api_key=${LASTFM_API_KEY}&limit=1&format=json${sessionKey ? `&sk=${encodeURIComponent(sessionKey)}` : ""}`;

        const recentData = (await fetchLastFmJson(recentUrl)) as any;
        const track = Array.isArray(recentData?.recenttracks?.track)
          ? recentData.recenttracks.track[0]
          : recentData?.recenttracks?.track;

        if (!track) {
          await interaction.editReply("⚠️ No recent track found. Please provide `artist` and `album` options.");
          return;
        }

        artist = track.artist?.["#text"] || "";
        album = track.album?.["#text"] || "";
      } else if (!artist && album) {
        // New: Resolve artist via Spotify search for the album
        const token = await getSpotifyToken();
        if (!token) {
          throw new Error("Failed to get Spotify token");
        }
        const query = `album:${encodeURIComponent(album!)}`;
        const res = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=album&limit=1`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json() as SpotifyAlbumSearchResult;
        const item = data.albums?.items?.[0];
        if (!item) {
          throw new Error(`No matching album found for "${album}"`);
        }
        artist = item.artists[0].name;
        console.log(`Resolved artist for "${album}" to "${artist}" via Spotify`);
      } else if (!album) {
        throw new Error("Need album name");
      }

      if (!artist || !album) {
        await interaction.editReply("⚠️ Could not determine album/artist. Provide both as options.");
        return;
      }

      artist = artist.trim();
      album = album.trim();

      // Fetch Last.fm album.getInfo
      const albumInfoUrl = `https://ws.audioscrobbler.com/2.0/?method=album.getInfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(
        artist
      )}&album=${encodeURIComponent(album)}&format=json&autocorrect=1`;
      const albumInfo = (await fetchLastFmJson(albumInfoUrl)) as any;

      if (albumInfo?.error) {
        await interaction.editReply(`⚠️ Last.fm error: ${albumInfo.message ?? "Unknown error"}`);
        return;
      }
      if (!albumInfo?.album) {
        await interaction.editReply("⚠️ Could not find that album on Last.fm.");
        return;
      }

      const albumData = albumInfo.album;
      const globalListeners = safeNum(albumData.listeners);
      const globalPlaycount = safeNum(albumData.playcount);
      let releaseDateRaw = albumData?.wiki?.published || albumData?.releasedate?.trim() || null;

      let isSingle = false;
      let isEP = false;

      // First: try Spotify for authoritative tracklist
      let tracksArray: any[] = [];
      let spotifyTrackDurations: Record<string, number> = {};
      let coverUrl: string | null = null;
      let albumImageSource = "Last.fm";
      let spotifyAlbumUrl: string | null = null;
      let spotifyLabel: string | null = null;
      let spotifyReleaseDate: string | null = null;
      let spotifyAlbumId: string | null = null;

      const sp = await searchSpotifyAlbum(artist, album, null);
      if (sp && sp.spotifyAlbumId) {
        spotifyAlbumId = sp.spotifyAlbumId;
        spotifyTrackDurations = sp.spotifyTrackDurations ?? {};
        spotifyAlbumUrl = sp.url ?? null;
        spotifyLabel = sp.label ?? null;
        spotifyReleaseDate = sp.release_date ?? null;
        if (Array.isArray(sp.images) && sp.images.length > 0) {
          coverUrl = sp.images[0]?.url ?? null;
          albumImageSource = "Spotify";
        } else if ((sp as any).cover) {
          coverUrl = (sp as any).cover;
          albumImageSource = "Spotify";
        }

        // Fetch full tracklist from Spotify
        const spotifyTracks = await fetchSpotifyAlbumTracks(spotifyAlbumId ?? "", MARKET);

        if (spotifyTracks && spotifyTracks.length > 0) {
          // Use Spotify track order and durations
          tracksArray = spotifyTracks.map((t) => ({ name: t.name, duration: t.duration, track_number: t.track_number }));
        }
      }
      
      // --- START: Timestamp Logic ---
      let releaseDateString = "Unknown";
      let dateToParse: string | null = null;

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

      // If Spotify didn't produce a tracklist, fallback to Last.fm logic (your existing multi-step fallback)
      if (!tracksArray || tracksArray.length === 0) {
        // original Last.fm tracks extraction with fallbacks (autocorrect 1 then 0 then track.search)
        tracksArray = Array.isArray(albumData?.tracks?.track)
          ? albumData.tracks.track
          : albumData.tracks?.track
          ? [albumData.tracks.track]
          : [];

        if (!tracksArray || tracksArray.length === 0) {
          try {
            const altUrl = `https://ws.audioscrobbler.com/2.0/?method=album.getInfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(
              artist
            )}&album=${encodeURIComponent(album)}&format=json&autocorrect=0`;
            const altInfo = (await fetchLastFmJson(altUrl)) as any;
            const altTracks = Array.isArray(altInfo?.album?.tracks?.track)
              ? altInfo.album.tracks.track
              : altInfo?.album?.tracks?.track
              ? [altInfo.album.tracks.track]
              : [];
            if (Array.isArray(altTracks) && altTracks.length > 0) tracksArray = altTracks;
          } catch {}

          if (!tracksArray || tracksArray.length === 0) {
            try {
              const searchUrl = `https://ws.audioscrobbler.com/2.0/?method=track.search&track=${encodeURIComponent(
                album
              )}&artist=${encodeURIComponent(artist)}&api_key=${LASTFM_API_KEY}&format=json&limit=500&autocorrect=1`;
              const search = (await fetchLastFmJson(searchUrl)) as any;
              const results = search?.results?.trackmatches?.track ?? [];

              const normalizeTitleForDedup = (s: string) => String(s || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
              const normalizedAlbum = String(album || "").toLowerCase().replace(/[^\w\s]/g, "").trim();

              const candidateArr = Array.isArray(results) ? results : [results];
              const dedupMap: Record<string, any> = {};

              for (const t of candidateArr) {
                const tName = t?.name || t?.title || "";
                const tArtist = (t?.artist || "").toLowerCase();
                const albumField = (t?.album || "").toLowerCase();
                const nameNorm = normalizeTitleForDedup(tName);
                const matchesAlbum = albumField && (albumField.includes(normalizedAlbum) || normalizedAlbum.includes(albumField));
                if (matchesAlbum || tArtist.includes(artist.toLowerCase()) || artist.toLowerCase().includes(tArtist)) {
                  if (!dedupMap[nameNorm]) {
                    dedupMap[nameNorm] = {
                      name: tName,
                      duration: safeNum(t?.duration ?? 0),
                    };
                  }
                }
              }

              tracksArray = Object.values(dedupMap);

              if (!tracksArray || tracksArray.length === 0) {
                try {
                  const altSearchUrl = `https://ws.audioscrobbler.com/2.0/?method=track.search&track=${encodeURIComponent(
                    ""
                  )}&artist=${encodeURIComponent(artist)}&api_key=${LASTFM_API_KEY}&format=json&limit=200&autocorrect=1`;
                  const altSearch = (await fetchLastFmJson(altSearchUrl)) as any;
                  const altResults = altSearch?.results?.trackmatches?.track ?? [];
                  const altArr = Array.isArray(altResults) ? altResults : [altResults];
                  const altMap: Record<string, any> = {};
                  for (const t of altArr) {
                    const tName = t?.name || "";
                    const nameNorm = normalizeTitleForDedup(tName);
                    if (nameNorm.includes(String(album).toLowerCase().replace(/[^\w\s]/g, "").trim()) || String(tName || "").toLowerCase().includes(String(album).toLowerCase())) {
                      if (!altMap[nameNorm]) {
                        altMap[nameNorm] = { name: tName, duration: safeNum(t?.duration ?? 0) };
                      }
                    }
                  }
                  const altVals = Object.values(altMap);
                  if (altVals.length > 0) tracksArray = altVals;
                } catch {}
              }
            } catch (e) {
              // ignore
            }
          }
        }
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

      // If spotifyLabel not set and we have mbid, try MusicBrainz
      if (!spotifyLabel) {
        try {
          const mbid = albumData?.mbid || albumData?.artist?.mbid || null;
          if (mbid) {
            const mbLabel = await fetchLabelFromMusicBrainz(mbid);
            if (mbLabel) spotifyLabel = mbLabel;
          }
        } catch {}
      }

      // plays by user
      const albumInfoForUserUrl = `https://ws.audioscrobbler.com/2.0/?method=album.getInfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(
        artist
      )}&album=${encodeURIComponent(album)}&username=${encodeURIComponent(targetUsername)}&format=json&autocorrect=1`;
      const albumInfoForUser = (await fetchLastFmJson(albumInfoForUserUrl)) as any;
      const playsByUser = safeNum(albumInfoForUser?.album?.userplaycount ?? albumData.userplaycount ?? 0);

      // last week
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

      const findSpotifyMatch = (normTitle: string, spotifyMap: Record<string, number>) => {
        if (!normTitle) return { duration: undefined as number | undefined, key: undefined, score: 0 };
        const titleTokens = normTitle.split(" ").filter(Boolean);
        let bestKey: string | null = null;
        let bestScore = 0;

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
          const match = findSpotifyMatch(normTitle, spotifyTrackDurations);
          durFromSpotify = match.duration;
        }
        const dur = durFromLastfm || durFromSpotify || 0;
        albumTotalSeconds += dur;
      });
      const albumTotalDuration = secondsToHMMSS(albumTotalSeconds);

      const trackDurationPromises = tracksArray.map(async (t: any) => {
        const title = t.name || t.title || "Unknown";
        const durFromLastfm = safeNum(t.duration || 0);
        const normTitle = normalizeTitle(title);
        let durFromSpotify: number | undefined = spotifyTrackDurations[normTitle];
        if (durFromSpotify == null) {
          const match = findSpotifyMatch(normTitle, spotifyTrackDurations);
          durFromSpotify = match.duration;
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

      // server stats
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

      const embed = new EmbedBuilder()
        .setColor(0xd51007)
        .setTitle(`${isEP ? 'EP' : isSingle ? 'Single' : 'Album'}: ${artist} - ${album} for ${targetUsername}`)
        .setDescription(`Release date: ${releaseDateString}`)
        .setURL(albumUrlLastfm);

      if (coverUrl) embed.setThumbnail(coverUrl);

      embed.addFields([
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

      if (!isSingle && !isEP) {
        const wikiSummary = albumData?.wiki?.summary
          ? String(albumData.wiki.summary).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
          : null;
        if (wikiSummary) {
          const summaryValue = wikiSummary.length > 600 ? wikiSummary.substring(0, 600) + "..." : wikiSummary;
          embed.addFields([{ name: "Summary", value: summaryValue, inline: false }]);
        }
      }

      const label = spotifyLabel ?? "Unknown";
      embed.setFooter({ text: `Label: ${label}\n${percentOfUser}% of all your plays are on this ${isEP ? 'EP' : isSingle ? 'single' : 'album'}` });

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

      if (isPrefix) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      const sent = (await interaction.editReply({ embeds: [embed], components: [albumRow] })) as Message;

      const collector = sent.createMessageComponentCollector({ componentType: ComponentType.Button, time: 5 * 60 * 1000 });

      const tracksPerPage = 12;
      const totalTracks = tracksArray.length;
      const totalPages = Math.max(1, Math.ceil(totalTracks / tracksPerPage));

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
            const match = findSpotifyMatch(normTitle, spotifyTrackDurations);
            durFromSpotify = match.duration;
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
          .setColor(0xd51007)
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
        const returnBtn = new ButtonBuilder().setCustomId("return").setEmoji("💽").setLabel("Return to album").setStyle(ButtonStyle.Secondary);
        return [new ActionRowBuilder<ButtonBuilder>().addComponents(firstBtn, prevBtn, nextBtn, lastBtn), new ActionRowBuilder<ButtonBuilder>().addComponents(returnBtn)];
      };

      async function buildCover() {
        if (!coverUrl) {
          return { files: [], embed: new EmbedBuilder().setColor(0xd51007).setDescription("⚠️ No cover found."), components: [] };
        }
        const res = await fetch(coverUrl);
        const buf = Buffer.from(await res.arrayBuffer());
        const img = await loadImage(buf);
        const canvas = createCanvas(640, 640);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 640, 640);
        const buffer = canvas.toBuffer("image/png");
        const attachment = new AttachmentBuilder(buffer, { name: "cover.png" });

        const coverEmbed = new EmbedBuilder()
          .setColor(0xd51007)
          .setDescription(`**[${artist}](${artistUrlLastfm}) - [${album}](${albumUrlLastfm})**`);

        coverEmbed.setFooter({ text: `Album image source: ${albumImageSource}` });

        const spotifyBtn = new ButtonBuilder()
          .setLabel("Spotify")
          .setStyle(ButtonStyle.Link)
          .setEmoji("<:Spotify_icon:1438540261713248390>")
          .setURL(
            spotifyAlbumUrl || `https://open.spotify.com/search/${encodeURIComponent(`${artist} ${album}`)}`
          );

        const returnBtn = new ButtonBuilder().setCustomId("return").setEmoji("💽").setLabel("Return to album").setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(spotifyBtn, returnBtn);

        return { files: [attachment], embed: coverEmbed, components: [row] };
      }

      let currentPage = 1;
      let currentView: 'album' | 'tracks' | 'cover' = 'album';

      collector.on("collect", async (btnInt) => {
        try {
          const id = btnInt.customId;

          await btnInt.deferUpdate();

          if (id === "album_tracks") {
            currentView = 'tracks';
            currentPage = 1;
            const emb = await buildTracksEmbed(currentPage);
            const rows = buildPageButtons(currentPage);
            await btnInt.editReply({ files: [], embeds: [emb], components: rows });
            return;
          }

          if (id === "album_cover") {
            currentView = 'cover';
            const { files, embed: emb, components: rows } = await buildCover();
            await btnInt.editReply({ files, embeds: [emb], components: rows });
            return;
          }

          if (["first", "prev", "next", "last"].includes(id)) {
            if (currentView !== 'tracks') {
              return;
            }
            if (id === "first") currentPage = 1;
            else if (id === "prev") currentPage = Math.max(1, currentPage - 1);
            else if (id === "next") currentPage = Math.min(totalPages, currentPage + 1);
            else if (id === "last") currentPage = totalPages;
            const emb = await buildTracksEmbed(currentPage);
            const rows = buildPageButtons(currentPage);
            await btnInt.editReply({ files: [], embeds: [emb], components: rows });
            return;
          }

          if (id === "return") {
            currentView = 'album';
            await btnInt.editReply({ files: [], embeds: [embed], components: [albumRow] });
            return;
          }

        } catch (e) {
          console.error("Collector action error:", e);
          await btnInt.followUp({ content: "⚠️ Failed to handle that action.", ephemeral: true }).catch(() => {});
        }
      });

      collector.on("end", async () => {
        try {
          const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            btnTracks.setDisabled(true),
            btnCover.setDisabled(true)
          );
          await sent.edit({ components: [disabledRow] });
        } catch {}
      });
    } catch (err) {
      console.error("Album command error:", err);
      await interaction.editReply("❌ Failed to get album info. Try again later.").catch(() => {});
    }
  },

  async prefixExecute(message: Message, args: string[]) {
    const { map, unnamed } = parseArgs(args);
    
    let album: string | undefined;
    let artist: string | undefined;
    
    if (map.album) {
      album = map.album;
    } else if (unnamed.length > 0) {
      const full = unnamed.join(' ');
      const match = full.match(/(.+) by (.+)/i);
      if (match) {
        album = match[1].trim();
        artist = match[2].trim();
      } else {
        album = full.trim();
      }
    }
    
    if (map.artist) {
      artist = map.artist;
    }
    
    let simArgs = [];
    if (album) simArgs.push(`--album=${album}`);
    if (artist) simArgs.push(`--artist=${artist}`);
    
    const interaction = createInteractionFromMessage(message, simArgs);
    await cmd.execute(interaction as any);
  },
};

export default cmd;