/**
 * Durable comm type for receiver-terminal ingress. Keeping this outside the
 * generic spawn kind prevents lifecycle semantics from depending on prompt
 * text for newly-created rows.
 */
export const RECEIVER_TERMINAL_COMM_KIND = "receiver_terminal" as const;

// Fixed metadata prefix emitted by the ingress bridge before this durable kind
// was introduced. It contains only protocol/digest metadata, never the raw
// carrier. Keep the legacy match narrow so an ordinary spawn prompt cannot be
// mistaken for a receiver-terminal comm.
export const RECEIVER_TERMINAL_LEGACY_PROMPT_PREFIX =
  '{"protocol":"supermatrix-immutable-ingress/v1","completion_mode":"receiver_terminal","client_request_id_sha256":"';

const SHA256_WIDTH = 64;
const SHA256_GLOB = "[0-9a-f]".repeat(SHA256_WIDTH);
const PROMPT_SHA256_FIELD = '","prompt_sha256":"';
const ARTIFACT_ID_FIELD = '","artifact_id":"sm-immutable-ingress-v1:';
const DECLARATION_SHA256_FIELD = '","declaration_sha256":"';
const RECEIVER_TERMINAL_LEGACY_PROMPT_GLOB =
  `${RECEIVER_TERMINAL_LEGACY_PROMPT_PREFIX}${SHA256_GLOB}` +
  `${PROMPT_SHA256_FIELD}${SHA256_GLOB}` +
  `${ARTIFACT_ID_FIELD}${SHA256_GLOB}` +
  `${DECLARATION_SHA256_FIELD}${SHA256_GLOB}"}`;
const PROMPT_SHA256_SQL_START =
  RECEIVER_TERMINAL_LEGACY_PROMPT_PREFIX.length + SHA256_WIDTH + PROMPT_SHA256_FIELD.length + 1;
const ARTIFACT_SHA256_SQL_START =
  PROMPT_SHA256_SQL_START + SHA256_WIDTH + ARTIFACT_ID_FIELD.length;

/** SQL predicate for the durable receiver-terminal lifecycle fence. */
export function receiverTerminalCommSqlPredicate(alias = "c"): string {
  return `(${alias}.kind = '${RECEIVER_TERMINAL_COMM_KIND}' OR (` +
    `${alias}.kind = 'spawn' ` +
    `AND ${alias}.prompt GLOB '${RECEIVER_TERMINAL_LEGACY_PROMPT_GLOB}' ` +
    `AND substr(${alias}.prompt, ${PROMPT_SHA256_SQL_START}, ${SHA256_WIDTH}) = ` +
    `substr(${alias}.prompt, ${ARTIFACT_SHA256_SQL_START}, ${SHA256_WIDTH})` +
    "))";
}
