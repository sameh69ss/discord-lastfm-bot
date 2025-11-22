// src/features/avatarRotator.ts
import { Client, TextChannel, EmbedBuilder } from "discord.js";
import fetch from "node-fetch";
import { getLinkedUserIds, getUser } from "./storage";
import { LASTFM_API_KEY, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } from "../config";

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

export async function cycleBotFeature(client: Client) {
  try {
    const allIds = getLinkedUserIds();
    if (allIds.length === 0) return;
    
    // Try up to 3 times to find a user with tracks
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
      
      // Try Spotify for better Image
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