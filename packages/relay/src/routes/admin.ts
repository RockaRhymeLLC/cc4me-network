/**
 * Admin logic — pending registrations, admin keys, broadcasts.
 *
 * GET  /admin/pending     — List pending registrations (admin only)
 * GET  /admin/keys        — List registered admin public keys (public)
 * GET  /admin/broadcasts  — List broadcasts (authenticated)
 */

import type Database from 'better-sqlite3';

/**
 * List pending agent registrations (admin only).
 */
export function listPendingRegistrations(db: Database.Database): Array<{
  name: string;
  ownerEmail: string | null;
  endpoint: string | null;
  createdAt: string;
}> {
  const rows = db.prepare(
    "SELECT name, owner_email, endpoint, created_at FROM agents WHERE status = 'pending' ORDER BY created_at ASC"
  ).all() as Array<{ name: string; owner_email: string | null; endpoint: string | null; created_at: string }>;

  return rows.map((r) => ({
    name: r.name,
    ownerEmail: r.owner_email,
    endpoint: r.endpoint,
    createdAt: r.created_at,
  }));
}

/**
 * List registered admin public keys (public endpoint).
 */
export function listAdminKeys(db: Database.Database): Array<{
  agent: string;
  adminPublicKey: string;
  addedAt: string;
}> {
  const rows = db.prepare(
    'SELECT agent, admin_public_key, added_at FROM admins ORDER BY agent'
  ).all() as Array<{ agent: string; admin_public_key: string; added_at: string }>;

  return rows.map((r) => ({
    agent: r.agent,
    adminPublicKey: r.admin_public_key,
    addedAt: r.added_at,
  }));
}

/**
 * List broadcasts (optionally filtered by type).
 */
export function listBroadcasts(
  db: Database.Database,
  type?: string,
  limit: number = 50,
): Array<{
  id: string;
  type: string;
  payload: string;
  sender: string;
  createdAt: string;
}> {
  let query = 'SELECT id, type, payload, sender, created_at FROM broadcasts';
  const params: unknown[] = [];

  if (type) {
    query += ' WHERE type = ?';
    params.push(type);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(query).all(...params) as Array<{
    id: string; type: string; payload: string; sender: string; created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    payload: r.payload,
    sender: r.sender,
    createdAt: r.created_at,
  }));
}
