import { Events, Interaction } from "discord.js";
import { handleInteraction } from "../handlers/InteractionHandler";

export default {
  name: Events.InteractionCreate,
  once: false,
  async execute(interaction: Interaction) {
    await handleInteraction(interaction);
  },
};