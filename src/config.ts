// src/config.ts
import dotenv from "dotenv";
dotenv.config();

const env = (name: string): string => {
  const val = process.env[name];
  if (!val) {
    console.warn(`⚠️ Missing env var: ${name}`);
    return "";
  }
  return val;
};

export const DISCORD_TOKEN = env("DISCORD_TOKEN");
export const CLIENT_ID = env("CLIENT_ID");
export const GUILD_ID = process.env.GUILD_ID;
export const LASTFM_API_KEY = env("LASTFM_API_KEY");
export const LASTFM_SHARED_SECRET = env("LASTFM_SHARED_SECRET");
export const PREFIX = process.env.PREFIX || ".fm";
export const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
export const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;