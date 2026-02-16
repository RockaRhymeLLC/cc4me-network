/**
 * CC4MeNetwork — main SDK client.
 *
 * Handles contacts, presence, local cache, and lifecycle.
 * Messaging (send/receive) is implemented in s-p10b.
 */

import { EventEmitter } from 'node:events';
import { createPublicKey, type KeyObject } from 'node:crypto';
import type {
  CC4MeNetworkOptions,
  SendResult,
  Message,
  ContactRequest,
  Broadcast,
  DeliveryStatus,
  PresenceInfo,
  DeliveryReport,
  Contact,
} from './types.js';
import {
  HttpRelayAPI,
  type IRelayAPI,
  type RelayContact,
  type RelayPresence,
} from './relay-api.js';
import {
  loadCache,
  saveCache,
  getCachePath,
  type CacheData,
  type CachedContact,
} from './cache.js';

export interface CC4MeNetworkEvents {
  message: [msg: Message];
  'contact-request': [req: ContactRequest];
  broadcast: [broadcast: Broadcast];
  'delivery-status': [status: DeliveryStatus];
}

export interface CC4MeNetworkInternalOptions extends CC4MeNetworkOptions {
  /** Injectable relay API (for testing). If not provided, uses HttpRelayAPI. */
  relayAPI?: IRelayAPI;
}

export class CC4MeNetwork extends EventEmitter {
  private options: Required<CC4MeNetworkOptions>;
  private started = false;
  private relayAPI: IRelayAPI;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cache: CacheData | null = null;
  private cachePath: string;

  constructor(options: CC4MeNetworkInternalOptions) {
    super();
    this.options = {
      dataDir: './cc4me-network-data',
      heartbeatInterval: 5 * 60 * 1000,
      retryQueueMax: 100,
      ...options,
    };
    this.cachePath = getCachePath(this.options.dataDir);

    // Use injected relay API or create HTTP client
    this.relayAPI = options.relayAPI || new HttpRelayAPI(
      this.options.relayUrl,
      this.options.username,
      this.options.privateKey as unknown as KeyObject,
    );
  }

  /** Start the network client (loads cache, begins heartbeat). */
  async start(): Promise<void> {
    if (this.started) return;

    // Load local cache
    this.cache = loadCache(this.cachePath);

    // If no cache or cache was corrupt, try to populate from relay
    if (!this.cache) {
      await this.refreshContactsFromRelay();
    }

    // Send initial heartbeat
    await this.sendHeartbeat();

    // Start heartbeat timer
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch(() => { /* relay temporarily unreachable */ });
    }, this.options.heartbeatInterval);

    this.started = true;
  }

  /** Stop the network client. */
  async stop(): Promise<void> {
    if (!this.started) return;

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Flush cache
    if (this.cache) {
      saveCache(this.cachePath, this.cache);
    }

    this.started = false;
  }

  /** Whether the client is currently running. */
  get isStarted(): boolean {
    return this.started;
  }

  // --- Contacts ---

  async requestContact(username: string, greeting?: string): Promise<void> {
    const result = await this.relayAPI.requestContact(username, greeting);
    if (!result.ok) {
      throw new Error(result.error || `Failed to request contact: ${result.status}`);
    }
  }

  async getPendingRequests(): Promise<ContactRequest[]> {
    const result = await this.relayAPI.getPendingRequests();
    if (!result.ok) return [];
    return (result.data || []).map((r) => ({
      from: r.from,
      greeting: r.greeting || '',
      publicKey: '',
      ownerEmail: '',
    }));
  }

  async acceptContact(username: string): Promise<void> {
    const result = await this.relayAPI.acceptContact(username);
    if (!result.ok) {
      throw new Error(result.error || `Failed to accept contact: ${result.status}`);
    }
    // Refresh contacts cache
    await this.refreshContactsFromRelay();
  }

  async denyContact(username: string): Promise<void> {
    const result = await this.relayAPI.denyContact(username);
    if (!result.ok) {
      throw new Error(result.error || `Failed to deny contact: ${result.status}`);
    }
  }

  async removeContact(username: string): Promise<void> {
    const result = await this.relayAPI.removeContact(username);
    if (!result.ok) {
      throw new Error(result.error || `Failed to remove contact: ${result.status}`);
    }
    // Update cache
    if (this.cache) {
      this.cache.contacts = this.cache.contacts.filter((c) => c.username !== username);
      this.cache.lastUpdated = new Date().toISOString();
      saveCache(this.cachePath, this.cache);
    }
  }

  async getContacts(): Promise<Contact[]> {
    // Try relay first
    try {
      const result = await this.relayAPI.getContacts();
      if (result.ok && result.data) {
        this.updateContactsCache(result.data);
        return result.data.map(toContact);
      }
    } catch {
      // Relay unreachable — use cache
    }

    // Fall back to cache
    if (this.cache) {
      return this.cache.contacts.map((c) => ({
        username: c.username,
        publicKey: c.publicKey,
        endpoint: c.endpoint || '',
        addedAt: c.addedAt,
      }));
    }

    return [];
  }

  /** Get a contact from the local cache (no relay call). */
  getCachedContact(username: string): CachedContact | undefined {
    return this.cache?.contacts.find((c) => c.username === username);
  }

  // --- Presence ---

  async checkPresence(username: string): Promise<PresenceInfo> {
    try {
      const result = await this.relayAPI.getPresence(username);
      if (result.ok && result.data) {
        return {
          agent: result.data.agent,
          online: result.data.online,
          endpoint: result.data.endpoint || undefined,
          lastSeen: result.data.lastSeen || '',
        };
      }
    } catch {
      // Relay unreachable — return cached data if available
      const cached = this.getCachedContact(username);
      if (cached) {
        return {
          agent: username,
          online: false, // Can't confirm, assume offline
          endpoint: cached.endpoint || undefined,
          lastSeen: '',
        };
      }
    }

    return { agent: username, online: false, lastSeen: '' };
  }

  // --- Messaging (implemented in s-p10b) ---

  async send(to: string, payload: Record<string, unknown>): Promise<SendResult> {
    void to; void payload;
    return { status: 'failed', messageId: '', error: 'Not implemented — see s-p10b' };
  }

  // --- Admin (implemented later) ---

  asAdmin(adminPrivateKey: Buffer) {
    void adminPrivateKey;
    return {
      broadcast: async (type: string, payload: Record<string, unknown>) => {
        void type; void payload;
      },
      approveAgent: async (name: string) => { void name; },
      revokeAgent: async (name: string) => { void name; },
    };
  }

  getDeliveryReport(messageId: string): DeliveryReport | undefined {
    void messageId;
    return undefined;
  }

  // --- Internal ---

  /** Send a presence heartbeat to the relay. */
  private async sendHeartbeat(): Promise<void> {
    try {
      await this.relayAPI.heartbeat(this.options.endpoint);
    } catch {
      // Relay unreachable — will retry on next interval
    }
  }

  /** Refresh contacts list from relay and update cache. */
  private async refreshContactsFromRelay(): Promise<void> {
    try {
      const result = await this.relayAPI.getContacts();
      if (result.ok && result.data) {
        this.updateContactsCache(result.data);
      }
    } catch {
      // Relay unreachable — keep existing cache
    }
  }

  /** Update the local contacts cache. */
  private updateContactsCache(contacts: RelayContact[]): void {
    this.cache = {
      contacts: contacts.map((c) => ({
        username: c.agent,
        publicKey: c.publicKey,
        endpoint: c.endpoint,
        addedAt: c.since,
      })),
      lastUpdated: new Date().toISOString(),
    };
    saveCache(this.cachePath, this.cache);
  }
}

/** Convert a relay contact to the SDK Contact type. */
function toContact(rc: RelayContact): Contact {
  return {
    username: rc.agent,
    publicKey: rc.publicKey,
    endpoint: rc.endpoint || '',
    addedAt: rc.since,
  };
}
