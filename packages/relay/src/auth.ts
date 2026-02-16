/**
 * Request authentication middleware.
 *
 * Verifies Ed25519 signatures on incoming requests.
 * Format: Authorization: Signature <agent_name>:<base64_signature>
 * Signature over: <METHOD> <PATH>\n<ISO-8601 timestamp>\n<body_sha256_hex>
 */

// TODO: implement
