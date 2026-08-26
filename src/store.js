import fs from "node:fs/promises";
import path from "node:path";

const EMPTY_STATE = Object.freeze({ schemaVersion: 1, profiles: {}, tickets: {} });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class JsonStore {
  #directory;
  #filename;
  #state = clone(EMPTY_STATE);
  #saveQueue = Promise.resolve();

  constructor(directory) {
    this.#directory = directory;
    this.#filename = path.join(directory, "state.json");
  }

  async initialize() {
    await fs.mkdir(this.#directory, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.#filename, "utf8"));
      if (parsed.schemaVersion !== 1 || typeof parsed.profiles !== "object") {
        throw new Error("Unsupported state schema");
      }
      this.#state = {
        schemaVersion: 1,
        profiles: parsed.profiles ?? {},
        tickets: parsed.tickets ?? {},
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.flush();
    }
  }

  getProfile(profileId) {
    const profile = this.#state.profiles[profileId];
    return profile ? clone(profile) : null;
  }

  listProfiles() {
    return Object.values(this.#state.profiles).map(clone);
  }

  async putProfile(profile) {
    this.#state.profiles[profile.profileId] = clone(profile);
    await this.flush();
    return this.getProfile(profile.profileId);
  }

  getTicket(ticketId) {
    const ticket = this.#state.tickets[ticketId];
    return ticket ? clone(ticket) : null;
  }

  async putTicket(ticket) {
    this.#state.tickets[ticket.ticketId] = clone(ticket);
    await this.flush();
    return this.getTicket(ticket.ticketId);
  }

  async deleteTicket(ticketId) {
    const existed = Boolean(this.#state.tickets[ticketId]);
    delete this.#state.tickets[ticketId];
    if (existed) await this.flush();
    return existed;
  }

  async flush() {
    const snapshot = JSON.stringify(this.#state, null, 2);
    this.#saveQueue = this.#saveQueue.then(async () => {
      const temporary = `${this.#filename}.tmp`;
      await fs.writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, this.#filename);
    });
    return this.#saveQueue;
  }
}
