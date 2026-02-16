/**
 * Tests for registry + multi-admin (t-057, t-058).
 *
 * t-057: Multi-admin registration approval flow
 * t-058: Agent revocation with broadcast notification
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDatabase } from '../db.js';
import { hashCode } from '../email.js';
import { authenticateRequest, buildSigningString, hashBody } from '../auth.js';
import {
  registerAgent,
  approveAgent,
  revokeAgent,
  listAgents,
  getAgent,
} from '../routes/registry.js';
import { listPendingRegistrations, listAdminKeys, listBroadcasts } from '../routes/admin.js';

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-reg-test-'));
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

/** Set up email verification for an agent (simulate /verify flow). */
function verifyEmail(db: ReturnType<typeof initializeDatabase>, agentName: string, email: string) {
  const code = '123456';
  const codeHash = hashCode(code);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO email_verifications (agent_name, email, code_hash, attempts, expires_at, verified)
    VALUES (?, ?, ?, 0, ?, 1)
    ON CONFLICT(agent_name) DO UPDATE SET email = excluded.email, verified = 1
  `).run(agentName, email, codeHash, expiresAt);
}

/** Seed admin entries. */
function seedAdmins(db: ReturnType<typeof initializeDatabase>, admins: Array<{ name: string; publicKeyBase64: string }>) {
  for (const a of admins) {
    // Must have an agent record first for FK
    db.prepare(
      "INSERT OR IGNORE INTO agents (name, public_key, status) VALUES (?, ?, 'active')"
    ).run(a.name, a.publicKeyBase64);
    db.prepare(
      'INSERT OR IGNORE INTO admins (agent, admin_public_key) VALUES (?, ?)'
    ).run(a.name, a.publicKeyBase64);
  }
}

describe('t-057: Multi-admin: register, approve, checklist enforcement', () => {
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

  // Step 1: Seed two admin entries
  it('step 1: seed database with two admin entries', () => {
    const db = withDb();
    const bmo = genKeypair();
    const r2 = genKeypair();

    seedAdmins(db, [
      { name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 },
      { name: 'r2d2', publicKeyBase64: r2.publicKeyBase64 },
    ]);

    const admins = listAdminKeys(db);
    assert.equal(admins.length, 2);
    assert.ok(admins.some((a) => a.agent === 'bmo'));
    assert.ok(admins.some((a) => a.agent === 'r2d2'));

    db.close();
  });

  // Step 2: Complete email verification for "atlas"
  it('step 2: complete email verification for new agent', () => {
    const db = withDb();
    verifyEmail(db, 'atlas', 'atlas@example.com');

    const entry = db.prepare('SELECT verified FROM email_verifications WHERE agent_name = ?')
      .get('atlas') as any;
    assert.equal(entry.verified, 1);

    db.close();
  });

  // Step 3: Register "atlas" → pending
  it('step 3: register agent after email verification → pending', () => {
    const db = withDb();
    const atlas = genKeypair();

    verifyEmail(db, 'atlas', 'atlas@example.com');
    const result = registerAgent(db, 'atlas', atlas.publicKeyBase64, 'atlas@example.com', 'https://atlas.example.com/inbox');

    assert.equal(result.ok, true);
    assert.equal(result.agent?.status, 'pending');

    const agent = getAgent(db, 'atlas');
    assert.equal(agent?.status, 'pending');

    db.close();
  });

  // Step 4: Approve with bmo's admin key → active
  it('step 4: approve agent with admin key → active', () => {
    const db = withDb();
    const bmo = genKeypair();
    const atlas = genKeypair();

    seedAdmins(db, [{ name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 }]);
    verifyEmail(db, 'atlas', 'atlas@example.com');
    registerAgent(db, 'atlas', atlas.publicKeyBase64, 'atlas@example.com', '');

    const result = approveAgent(db, 'atlas', 'bmo');
    assert.equal(result.ok, true);
    assert.equal(result.agent?.status, 'active');

    const agent = getAgent(db, 'atlas');
    assert.equal(agent?.status, 'active');
    assert.equal(agent?.approvedBy, 'bmo');

    db.close();
  });

  // Step 5: Non-admin approval → 403
  it('step 5: approve with non-admin key → 403', () => {
    const db = withDb();
    const atlas = genKeypair();

    verifyEmail(db, 'atlas', 'atlas@example.com');
    registerAgent(db, 'atlas', atlas.publicKeyBase64, 'atlas@example.com', '');

    const result = approveAgent(db, 'atlas', 'random-agent');
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);

    db.close();
  });

  // Step 6: Disposable email blocked
  it('step 6: disposable email domain rejected', () => {
    const db = withDb();
    const agent = genKeypair();

    // Simulate verified disposable email
    verifyEmail(db, 'spammer', 'spammer@mailinator.com');

    const result = registerAgent(db, 'spammer', agent.publicKeyBase64, 'spammer@mailinator.com', '');
    assert.equal(result.ok, false);
    assert.match(result.error!, /[Dd]isposable/i);

    db.close();
  });

  // Step 7: GET /admin/pending lists pending registrations
  it('step 7: list pending registrations', () => {
    const db = withDb();
    const bmo = genKeypair();
    seedAdmins(db, [{ name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 }]);

    const agent1 = genKeypair();
    const agent2 = genKeypair();
    verifyEmail(db, 'agent1', 'a1@example.com');
    verifyEmail(db, 'agent2', 'a2@example.com');
    registerAgent(db, 'agent1', agent1.publicKeyBase64, 'a1@example.com', '');
    registerAgent(db, 'agent2', agent2.publicKeyBase64, 'a2@example.com', '');

    const pending = listPendingRegistrations(db);
    assert.equal(pending.length, 2);
    assert.ok(pending.some((p) => p.name === 'agent1'));
    assert.ok(pending.some((p) => p.name === 'agent2'));

    // Approve one and re-check
    approveAgent(db, 'agent1', 'bmo');
    const pending2 = listPendingRegistrations(db);
    assert.equal(pending2.length, 1);
    assert.equal(pending2[0]!.name, 'agent2');

    db.close();
  });

  // Step 8: Approved agent can authenticate
  it('step 8: approved agent passes authentication', () => {
    const db = withDb();
    const bmo = genKeypair();
    const atlas = genKeypair();

    seedAdmins(db, [{ name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 }]);
    verifyEmail(db, 'atlas', 'atlas@example.com');
    registerAgent(db, 'atlas', atlas.publicKeyBase64, 'atlas@example.com', '');
    approveAgent(db, 'atlas', 'bmo');

    // Auth should work now
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const bodyHash = hashBody('');
    const sigString = buildSigningString('GET', '/test', timestamp, bodyHash);

    const sig = cryptoSign(null, Buffer.from(sigString), atlas.privateKey);
    const authHeader = `Signature atlas:${Buffer.from(sig).toString('base64')}`;

    const result = authenticateRequest(db, 'GET', '/test', timestamp, '', authHeader, now);
    assert.equal(result.ok, true);
    assert.equal(result.agent, 'atlas');

    db.close();
  });
});

describe('t-058: Agent revocation: immediate block + broadcast notification', () => {
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

  // Step 1: Register and approve "rogue"
  it('step 1: register and approve rogue agent', () => {
    const db = withDb();
    const admin = genKeypair();
    const rogue = genKeypair();

    seedAdmins(db, [{ name: 'admin', publicKeyBase64: admin.publicKeyBase64 }]);
    verifyEmail(db, 'rogue', 'rogue@example.com');
    registerAgent(db, 'rogue', rogue.publicKeyBase64, 'rogue@example.com', '');
    approveAgent(db, 'rogue', 'admin');

    const agent = getAgent(db, 'rogue');
    assert.equal(agent?.status, 'active');

    db.close();
  });

  // Step 2: Verify "rogue" can authenticate
  it('step 2: active rogue agent can authenticate', () => {
    const db = withDb();
    const admin = genKeypair();
    const rogue = genKeypair();

    seedAdmins(db, [{ name: 'admin', publicKeyBase64: admin.publicKeyBase64 }]);
    verifyEmail(db, 'rogue', 'rogue@example.com');
    registerAgent(db, 'rogue', rogue.publicKeyBase64, 'rogue@example.com', '');
    approveAgent(db, 'rogue', 'admin');

    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const bodyHash = hashBody('');
    const sigString = buildSigningString('PUT', '/presence', timestamp, bodyHash);

    const sig = cryptoSign(null, Buffer.from(sigString), rogue.privateKey);
    const authHeader = `Signature rogue:${Buffer.from(sig).toString('base64')}`;

    const result = authenticateRequest(db, 'PUT', '/presence', timestamp, '', authHeader, now);
    assert.equal(result.ok, true);

    db.close();
  });

  // Step 3: Revoke "rogue"
  it('step 3: admin revokes rogue agent', () => {
    const db = withDb();
    const admin = genKeypair();
    const rogue = genKeypair();

    seedAdmins(db, [{ name: 'admin', publicKeyBase64: admin.publicKeyBase64 }]);
    verifyEmail(db, 'rogue', 'rogue@example.com');
    registerAgent(db, 'rogue', rogue.publicKeyBase64, 'rogue@example.com', '');
    approveAgent(db, 'rogue', 'admin');

    const result = revokeAgent(db, 'rogue', 'admin');
    assert.equal(result.ok, true);
    assert.equal(result.agent?.status, 'revoked');

    db.close();
  });

  // Step 4: Revoked agent cannot authenticate
  it('step 4: revoked agent cannot authenticate → 403', () => {
    const db = withDb();
    const admin = genKeypair();
    const rogue = genKeypair();

    seedAdmins(db, [{ name: 'admin', publicKeyBase64: admin.publicKeyBase64 }]);
    verifyEmail(db, 'rogue', 'rogue@example.com');
    registerAgent(db, 'rogue', rogue.publicKeyBase64, 'rogue@example.com', '');
    approveAgent(db, 'rogue', 'admin');
    revokeAgent(db, 'rogue', 'admin');

    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const bodyHash = hashBody('');
    const sigString = buildSigningString('GET', '/test', timestamp, bodyHash);

    const sig = cryptoSign(null, Buffer.from(sigString), rogue.privateKey);
    const authHeader = `Signature rogue:${Buffer.from(sig).toString('base64')}`;

    const result = authenticateRequest(db, 'GET', '/test', timestamp, '', authHeader, now);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.match(result.error!, /revoked/i);

    db.close();
  });

  // Step 5: Revocation broadcast stored
  it('step 5: revocation broadcast stored in broadcasts table', () => {
    const db = withDb();
    const admin = genKeypair();
    const rogue = genKeypair();

    seedAdmins(db, [{ name: 'admin', publicKeyBase64: admin.publicKeyBase64 }]);
    verifyEmail(db, 'rogue', 'rogue@example.com');
    registerAgent(db, 'rogue', rogue.publicKeyBase64, 'rogue@example.com', '');
    approveAgent(db, 'rogue', 'admin');
    revokeAgent(db, 'rogue', 'admin');

    const broadcasts = listBroadcasts(db, 'revocation');
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0]!.type, 'revocation');
    assert.equal(broadcasts[0]!.sender, 'admin');

    const payload = JSON.parse(broadcasts[0]!.payload);
    assert.equal(payload.revokedAgent, 'rogue');

    db.close();
  });

  // Step 6: Other agents can retrieve revocation broadcasts
  it('step 6: broadcasts visible to other agents', () => {
    const db = withDb();
    const admin = genKeypair();
    const rogue = genKeypair();

    seedAdmins(db, [{ name: 'admin', publicKeyBase64: admin.publicKeyBase64 }]);
    verifyEmail(db, 'rogue', 'rogue@example.com');
    registerAgent(db, 'rogue', rogue.publicKeyBase64, 'rogue@example.com', '');
    approveAgent(db, 'rogue', 'admin');
    revokeAgent(db, 'rogue', 'admin');

    // Any agent can list broadcasts
    const all = listBroadcasts(db);
    assert.ok(all.length >= 1);
    assert.ok(all.some((b) => b.type === 'revocation'));

    db.close();
  });
});

// ================================================================
// Additional registry coverage
// ================================================================

describe('Registry: edge cases', () => {
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

  it('register without email verification fails', () => {
    const db = withDb();
    const agent = genKeypair();
    const result = registerAgent(db, 'noverify', agent.publicKeyBase64, 'noverify@example.com', '');
    assert.equal(result.ok, false);
    assert.match(result.error!, /not verified/i);
    db.close();
  });

  it('register duplicate agent fails', () => {
    const db = withDb();
    const agent = genKeypair();
    verifyEmail(db, 'dupe', 'dupe@example.com');
    registerAgent(db, 'dupe', agent.publicKeyBase64, 'dupe@example.com', '');

    // Re-verify for second attempt
    verifyEmail(db, 'dupe2', 'dupe2@example.com');
    // Try registering with same name (would fail since it already exists)
    const result = registerAgent(db, 'dupe', agent.publicKeyBase64, 'dupe@example.com', '');
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);

    db.close();
  });

  it('invalid agent name rejected', () => {
    const db = withDb();
    const agent = genKeypair();

    const result1 = registerAgent(db, '', agent.publicKeyBase64, 'a@b.com', '');
    assert.equal(result1.ok, false);

    const result2 = registerAgent(db, 'has spaces', agent.publicKeyBase64, 'a@b.com', '');
    assert.equal(result2.ok, false);

    const result3 = registerAgent(db, 'a'.repeat(65), agent.publicKeyBase64, 'a@b.com', '');
    assert.equal(result3.ok, false);

    db.close();
  });

  it('listAgents returns all agents', () => {
    const db = withDb();
    const admin = genKeypair();
    seedAdmins(db, [{ name: 'admin', publicKeyBase64: admin.publicKeyBase64 }]);

    const a1 = genKeypair();
    verifyEmail(db, 'agent1', 'a1@example.com');
    registerAgent(db, 'agent1', a1.publicKeyBase64, 'a1@example.com', '');

    const agents = listAgents(db);
    assert.ok(agents.length >= 2); // admin + agent1
    assert.ok(agents.some((a) => a.name === 'agent1'));

    db.close();
  });

  it('revoke non-existent agent returns 404', () => {
    const db = withDb();
    const admin = genKeypair();
    seedAdmins(db, [{ name: 'admin', publicKeyBase64: admin.publicKeyBase64 }]);

    const result = revokeAgent(db, 'ghost', 'admin');
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);

    db.close();
  });
});
