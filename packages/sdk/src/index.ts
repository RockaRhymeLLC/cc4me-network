/**
 * CC4Me Network SDK — P2P encrypted messaging for AI agents.
 *
 * @example
 * ```typescript
 * import { CC4MeNetwork } from 'cc4me-network';
 *
 * const network = new CC4MeNetwork({
 *   relayUrl: 'https://relay.bmobot.ai',
 *   username: 'my-agent',
 *   privateKey: myEd25519PrivateKey,
 *   endpoint: 'https://my-agent.example.com/network/inbox',
 * });
 *
 * await network.start();
 * await network.send('friend', { text: 'Hello!' });
 * ```
 *
 * @packageDocumentation
 */

export { CC4MeNetwork } from './client.js';
export type {
  CC4MeNetworkOptions,
  SendResult,
  Message,
  ContactRequest,
  Broadcast,
  DeliveryStatus,
  PresenceInfo,
  DeliveryReport,
} from './types.js';
