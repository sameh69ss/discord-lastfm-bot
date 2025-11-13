import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  EmbedBuilder,
  version as discordJsVersion,
} from "discord.js";
import os from "os";
import { performance } from "perf_hooks";
import { randomBytes } from "crypto";
import fetch, { type RequestInit } from "node-fetch";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";

const SPEEDTEST_DISABLED = isTruthy(process.env.SYSINFO_DISABLE_SPEEDTEST);
const SPEED_TIMEOUT_MS = Math.max(Number(process.env.SYSINFO_SPEED_TIMEOUT_MS) || 15000, 5000);
const DOWNLOAD_URL = process.env.SYSINFO_DOWNLOAD_URL || "https://nbg1-speed.hetzner.com/1GB.bin";
const UPLOAD_URL = process.env.SYSINFO_UPLOAD_URL || "https://httpbin.org/post";
const UPLOAD_BYTES = (() => {
  const raw = Number(process.env.SYSINFO_UPLOAD_BYTES);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.max(Math.floor(raw), 262_144), 8_388_608);
  }
  return 1_000_000;
})();

const OWNER_USER_ID = "1133781023134584938";
const OWNER_GUILD_ID = "1425038775381266484";

type SpeedResult = {
  bytes: number;
  durationMs: number;
  mbps: number;
};

type SimplifiedInterface = {
  address: string;
  family: string | number;
  internal: boolean;
};

function isTruthy(value?: string | null) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "on", "enabled"].includes(normalized);
}

function calculateMbps(bytes: number, durationMs: number) {
  if (!durationMs) return 0;
  return (bytes * 8) / durationMs / 1000;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "n/a";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 2)} ${units[exponent]}`;
}

function formatDurationSeconds(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "n/a";
  let seconds = Math.floor(totalSeconds);
  const parts: string[] = [];
  const days = Math.floor(seconds / 86400);
  if (days) {
    parts.push(`${days}d`);
    seconds -= days * 86400;
  }
  const hours = Math.floor(seconds / 3600);
  if (hours) {
    parts.push(`${hours}h`);
    seconds -= hours * 3600;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes) {
    parts.push(`${minutes}m`);
    seconds -= minutes * 60;
  }
  parts.push(`${seconds % 60}s`);
  return parts.join(" ");
}

function formatDurationMs(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

function getPrimaryIPv4() {
  const nets = os.networkInterfaces() as Record<string, (SimplifiedInterface | undefined)[] | undefined>;
  for (const name of Object.keys(nets)) {
    const addresses = nets[name];
    if (!addresses) continue;
    for (const info of addresses) {
      if (!info || info.internal) continue;
      const family = typeof info.family === "string" ? info.family : info.family === 4 ? "IPv4" : "IPv6";
      if (family === "IPv4") {
        return `${name} ${info.address}`;
      }
    }
  }
  return null;
}

function describeError(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPEED_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Timed out after ${Math.round(SPEED_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function measureDownloadSpeed(): Promise<SpeedResult> {
  const response = await fetchWithTimeout(DOWNLOAD_URL, {
    headers: { "Cache-Control": "no-cache" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} on download test`);
  }
  const start = performance.now();
  const buffer = await response.arrayBuffer();
  const durationMs = performance.now() - start;
  return {
    bytes: buffer.byteLength,
    durationMs,
    mbps: calculateMbps(buffer.byteLength, durationMs),
  };
}

async function measureUploadSpeed(): Promise<SpeedResult> {
  const payload = randomBytes(UPLOAD_BYTES);
  const start = performance.now();
  const response = await fetchWithTimeout(UPLOAD_URL, {
    method: "POST",
    body: payload,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(payload.length),
      "Cache-Control": "no-cache",
    },
  });

  await response.arrayBuffer().catch(() => null);
  const durationMs = performance.now() - start;
  return {
    bytes: payload.length,
    durationMs,
    mbps: calculateMbps(payload.length, durationMs),
  };
}

function collectSystemStats() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const loadAvg = os.loadavg();
  const processMem = process.memoryUsage();

  return {
    host: os.hostname(),
    osInfo: `${os.type()} ${os.release()} (${os.arch()})`,
    systemUptime: formatDurationSeconds(os.uptime()),
    cpuModel: cpus[0]?.model ?? "Unknown",
    cpuCount: cpus.length,
    loadLabel: loadAvg.some((n) => n > 0)
      ? `${loadAvg[0].toFixed(2)}, ${loadAvg[1].toFixed(2)}, ${loadAvg[2].toFixed(2)} (1/5/15m)`
      : os.platform() === "win32"
        ? "n/a (unsupported on Windows)"
        : "n/a",
    totalMem,
    usedMem,
    freeMem,
    memPercent: totalMem ? (usedMem / totalMem) * 100 : 0,
    processMemRss: processMem.rss,
    processMemHeap: processMem.heapUsed,
    processUptime: formatDurationSeconds(process.uptime()),
    nodeVersion: process.version,
    pid: process.pid,
    primaryIp: getPrimaryIPv4(),
  };
}

function formatSpeedResult(result: SpeedResult | null, error?: string) {
  if (result) {
    return `${result.mbps.toFixed(2)} Mbps (${formatBytes(result.bytes)} in ${formatDurationMs(result.durationMs)})`;
  }
  return error ? `Failed (${error})` : "n/a";
}

async function execute(interaction: ChatInputCommandInteraction) {
  const isPrefix = Boolean((interaction as any).isPrefix);

  if (isPrefix) {
    const channel: any = interaction.channel;
    if (channel?.sendTyping) {
      channel.sendTyping().catch(() => undefined);
    }
  }

  try {
    const isOwner = interaction.user?.id === OWNER_USER_ID;
    const inOwnerGuild = interaction.guild?.id === OWNER_GUILD_ID;
    if (!isOwner || !inOwnerGuild) {
      const message = "This command is restricted to the bot owner inside the home server.";
      if (isPrefix) await interaction.reply(message);
      else await interaction.reply({ content: message, ephemeral: true });
      return;
    }

    if (!interaction.deferred && !interaction.replied) {
      if (isPrefix) await interaction.deferReply();
      else await interaction.deferReply({ ephemeral: true });
    }
  } catch (err) {
    console.warn("system defer failed", err);
  }

  try {
    const stats = collectSystemStats();

    let downloadResult: SpeedResult | null = null;
    let uploadResult: SpeedResult | null = null;
    let downloadError: string | undefined;
    let uploadError: string | undefined;

    if (!SPEEDTEST_DISABLED) {
      const [dlOutcome, ulOutcome] = await Promise.allSettled([
        measureDownloadSpeed(),
        measureUploadSpeed(),
      ]);

      if (dlOutcome.status === "fulfilled") downloadResult = dlOutcome.value;
      else downloadError = describeError(dlOutcome.reason);

      if (ulOutcome.status === "fulfilled") uploadResult = ulOutcome.value;
      else uploadError = describeError(ulOutcome.reason);
    }

    const embed = new EmbedBuilder()
      .setTitle("System Diagnostics")
      .setColor("#ff8c00")
      .addFields(
        {
          name: "System",
          value: [
            `**Host:** ${stats.host}`,
            `**OS:** ${stats.osInfo}`,
            stats.primaryIp ? `**IP:** ${stats.primaryIp}` : null,
            `**Uptime:** ${stats.systemUptime}`,
          ]
            .filter(Boolean)
            .join("\n"),
          inline: false,
        },
        {
          name: "CPU",
          value: `**Model:** ${stats.cpuModel}\n**Cores:** ${stats.cpuCount}\n**Load:** ${stats.loadLabel}`,
          inline: true,
        },
        {
          name: "Memory",
          value: `**Used:** ${formatBytes(stats.usedMem)} (${stats.memPercent.toFixed(1)}%)\n**Free:** ${formatBytes(
            stats.freeMem
          )}\n**Total:** ${formatBytes(stats.totalMem)}`,
          inline: true,
        },
        {
          name: "Process",
          value: `**PID:** ${stats.pid}\n**Uptime:** ${stats.processUptime}\n**Node:** ${stats.nodeVersion}\n**discord.js:** v${discordJsVersion}\n**Memory:** ${formatBytes(stats.processMemRss)} RSS`,
          inline: false,
        },
        {
          name: "Network",
          value: SPEEDTEST_DISABLED
            ? "Speed test disabled via `SYSINFO_DISABLE_SPEEDTEST`."
            : [
                `**Download:** ${formatSpeedResult(downloadResult, downloadError)}`,
                `**Upload:** ${formatSpeedResult(uploadResult, uploadError)}`,
              ].join("\n"),
          inline: false,
        }
      )
      .setTimestamp(new Date())
      .setFooter({
        text: SPEEDTEST_DISABLED
          ? "Speed test skipped"
          : "Speed test via Hetzner/httpbin",
      });

    const payload = isPrefix ? { embeds: [embed] } : { embeds: [embed], ephemeral: true };

    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply(payload);
  } catch (err) {
    const message = `Failed to gather system diagnostics: ${describeError(err)}`;
    const payload = isPrefix ? message : { content: message, ephemeral: true };

    if (interaction.deferred || interaction.replied) await interaction.editReply(payload as any);
    else await interaction.reply(payload as any);
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName("system")
    .setDescription("Display host specs plus realtime download/upload speed."),

  async execute(interaction: ChatInputCommandInteraction) {
    await execute(interaction);
  },

  async prefixExecute(message: Message, args: string[]) {
    const interaction = createInteractionFromMessage(message, args);
    await execute(interaction as any);
  },
};
