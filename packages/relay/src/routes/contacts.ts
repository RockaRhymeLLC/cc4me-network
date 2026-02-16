/**
 * Contacts routes — request, accept, deny, remove, list.
 *
 * POST   /contacts/request        — Send contact request
 * GET    /contacts/pending         — List pending requests (incoming)
 * POST   /contacts/:agent/accept   — Accept a contact request
 * POST   /contacts/:agent/deny     — Deny a contact request
 * DELETE /contacts/:agent           — Remove an established contact
 * GET    /contacts                  — List active contacts
 *
 * Contact pairs are stored with agent_a < agent_b alphabetically.
 * The `requested_by` column tracks who initiated the request.
 */

import type Database from 'better-sqlite3';

/** Maximum greeting length in chars. */
const MAX_GREETING_LENGTH = 500;

export interface ContactResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface ContactInfo {
  agent: string;
  publicKey: string;
  endpoint: string | null;
  since: string;
}

export interface PendingRequest {
  from: string;
  greeting: string | null;
  createdAt: string;
}

/**
 * Order two agent names alphabetically for the composite PK.
 */
function orderPair(a: string, b: string): { agent_a: string; agent_b: string } {
  return a < b ? { agent_a: a, agent_b: b } : { agent_a: b, agent_b: a };
}

/**
 * Check if an agent exists and is active.
 */
function isActiveAgent(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    "SELECT status FROM agents WHERE name = ? AND status = 'active'"
  ).get(name) as { status: string } | undefined;
  return !!row;
}

/**
 * Send a contact request from `fromAgent` to `toAgent`.
 */
export function requestContact(
  db: Database.Database,
  fromAgent: string,
  toAgent: string,
  greeting?: string,
): ContactResult {
  // Can't request yourself
  if (fromAgent === toAgent) {
    return { ok: false, status: 400, error: 'Cannot add yourself as a contact' };
  }

  // Both agents must be active
  if (!isActiveAgent(db, fromAgent)) {
    return { ok: false, status: 403, error: 'Requesting agent is not active' };
  }
  if (!isActiveAgent(db, toAgent)) {
    return { ok: false, status: 404, error: 'Target agent not found or not active' };
  }

  // Validate greeting length
  if (greeting && greeting.length > MAX_GREETING_LENGTH) {
    return { ok: false, status: 400, error: `Greeting too long (max ${MAX_GREETING_LENGTH} chars)` };
  }

  const { agent_a, agent_b } = orderPair(fromAgent, toAgent);

  // Check for existing contact (any status)
  const existing = db.prepare(
    'SELECT status FROM contacts WHERE agent_a = ? AND agent_b = ?'
  ).get(agent_a, agent_b) as { status: string } | undefined;

  if (existing) {
    if (existing.status === 'active') {
      return { ok: false, status: 409, error: 'Already contacts' };
    }
    if (existing.status === 'pending') {
      return { ok: false, status: 409, error: 'Contact request already pending' };
    }
    // If denied or removed, allow re-request by replacing the row
    db.prepare(
      'DELETE FROM contacts WHERE agent_a = ? AND agent_b = ?'
    ).run(agent_a, agent_b);
  }

  // Insert new pending contact
  db.prepare(
    `INSERT INTO contacts (agent_a, agent_b, status, requested_by, greeting)
     VALUES (?, ?, 'pending', ?, ?)`
  ).run(agent_a, agent_b, fromAgent, greeting || null);

  return { ok: true, status: 201 };
}

/**
 * List incoming pending contact requests for an agent.
 */
export function listPendingRequests(
  db: Database.Database,
  agent: string,
): PendingRequest[] {
  // Pending requests where this agent is NOT the requester
  const rows = db.prepare(
    `SELECT agent_a, agent_b, requested_by, greeting, created_at
     FROM contacts
     WHERE status = 'pending'
       AND (agent_a = ? OR agent_b = ?)
       AND requested_by != ?
     ORDER BY created_at ASC`
  ).all(agent, agent, agent) as Array<{
    agent_a: string; agent_b: string; requested_by: string;
    greeting: string | null; created_at: string;
  }>;

  return rows.map((r) => ({
    from: r.requested_by,
    greeting: r.greeting,
    createdAt: r.created_at,
  }));
}

/**
 * Accept a pending contact request.
 * The `agent` is the one accepting; `otherAgent` is who sent the request.
 */
export function acceptContact(
  db: Database.Database,
  agent: string,
  otherAgent: string,
): ContactResult {
  const { agent_a, agent_b } = orderPair(agent, otherAgent);

  const existing = db.prepare(
    'SELECT status, requested_by FROM contacts WHERE agent_a = ? AND agent_b = ?'
  ).get(agent_a, agent_b) as { status: string; requested_by: string } | undefined;

  if (!existing) {
    return { ok: false, status: 404, error: 'No pending contact request found' };
  }

  if (existing.status === 'active') {
    return { ok: true }; // Already active, idempotent
  }

  if (existing.status !== 'pending') {
    return { ok: false, status: 404, error: 'No pending contact request found' };
  }

  // Only the recipient (non-requester) can accept
  if (existing.requested_by === agent) {
    return { ok: false, status: 400, error: 'Cannot accept your own request' };
  }

  db.prepare(
    "UPDATE contacts SET status = 'active', updated_at = datetime('now') WHERE agent_a = ? AND agent_b = ?"
  ).run(agent_a, agent_b);

  return { ok: true };
}

/**
 * Deny a pending contact request.
 * The `agent` is the one denying; `otherAgent` is who sent the request.
 */
export function denyContact(
  db: Database.Database,
  agent: string,
  otherAgent: string,
): ContactResult {
  const { agent_a, agent_b } = orderPair(agent, otherAgent);

  const existing = db.prepare(
    'SELECT status, requested_by FROM contacts WHERE agent_a = ? AND agent_b = ?'
  ).get(agent_a, agent_b) as { status: string; requested_by: string } | undefined;

  if (!existing || existing.status !== 'pending') {
    return { ok: false, status: 404, error: 'No pending contact request found' };
  }

  // Only the recipient can deny
  if (existing.requested_by === agent) {
    return { ok: false, status: 400, error: 'Cannot deny your own request' };
  }

  // Remove the pending request entirely (allows re-request)
  db.prepare(
    'DELETE FROM contacts WHERE agent_a = ? AND agent_b = ?'
  ).run(agent_a, agent_b);

  return { ok: true };
}

/**
 * Remove an active contact. Either side can remove.
 */
export function removeContact(
  db: Database.Database,
  agent: string,
  otherAgent: string,
): ContactResult {
  const { agent_a, agent_b } = orderPair(agent, otherAgent);

  const existing = db.prepare(
    'SELECT status FROM contacts WHERE agent_a = ? AND agent_b = ?'
  ).get(agent_a, agent_b) as { status: string } | undefined;

  if (!existing || existing.status !== 'active') {
    return { ok: false, status: 404, error: 'Contact not found' };
  }

  // Delete the contact row (allows re-request later)
  db.prepare(
    'DELETE FROM contacts WHERE agent_a = ? AND agent_b = ?'
  ).run(agent_a, agent_b);

  return { ok: true };
}

/**
 * List active contacts for an agent, with their public keys and endpoints.
 */
export function listContacts(
  db: Database.Database,
  agent: string,
): ContactInfo[] {
  const rows = db.prepare(
    `SELECT c.agent_a, c.agent_b, c.updated_at,
            a.public_key, a.endpoint, a.name as agent_name
     FROM contacts c
     JOIN agents a ON (
       (c.agent_a = ? AND a.name = c.agent_b)
       OR (c.agent_b = ? AND a.name = c.agent_a)
     )
     WHERE c.status = 'active'
       AND (c.agent_a = ? OR c.agent_b = ?)
     ORDER BY a.name`
  ).all(agent, agent, agent, agent) as Array<{
    agent_a: string; agent_b: string; updated_at: string;
    public_key: string; endpoint: string | null; agent_name: string;
  }>;

  return rows.map((r) => ({
    agent: r.agent_name,
    publicKey: r.public_key,
    endpoint: r.endpoint,
    since: r.updated_at,
  }));
}
