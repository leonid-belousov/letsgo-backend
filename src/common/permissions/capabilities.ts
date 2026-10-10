/**
 * Server-computed allowed actions attached to API resources (Handoff §20).
 * Clients render UI from these flags and never derive rights from role names.
 * Every flag is decided by the backend permission engine
 * (actor → action → scope → expiry → delegation → version/capacity).
 */
export interface Capabilities {
  canFollow?: boolean;
  canMessage?: boolean;
  canJoin?: boolean;
  canApprove?: boolean;
  canConfirmCash?: boolean;
}

export type WithCapabilities<T> = T & { capabilities: Capabilities };
