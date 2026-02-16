/**
 * v1 compatibility routes — deprecated, removed after 30-day migration.
 *
 * POST /relay/send               — DEPRECATED: v1 store-and-forward send
 * GET  /relay/inbox/:agent       — DEPRECATED: v1 inbox poll
 * POST /relay/inbox/:agent/ack   — DEPRECATED: v1 message acknowledge
 *
 * Returns Deprecation: true header. After migration: 410 Gone.
 */

// TODO: implement
