// src/services/crowns.ts
import fs from "fs";
import path from "path";

const crownsFilePath = path.join(__dirname, "../../data/crowns.json");

export let crowns: {
  [guildId: string]: {
    [artistLower: string]: { holder: string; plays: number };
  };
} = {};

// Load crowns immediately on module import
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

export function saveCrowns() {
  try {
    fs.writeFileSync(crownsFilePath, JSON.stringify(crowns, null, 2));
  } catch (err) {
    console.error("🔥 Failed to save crowns.json:", err);
  }
}