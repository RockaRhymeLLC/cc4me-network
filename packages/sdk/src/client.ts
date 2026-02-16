/**
 * CC4MeNetwork — main SDK client.
 *
 * Handles contacts, messaging, presence, and admin operations.
 */

import { EventEmitter } from 'node:events';
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

export interface CC4MeNetworkEvents {
  message: [msg: Message];
  'contact-request': [req: ContactRequest];
  broadcast: [broadcast: Broadcast];
  'delivery-status': [status: DeliveryStatus];
}

export class CC4MeNetwork extends EventEmitter {
  private options: Required<CC4MeNetworkOptions>;
  private started = false;

  constructor(options: CC4MeNetworkOptions) {
    super();
    this.options = {
      dataDir: './cc4me-network-data',
      heartbeatInterval: 5 * 60 * 1000,
      retryQueueMax: 100,
      ...options,
    };
  }

  /** Start the network client (begins heartbeat, loads cache). */
  async start(): Promise<void> {
    // TODO: implement
    this.started = true;
  }

  /** Stop the network client. */
  async stop(): Promise<void> {
    // TODO: implement
    this.started = false;
  }

  // --- Contacts ---

  async requestContact(username: string, greeting: string): Promise<void> {
    // TODO: implement
    void username; void greeting;
  }

  async getPendingRequests(): Promise<ContactRequest[]> {
    // TODO: implement
    return [];
  }

  async acceptContact(username: string): Promise<void> {
    // TODO: implement
    void username;
  }

  async denyContact(username: string): Promise<void> {
    // TODO: implement
    void username;
  }

  async removeContact(username: string): Promise<void> {
    // TODO: implement
    void username;
  }

  async getContacts(): Promise<Contact[]> {
    // TODO: implement
    return [];
  }

  // --- Messaging ---

  async send(to: string, payload: Record<string, unknown>): Promise<SendResult> {
    // TODO: implement
    void to; void payload;
    return { status: 'failed', messageId: '', error: 'Not implemented' };
  }

  // --- Presence ---

  async checkPresence(username: string): Promise<PresenceInfo> {
    // TODO: implement
    void username;
    return { agent: username, online: false, lastSeen: '' };
  }

  // --- Admin ---

  asAdmin(adminPrivateKey: Buffer) {
    // TODO: implement
    void adminPrivateKey;
    return {
      broadcast: async (type: string, payload: Record<string, unknown>) => {
        void type; void payload;
      },
      approveAgent: async (name: string) => { void name; },
      revokeAgent: async (name: string) => { void name; },
    };
  }

  // --- Diagnostics ---

  getDeliveryReport(messageId: string): DeliveryReport | undefined {
    // TODO: implement
    void messageId;
    return undefined;
  }
}
