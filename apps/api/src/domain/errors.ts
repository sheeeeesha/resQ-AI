/** Domain errors. Distinguished by class so callers can branch without string matching. */

export class IncidentNotFound extends Error {
  constructor(public readonly incidentId: string) {
    super(`Incident ${incidentId} not found`);
    this.name = "IncidentNotFound";
  }
}

/**
 * Raised when a write asserts a version the row no longer holds.
 *
 * Surfaced rather than retried automatically. On an active call two people
 * editing the same incident is a real coordination problem, and silently
 * applying the later write would discard whatever the first person decided —
 * the console needs to show the conflict, not resolve it by coin toss.
 */
export class ConcurrencyConflict extends Error {
  constructor(
    public readonly incidentId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `Incident ${incidentId} was modified by someone else ` +
        `(expected version ${expectedVersion}, found ${actualVersion})`,
    );
    this.name = "ConcurrencyConflict";
  }
}

/**
 * Raised when a mutation would change an incident without recording why.
 *
 * This is a programming error, not a runtime condition. It exists so the
 * "every mutation is audited" guarantee is enforced by the code path itself
 * rather than by reviewer vigilance — a new mutator that forgets its audit
 * event fails the first time it runs.
 */
export class UnauditedMutation extends Error {
  constructor(incidentId: string) {
    super(
      `Refusing to mutate incident ${incidentId} without an audit event. ` +
        `Every repository mutation must return at least one.`,
    );
    this.name = "UnauditedMutation";
  }
}

/** Raised when a field name is not one of the reviewable incident fields. */
export class UnknownField extends Error {
  constructor(field: string) {
    super(`"${field}" is not a reviewable incident field`);
    this.name = "UnknownField";
  }
}

/**
 * A location candidate index that does not exist on this incident.
 *
 * Distinct from `UnknownField` because the causes and the fixes differ: a bad
 * field name is a client bug, while a stale candidate index is usually a
 * console acting on a location list that has since been re-resolved. The
 * operator needs to re-read the candidates, not correct their request.
 */
export class UnknownLocationCandidate extends Error {
  constructor(
    public readonly index: number,
    public readonly available: number,
  ) {
    super(
      available === 0
        ? `This incident has no location candidates to select from`
        : `Candidate ${index} does not exist; this incident has ${available}`,
    );
    this.name = "UnknownLocationCandidate";
  }
}
