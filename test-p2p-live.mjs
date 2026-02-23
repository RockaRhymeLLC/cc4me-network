#!/usr/bin/env node
/**
 * Live P2P test — sends an E2E encrypted message to R2 via the KithKit A2A Network SDK.
 * Bypasses LAN entirely to test the full relay-mediated P2P path.
 *
 * Usage: node test-p2p-live.mjs [direct|group]
 */

import { A2ANetwork } from './packages/sdk/dist/index.js';
import { execSync } from 'node:child_process';

const mode = process.argv[2] || 'direct';
const RELAY_URL = 'https://relay.bmobot.ai';
const ENDPOINT = 'https://bmo.bmobot.ai/agent/p2p';
const PEER = 'r2d2';

// Load private key from Keychain
const keyBase64 = execSync(
  'security find-generic-password -s credential-a2a-agent-key -w',
  { encoding: 'utf-8' }
).trim();
const privateKey = Buffer.from(keyBase64, 'base64');

const network = new A2ANetwork({
  relayUrl: RELAY_URL,
  username: 'bmo',
  privateKey,
  endpoint: ENDPOINT,
  dataDir: '/tmp/a2a-p2p-test',
  heartbeatInterval: 0, // no heartbeat for test
});

async function testDirect() {
  console.log('=== P2P Direct Message Test ===');
  console.log(`Sending E2E encrypted message to ${PEER}...`);

  await network.start();

  const result = await network.send(PEER, {
    type: 'text',
    text: `P2P TEST from BMO @ ${new Date().toISOString()} — E2E encrypted via KithKit A2A Network SDK. If you can read this, Phase 1 P2P is working!`,
    from: 'bmo',
    timestamp: new Date().toISOString(),
  });

  console.log('Result:', JSON.stringify(result, null, 2));

  if (result.status === 'delivered') {
    console.log(`✅ DELIVERED in ${result.latencyMs || '?'}ms`);
  } else if (result.status === 'queued') {
    console.log(`📦 QUEUED (peer offline, will retry)`);
  } else {
    console.log(`❌ FAILED: ${result.error}`);
  }

  await network.stop();
}

async function testGroup() {
  console.log('=== P2P Group Messaging Test ===');

  await network.start();

  // Step 1: Create a group
  console.log('\n1. Creating test group...');
  let group;
  try {
    group = await network.createGroup('e2e-test-group', {
      membersCanInvite: false,
      membersCanSend: true,
      maxMembers: 10,
    });
    console.log(`   ✅ Group created: ${group.groupId} (${group.name})`);
  } catch (err) {
    console.log(`   ❌ Create failed: ${err.message}`);
    await network.stop();
    return;
  }

  // Step 2: Invite R2
  console.log(`\n2. Inviting ${PEER} to group...`);
  try {
    await network.inviteToGroup(group.groupId, PEER, 'E2E test — accept this invite!');
    console.log(`   ✅ Invitation sent to ${PEER}`);
  } catch (err) {
    console.log(`   ❌ Invite failed: ${err.message}`);
  }

  // Step 3: List groups
  console.log('\n3. Listing my groups...');
  try {
    const rawGroups = await network.relayAPI.listGroups();
    console.log(`   Raw listGroups: ok=${rawGroups.ok} count=${rawGroups.data?.length || 0} error=${rawGroups.error || 'none'}`);
    const groups = await network.getGroups();
    console.log(`   ✅ ${groups.length} group(s):`);
    for (const g of groups) {
      console.log(`      - ${g.name} (${g.groupId}) — ${g.memberCount || '?'} members`);
    }
  } catch (err) {
    console.log(`   ❌ List failed: ${err.message}`);
  }

  // Step 4: Get members
  console.log('\n4. Listing group members...');
  console.log(`   Querying groupId: ${group.groupId}`);
  try {
    const rawResult = await network.relayAPI.getGroupMembers(group.groupId);
    console.log(`   Raw result: ${JSON.stringify(rawResult)}`);
    const members = await network.getGroupMembers(group.groupId);
    console.log(`   ✅ ${members.length} member(s):`);
    for (const m of members) {
      console.log(`      - ${m.agent} (${m.role}, ${m.status})`);
    }
  } catch (err) {
    console.log(`   ❌ Members failed: ${err.message}`);
  }

  // Step 5: Send group message (will only go to active members)
  console.log('\n5. Sending group message...');
  try {
    const result = await network.sendToGroup(group.groupId, {
      text: `GROUP TEST from BMO @ ${new Date().toISOString()} — E2E encrypted fan-out via Phase 2!`,
    });
    console.log(`   ✅ Result: delivered=${result.delivered?.length || 0}, queued=${result.queued?.length || 0}, failed=${result.failed?.length || 0}`);
    if (result.delivered?.length) console.log(`      Delivered to: ${result.delivered.join(', ')}`);
    if (result.queued?.length) console.log(`      Queued for: ${result.queued.join(', ')}`);
  } catch (err) {
    console.log(`   ❌ Send failed: ${err.message}`);
  }

  console.log('\n=== Test Complete ===');
  await network.stop();
}

if (mode === 'group') {
  testGroup().catch(console.error);
} else {
  testDirect().catch(console.error);
}
