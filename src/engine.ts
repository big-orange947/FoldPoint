import { resolveDefaults } from "./defaults";
import { decideFoldPoint } from "./estimator";
import {
  applyCompactionObservation,
  applyRequestObservation,
  applySessionEnd,
  createProfileLearningState,
  createSessionState,
  normalizeProfileLearningState,
  normalizeSessionState,
} from "./learner";
import type {
  CompactionObservation,
  FoldPointDecision,
  FoldPointDefaults,
  FoldPointInput,
  FoldPointOptions,
  FoldPointProfile,
  FoldPointProfileLearningState,
  FoldPointSessionState,
  FoldPointState,
  RequestObservation,
  SessionEndObservation,
} from "./types";

/**
 * Unambiguous state key for a profile: a JSON tuple, so that a `|` inside a field can never
 * collide with another profile.
 */
export function profileKey(profile: FoldPointProfile): string {
  return JSON.stringify([
    profile.provider ?? "",
    profile.model,
    profile.contextWindowTokens,
    profile.compactorId,
    profile.prefixId ?? "",
  ]);
}

/** Unambiguous state key for one session of one profile. */
export function sessionKey(sessionId: string, profile: FoldPointProfile): string {
  return JSON.stringify([profileKey(profile), sessionId]);
}

function assertProfile(profile: FoldPointProfile): void {
  if (profile === null || typeof profile !== "object") {
    throw new RangeError("FoldPoint profile must be an object");
  }
  if (typeof profile.model !== "string" || profile.model.length === 0) {
    throw new RangeError('FoldPoint profile "model" must be a non-empty string');
  }
  if (typeof profile.compactorId !== "string" || profile.compactorId.length === 0) {
    throw new RangeError('FoldPoint profile "compactorId" must be a non-empty string');
  }
  if (
    typeof profile.contextWindowTokens !== "number" ||
    !Number.isFinite(profile.contextWindowTokens) ||
    profile.contextWindowTokens <= 0
  ) {
    throw new RangeError('FoldPoint profile "contextWindowTokens" must be a finite number > 0');
  }
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new RangeError(
      "FoldPoint sessionId must be a non-empty string (a stable, non-sensitive identifier such as a UUID)",
    );
  }
}

/**
 * Stateful convenience wrapper around the pure decision function.
 *
 * - `decide()` is read-only: it never mutates learned state.
 * - Only `observeRequest`, `recordCompaction` and `endSession` update state.
 * - Profile learning state is shared across sessions; session runtime state is not, and is
 *   deleted by `endSession`.
 * - There is no global singleton, no `process.env` access and no persistence: the host owns
 *   durability through `exportState()` / `importState()`.
 */
export class FoldPoint {
  private readonly defaults: FoldPointDefaults;
  private readonly profiles = new Map<string, FoldPointProfileLearningState>();
  private readonly sessions = new Map<string, FoldPointSessionState>();

  constructor(options?: FoldPointOptions) {
    this.defaults = resolveDefaults(options?.defaults);
    if (options?.state !== undefined) {
      this.importState(options.state);
    }
  }

  /** Records one real model request of one session. */
  observeRequest(
    sessionId: string,
    profile: FoldPointProfile,
    observation: RequestObservation,
  ): void {
    const learningKey = this.keyForProfile(profile);
    const runtimeKey = this.keyForSession(sessionId, profile);
    const learning = this.profiles.get(learningKey) ?? createProfileLearningState(this.defaults);
    const session = this.sessions.get(runtimeKey) ?? createSessionState();

    const next = applyRequestObservation(learning, session, observation, this.defaults);
    this.profiles.set(learningKey, next.learning);
    this.sessions.set(runtimeKey, next.session);
  }

  /** Answers the only question FoldPoint answers. Pure with respect to learned state. */
  decide(input: FoldPointInput): FoldPointDecision {
    const learningKey = this.keyForProfile(input.profile);
    const runtimeKey = this.keyForSession(input.sessionId, input.profile);
    const learning = this.profiles.get(learningKey) ?? createProfileLearningState(this.defaults);
    const session = this.sessions.get(runtimeKey) ?? createSessionState();

    return decideFoldPoint(input, learning, session, { defaults: this.defaults });
  }

  /** Records the outcome of a real compaction attempt of one session. */
  recordCompaction(
    sessionId: string,
    profile: FoldPointProfile,
    observation: CompactionObservation,
  ): void {
    const learningKey = this.keyForProfile(profile);
    const runtimeKey = this.keyForSession(sessionId, profile);
    const learning = this.profiles.get(learningKey) ?? createProfileLearningState(this.defaults);
    const session = this.sessions.get(runtimeKey) ?? createSessionState();

    const next = applyCompactionObservation(
      learning,
      session,
      observation,
      this.defaults,
      profile.pricing,
    );
    this.profiles.set(learningKey, next.learning);
    this.sessions.set(runtimeKey, next.session);
  }

  /**
   * Ends a session: the reuse horizon is learned into the profile (when the session
   * compacted successfully at least once) and the session runtime state is discarded.
   * Profile learning state is kept.
   */
  endSession(
    sessionId: string,
    profile: FoldPointProfile,
    observation: SessionEndObservation,
  ): void {
    const learningKey = this.keyForProfile(profile);
    const runtimeKey = this.keyForSession(sessionId, profile);
    const session = this.sessions.get(runtimeKey);
    if (!session) {
      return;
    }

    const learning = this.profiles.get(learningKey) ?? createProfileLearningState(this.defaults);
    this.profiles.set(learningKey, applySessionEnd(learning, session, observation, this.defaults));
    this.sessions.delete(runtimeKey);
  }

  /** Snapshot of every profile's learning state and every live session's runtime state. */
  exportState(): FoldPointState {
    const profiles: Record<string, FoldPointProfileLearningState> = {};
    for (const key of [...this.profiles.keys()].sort()) {
      const learning = this.profiles.get(key);
      if (learning) {
        profiles[key] = { ...learning };
      }
    }

    const sessions: Record<string, FoldPointSessionState> = {};
    for (const key of [...this.sessions.keys()].sort()) {
      const session = this.sessions.get(key);
      if (session) {
        sessions[key] = { ...session };
      }
    }

    return { version: 2, profiles, sessions };
  }

  /**
   * Replaces all state with the provided snapshot. Snapshots from the pre-release state
   * version 1 are rejected explicitly: their absolute `compactionCostEma` and their merged
   * profile/session semantics cannot be reinterpreted safely.
   */
  importState(state: FoldPointState): void {
    if (state === null || typeof state !== "object") {
      throw new RangeError("FoldPoint state must be an object");
    }

    const version: unknown = (state as { version?: unknown }).version;
    if (version === 1) {
      throw new RangeError(
        "Unsupported FoldPoint state version: 1. This pre-release snapshot must be reset before using state version 2.",
      );
    }
    if (version !== 2) {
      throw new RangeError(`Unsupported FoldPoint state version: ${String(version)}.`);
    }

    const profiles = state.profiles ?? {};
    const sessions = state.sessions ?? {};
    if (profiles === null || typeof profiles !== "object") {
      throw new RangeError("FoldPoint state profiles must be an object");
    }
    if (sessions === null || typeof sessions !== "object") {
      throw new RangeError("FoldPoint state sessions must be an object");
    }

    this.profiles.clear();
    for (const [key, raw] of Object.entries(profiles)) {
      this.profiles.set(key, normalizeProfileLearningState(raw, this.defaults));
    }

    this.sessions.clear();
    for (const [key, raw] of Object.entries(sessions)) {
      this.sessions.set(key, normalizeSessionState(raw));
    }
  }

  /** Copy of one profile's learning state; a fresh default state when the profile is unknown. */
  getProfileState(profile: FoldPointProfile): FoldPointProfileLearningState {
    const key = this.keyForProfile(profile);
    const learning = this.profiles.get(key);
    return learning ? { ...learning } : createProfileLearningState(this.defaults);
  }

  /** Copy of one session's runtime state; a fresh default state when the session is unknown. */
  getSessionState(sessionId: string, profile: FoldPointProfile): FoldPointSessionState {
    const key = this.keyForSession(sessionId, profile);
    const session = this.sessions.get(key);
    return session ? { ...session } : createSessionState();
  }

  /** Forgets one profile's learning state. Session runtime state is left untouched. */
  resetProfile(profile: FoldPointProfile): void {
    this.profiles.delete(this.keyForProfile(profile));
  }

  /** Forgets one session's runtime state. Profile learning state is left untouched. */
  resetSession(sessionId: string, profile: FoldPointProfile): void {
    this.sessions.delete(this.keyForSession(sessionId, profile));
  }

  /** The resolved defaults this engine uses. */
  getDefaults(): FoldPointDefaults {
    return { ...this.defaults };
  }

  private keyForProfile(profile: FoldPointProfile): string {
    assertProfile(profile);
    return profileKey(profile);
  }

  private keyForSession(sessionId: string, profile: FoldPointProfile): string {
    assertProfile(profile);
    assertSessionId(sessionId);
    return sessionKey(sessionId, profile);
  }
}
