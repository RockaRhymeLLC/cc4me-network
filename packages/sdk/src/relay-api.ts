/**
 * Relay API client — HTTP interface to the CC4Me relay server.
 *
 * Uses Ed25519 signature auth per the relay spec:
 *   Authorization: Signature <agent>:<base64_sig>
 *   X-Timestamp: <ISO-8601>
 *   Signing string: <METHOD> <PATH>\n<TIMESTAMP>\n<BODY_SHA256>
 */

import { createHash, sign as cryptoSign, createPublicKey, type KeyObject } from 'node:crypto';

export interface RelayContact {
  agent: string;
  publicKey: string;
  endpoint: string | null;
  since: string;
}

export interface RelayPendingRequest {
  from: string;
  greeting: string | null;
  createdAt: string;
}

export interface RelayPresence {
  agent: string;
  online: boolean;
  endpoint: string | null;
  lastSeen: string | null;
}

export interface RelayResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

/**
 * Abstract relay API interface — injectable for testing.
 */
export interface IRelayAPI {
  // Contacts
  requestContact(toAgent: string, greeting?: string): Promise<RelayResponse>;
  acceptContact(agent: string): Promise<RelayResponse>;
  denyContact(agent: string): Promise<RelayResponse>;
  removeContact(agent: string): Promise<RelayResponse>;
  getContacts(): Promise<RelayResponse<RelayContact[]>>;
  getPendingRequests(): Promise<RelayResponse<RelayPendingRequest[]>>;

  // Presence
  heartbeat(endpoint: string): Promise<RelayResponse>;
  getPresence(agent: string): Promise<RelayResponse<RelayPresence>>;
  batchPresence(agents: string[]): Promise<RelayResponse<RelayPresence[]>>;
}

/**
 * Build the signing string for relay auth.
 */
function buildSigningString(method: string, path: string, timestamp: string, bodyHash: string): string {
  return `${method} ${path}\n${timestamp}\n${bodyHash}`;
}

/**
 * Hash body content with SHA-256.
 */
function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * HTTP-based relay API client.
 */
export class HttpRelayAPI implements IRelayAPI {
  constructor(
    private relayUrl: string,
    private username: string,
    private privateKey: KeyObject,
  ) {}

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<RelayResponse<T>> {
    const bodyStr = body ? JSON.stringify(body) : '';
    const timestamp = new Date().toISOString();
    const bodyHash = hashBody(bodyStr);
    const signingString = buildSigningString(method, path, timestamp, bodyHash);
    const sig = cryptoSign(null, Buffer.from(signingString), this.privateKey);
    const authHeader = `Signature ${this.username}:${Buffer.from(sig).toString('base64')}`;

    const url = `${this.relayUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': authHeader,
      'X-Timestamp': timestamp,
    };
    if (bodyStr) headers['Content-Type'] = 'application/json';

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: bodyStr || undefined,
      });
      const data = await res.json() as T;
      if (res.ok) {
        return { ok: true, status: res.status, data };
      }
      return { ok: false, status: res.status, error: (data as any)?.error || res.statusText };
    } catch (err: any) {
      return { ok: false, status: 0, error: err.message };
    }
  }

  async requestContact(toAgent: string, greeting?: string): Promise<RelayResponse> {
    return this.request('POST', '/contacts/request', { toAgent, greeting });
  }

  async acceptContact(agent: string): Promise<RelayResponse> {
    return this.request('POST', `/contacts/${agent}/accept`);
  }

  async denyContact(agent: string): Promise<RelayResponse> {
    return this.request('POST', `/contacts/${agent}/deny`);
  }

  async removeContact(agent: string): Promise<RelayResponse> {
    return this.request('DELETE', `/contacts/${agent}`);
  }

  async getContacts(): Promise<RelayResponse<RelayContact[]>> {
    return this.request<RelayContact[]>('GET', '/contacts');
  }

  async getPendingRequests(): Promise<RelayResponse<RelayPendingRequest[]>> {
    return this.request<RelayPendingRequest[]>('GET', '/contacts/pending');
  }

  async heartbeat(endpoint: string): Promise<RelayResponse> {
    return this.request('PUT', '/presence', { endpoint });
  }

  async getPresence(agent: string): Promise<RelayResponse<RelayPresence>> {
    return this.request<RelayPresence>('GET', `/presence/${agent}`);
  }

  async batchPresence(agents: string[]): Promise<RelayResponse<RelayPresence[]>> {
    return this.request<RelayPresence[]>('GET', `/presence/batch?agents=${agents.join(',')}`);
  }
}
