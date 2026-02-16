/**
 * Tests for contacts system (t-059, t-060).
 *
 * t-059: Contact request → accept → mutual messaging
 * t-060: Contact deny/remove + re-request behavior
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDatabase } from '../db.js';
import { hashCode } from '../email.js';
import {
  requestContact,
  listPendingRequests,
  acceptContact,
  denyContact,
  removeContact,
  listContacts,
} from '../routes/contacts.js';

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-contacts-test-'));
  const dbPath = join(dir, 'relay.db');
  const db = initializeDatabase(dbPath);
  return { db, dir };
}

/** Generate an Ed25519 keypair and return base64 SPKI public key. */
function genKeypair() {
  const kp = generateKeyPairSync('ed25519');
  const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    publicKeyBase64: Buffer.from(pubDer).toString('base64'),
  };
}

/** Register and approve an agent (admin-fast-path for tests). */
function createActiveAgent(
  db: ReturnType<typeof initializeDatabase>,
  name: string,
  publicKeyBase64: string,
  endpoint?: string,
) {
  db.prepare(
    "INSERT INTO agents (name, public_key, endpoint, email_verified, status, approved_by, approved_at) VALUES (?, ?, ?, 1, 'active', 'test-admin', datetime('now'))"
  ).run(name, publicKeyBase64, endpoint || null);
}

/** Seed an admin entry (needed for approval fast-path). */
function seedAdmin(db: ReturnType<typeof initializeDatabase>, name: string, publicKeyBase64: string) {
  db.prepare(
    "INSERT OR IGNORE INTO agents (name, public_key, status) VALUES (?, ?, 'active')"
  ).run(name, publicKeyBase64);
  db.prepare(
    'INSERT OR IGNORE INTO admins (agent, admin_public_key) VALUES (?, ?)'
  ).run(name, publicKeyBase64);
}

// ================================================================
// t-059: Contact request → accept → mutual contact status
// ================================================================

describe('t-059: Contact request → accept → mutual messaging', () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
    cleanupDirs = [];
  });

  function withDb() {
    const { db, dir } = setupDb();
    cleanupDirs.push(dir);
    return db;
  }

  // Step 1: Register and approve two agents: "alice" and "bob"
  it('step 1: register and approve two agents', () => {
    const db = withDb();
    const alice = genKeypair();
    const bob = genKeypair();

    createActiveAgent(db, 'alice', alice.publicKeyBase64, 'https://alice.example.com/inbox');
    createActiveAgent(db, 'bob', bob.publicKeyBase64, 'https://bob.example.com/inbox');

    const aliceRow = db.prepare("SELECT status FROM agents WHERE name = 'alice'").get() as any;
    const bobRow = db.prepare("SELECT status FROM agents WHERE name = 'bob'").get() as any;
    assert.equal(aliceRow.status, 'active');
    assert.equal(bobRow.status, 'active');

    db.close();
  });

  // Step 2: POST /contacts/request from alice with greeting "Hi Bob!"
  it('step 2: alice sends contact request to bob with greeting', () => {
    const db = withDb();
    const alice = genKeypair();
    const bob = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'bob', bob.publicKeyBase64);

    const result = requestContact(db, 'alice', 'bob', 'Hi Bob!');
    assert.equal(result.ok, true);
    assert.equal(result.status, 201);

    db.close();
  });

  // Step 3: GET /contacts/pending as bob — returns alice's request with greeting
  it('step 3: bob sees alice pending request with greeting', () => {
    const db = withDb();
    const alice = genKeypair();
    const bob = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'bob', bob.publicKeyBase64);
    requestContact(db, 'alice', 'bob', 'Hi Bob!');

    const pending = listPendingRequests(db, 'bob');
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.from, 'alice');
    assert.equal(pending[0]!.greeting, 'Hi Bob!');

    db.close();
  });

  // Step 4: POST /contacts/alice/accept as bob → active
  it('step 4: bob accepts alice contact request → active', () => {
    const db = withDb();
    const alice = genKeypair();
    const bob = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'bob', bob.publicKeyBase64);
    requestContact(db, 'alice', 'bob', 'Hi Bob!');

    const result = acceptContact(db, 'bob', 'alice');
    assert.equal(result.ok, true);

    // Verify status in DB
    const row = db.prepare(
      "SELECT status FROM contacts WHERE agent_a = 'alice' AND agent_b = 'bob'"
    ).get() as any;
    assert.equal(row.status, 'active');

    db.close();
  });

  // Step 5: GET /contacts as alice → returns bob with public key and endpoint
  it('step 5: alice sees bob as active contact with key and endpoint', () => {
    const db = withDb();
    const alice = genKeypair();
    const bob = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64, 'https://alice.example.com/inbox');
    createActiveAgent(db, 'bob', bob.publicKeyBase64, 'https://bob.example.com/inbox');
    requestContact(db, 'alice', 'bob', 'Hi Bob!');
    acceptContact(db, 'bob', 'alice');

    const contacts = listContacts(db, 'alice');
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0]!.agent, 'bob');
    assert.equal(contacts[0]!.publicKey, bob.publicKeyBase64);
    assert.equal(contacts[0]!.endpoint, 'https://bob.example.com/inbox');

    db.close();
  });

  // Step 6: GET /contacts as bob → returns alice with public key and endpoint
  it('step 6: bob sees alice as active contact with key and endpoint', () => {
    const db = withDb();
    const alice = genKeypair();
    const bob = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64, 'https://alice.example.com/inbox');
    createActiveAgent(db, 'bob', bob.publicKeyBase64, 'https://bob.example.com/inbox');
    requestContact(db, 'alice', 'bob', 'Hi Bob!');
    acceptContact(db, 'bob', 'alice');

    const contacts = listContacts(db, 'bob');
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0]!.agent, 'alice');
    assert.equal(contacts[0]!.publicKey, alice.publicKeyBase64);
    assert.equal(contacts[0]!.endpoint, 'https://alice.example.com/inbox');

    db.close();
  });

  // Step 7: Verify contact pair stored with agent_a < agent_b alphabetically
  it('step 7: contact pair stored with agent_a < agent_b alphabetically', () => {
    const db = withDb();
    const alice = genKeypair();
    const bob = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'bob', bob.publicKeyBase64);
    requestContact(db, 'alice', 'bob', 'Hi Bob!');
    acceptContact(db, 'bob', 'alice');

    // "alice" < "bob" alphabetically, so agent_a = alice, agent_b = bob
    const row = db.prepare(
      "SELECT agent_a, agent_b FROM contacts WHERE agent_a = 'alice' AND agent_b = 'bob'"
    ).get() as any;
    assert.ok(row, 'Contact row should exist');
    assert.equal(row.agent_a, 'alice');
    assert.equal(row.agent_b, 'bob');

    // Verify no reversed row exists
    const reversed = db.prepare(
      "SELECT * FROM contacts WHERE agent_a = 'bob' AND agent_b = 'alice'"
    ).get();
    assert.equal(reversed, undefined, 'No reversed row should exist');

    db.close();
  });

  // Step 8: Verify alice can see bob's presence
  // (Presence is s-p08, but we verify the contact lookup that enables it)
  it('step 8: contacts are queryable by either party', () => {
    const db = withDb();
    const alice = genKeypair();
    const bob = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64, 'https://alice.example.com/inbox');
    createActiveAgent(db, 'bob', bob.publicKeyBase64, 'https://bob.example.com/inbox');
    requestContact(db, 'alice', 'bob');
    acceptContact(db, 'bob', 'alice');

    // Both can see each other
    const aliceContacts = listContacts(db, 'alice');
    const bobContacts = listContacts(db, 'bob');
    assert.equal(aliceContacts.length, 1);
    assert.equal(bobContacts.length, 1);
    assert.equal(aliceContacts[0]!.agent, 'bob');
    assert.equal(bobContacts[0]!.agent, 'alice');

    db.close();
  });
});

// ================================================================
// t-060: Contact deny/remove + re-request behavior
// ================================================================

describe('t-060: Contact deny/remove + re-request behavior', () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
    cleanupDirs = [];
  });

  function withDb() {
    const { db, dir } = setupDb();
    cleanupDirs.push(dir);
    return db;
  }

  // Step 1: Register two agents: 'alice' and 'charlie'
  it('step 1: register two agents alice and charlie', () => {
    const db = withDb();
    const alice = genKeypair();
    const charlie = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'charlie', charlie.publicKeyBase64);

    const aliceRow = db.prepare("SELECT status FROM agents WHERE name = 'alice'").get() as any;
    const charlieRow = db.prepare("SELECT status FROM agents WHERE name = 'charlie'").get() as any;
    assert.equal(aliceRow.status, 'active');
    assert.equal(charlieRow.status, 'active');

    db.close();
  });

  // Step 2: POST /contacts/request from alice to charlie → 201 pending
  it('step 2: alice sends contact request to charlie', () => {
    const db = withDb();
    const alice = genKeypair();
    const charlie = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'charlie', charlie.publicKeyBase64);

    const result = requestContact(db, 'alice', 'charlie');
    assert.equal(result.ok, true);
    assert.equal(result.status, 201);

    db.close();
  });

  // Step 3: POST /contacts/charlie/deny as charlie → removed from pending
  it('step 3: charlie denies alice contact request', () => {
    const db = withDb();
    const alice = genKeypair();
    const charlie = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'charlie', charlie.publicKeyBase64);
    requestContact(db, 'alice', 'charlie');

    const result = denyContact(db, 'charlie', 'alice');
    assert.equal(result.ok, true);

    // Verify removed from pending
    const pending = listPendingRequests(db, 'charlie');
    assert.equal(pending.length, 0);

    db.close();
  });

  // Step 4: POST /contacts/request from alice to charlie again (re-request after deny)
  it('step 4: alice re-requests contact after deny → 201', () => {
    const db = withDb();
    const alice = genKeypair();
    const charlie = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'charlie', charlie.publicKeyBase64);
    requestContact(db, 'alice', 'charlie');
    denyContact(db, 'charlie', 'alice');

    const result = requestContact(db, 'alice', 'charlie');
    assert.equal(result.ok, true);
    assert.equal(result.status, 201);

    db.close();
  });

  // Step 5: Accept the request, establish mutual contact
  it('step 5: charlie accepts re-request → both are contacts', () => {
    const db = withDb();
    const alice = genKeypair();
    const charlie = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'charlie', charlie.publicKeyBase64);
    requestContact(db, 'alice', 'charlie');
    denyContact(db, 'charlie', 'alice');
    requestContact(db, 'alice', 'charlie');

    const result = acceptContact(db, 'charlie', 'alice');
    assert.equal(result.ok, true);

    const aliceContacts = listContacts(db, 'alice');
    const charlieContacts = listContacts(db, 'charlie');
    assert.equal(aliceContacts.length, 1);
    assert.equal(charlieContacts.length, 1);

    db.close();
  });

  // Step 6: DELETE /contacts/charlie as alice (remove contact)
  it('step 6: alice removes charlie as contact', () => {
    const db = withDb();
    const alice = genKeypair();
    const charlie = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'charlie', charlie.publicKeyBase64);
    requestContact(db, 'alice', 'charlie');
    denyContact(db, 'charlie', 'alice');
    requestContact(db, 'alice', 'charlie');
    acceptContact(db, 'charlie', 'alice');

    const result = removeContact(db, 'alice', 'charlie');
    assert.equal(result.ok, true);

    db.close();
  });

  // Step 7: Verify alice no longer sees charlie in GET /contacts
  it('step 7: alice no longer sees charlie in contacts', () => {
    const db = withDb();
    const alice = genKeypair();
    const charlie = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'charlie', charlie.publicKeyBase64);
    requestContact(db, 'alice', 'charlie');
    denyContact(db, 'charlie', 'alice');
    requestContact(db, 'alice', 'charlie');
    acceptContact(db, 'charlie', 'alice');
    removeContact(db, 'alice', 'charlie');

    const contacts = listContacts(db, 'alice');
    assert.equal(contacts.length, 0);

    db.close();
  });

  // Step 8: Verify charlie's contacts list no longer includes alice
  it('step 8: charlie also no longer sees alice in contacts', () => {
    const db = withDb();
    const alice = genKeypair();
    const charlie = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'charlie', charlie.publicKeyBase64);
    requestContact(db, 'alice', 'charlie');
    denyContact(db, 'charlie', 'alice');
    requestContact(db, 'alice', 'charlie');
    acceptContact(db, 'charlie', 'alice');
    removeContact(db, 'alice', 'charlie');

    const contacts = listContacts(db, 'charlie');
    assert.equal(contacts.length, 0);

    db.close();
  });

  // Step 9: POST /contacts/request from alice to charlie (re-request after removal)
  it('step 9: alice re-requests contact after removal → 201', () => {
    const db = withDb();
    const alice = genKeypair();
    const charlie = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'charlie', charlie.publicKeyBase64);
    requestContact(db, 'alice', 'charlie');
    denyContact(db, 'charlie', 'alice');
    requestContact(db, 'alice', 'charlie');
    acceptContact(db, 'charlie', 'alice');
    removeContact(db, 'alice', 'charlie');

    const result = requestContact(db, 'alice', 'charlie');
    assert.equal(result.ok, true);
    assert.equal(result.status, 201);

    db.close();
  });
});

// ================================================================
// Additional contacts coverage
// ================================================================

describe('Contacts: edge cases', () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
    cleanupDirs = [];
  });

  function withDb() {
    const { db, dir } = setupDb();
    cleanupDirs.push(dir);
    return db;
  }

  it('cannot request contact with yourself', () => {
    const db = withDb();
    const alice = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);

    const result = requestContact(db, 'alice', 'alice');
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);

    db.close();
  });

  it('cannot request contact with non-existent agent', () => {
    const db = withDb();
    const alice = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);

    const result = requestContact(db, 'alice', 'ghost');
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);

    db.close();
  });

  it('cannot request contact with revoked agent', () => {
    const db = withDb();
    const alice = genKeypair();
    const revoked = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    db.prepare(
      "INSERT INTO agents (name, public_key, status) VALUES (?, ?, 'revoked')"
    ).run('revoked', revoked.publicKeyBase64);

    const result = requestContact(db, 'alice', 'revoked');
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);

    db.close();
  });

  it('duplicate pending request rejected with 409', () => {
    const db = withDb();
    const alice = genKeypair();
    const bob = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'bob', bob.publicKeyBase64);

    requestContact(db, 'alice', 'bob');
    const result = requestContact(db, 'alice', 'bob');
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);

    db.close();
  });

  it('greeting over 500 chars rejected', () => {
    const db = withDb();
    const alice = genKeypair();
    const bob = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'bob', bob.publicKeyBase64);

    const longGreeting = 'x'.repeat(501);
    const result = requestContact(db, 'alice', 'bob', longGreeting);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error!, /too long/i);

    db.close();
  });

  it('cannot accept non-existent request', () => {
    const db = withDb();
    const alice = genKeypair();
    const bob = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'bob', bob.publicKeyBase64);

    const result = acceptContact(db, 'bob', 'alice');
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);

    db.close();
  });

  it('requester cannot accept own request', () => {
    const db = withDb();
    const alice = genKeypair();
    const bob = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'bob', bob.publicKeyBase64);
    requestContact(db, 'alice', 'bob');

    const result = acceptContact(db, 'alice', 'bob');
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);

    db.close();
  });

  it('remove non-existent contact returns 404', () => {
    const db = withDb();
    const alice = genKeypair();
    const bob = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'bob', bob.publicKeyBase64);

    const result = removeContact(db, 'alice', 'bob');
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);

    db.close();
  });

  it('pending requests not visible to requester', () => {
    const db = withDb();
    const alice = genKeypair();
    const bob = genKeypair();
    createActiveAgent(db, 'alice', alice.publicKeyBase64);
    createActiveAgent(db, 'bob', bob.publicKeyBase64);
    requestContact(db, 'alice', 'bob');

    // Alice (the requester) should NOT see this in pending
    const alicePending = listPendingRequests(db, 'alice');
    assert.equal(alicePending.length, 0);

    // Bob (the recipient) should see it
    const bobPending = listPendingRequests(db, 'bob');
    assert.equal(bobPending.length, 1);

    db.close();
  });
});
