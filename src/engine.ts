import { resolveDefaults } from "./defaults";
import { decideFoldPoint } from "./estimator";
import {
  applyCompactionObservation,
  applyRequestObservation,
  applySessionEnd,
  createProfileState,
  normalizeProfileState,
} from "./learner";
import type {
  CompactionObservation,
  FoldPointDecision,
  FoldPointDefaults,
  FoldPointInput,
  FoldPointOptions,
  FoldPointProfile,
  FoldPointProfileState,
  FoldPointState,
  RequestObservation,
  SessionEndObservation,
} from "./types";

/**
 * Stable state key for a profile: provider + model + context window + compactor.
 * Compaction quality differs per compactor, so state is never shared across compactors.
 */
export function profileKey(profile: FoldPointProfile): string {
  return [
    profile.provider ?? "",
    profile.model,
    String(profile.contextWindowTokens),
    profile.compactorId,
  ].join("|");
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

/**
 * Stateful convenience wrapper around the pure decision function.
 *
 * - `decide()` is read-only: it never mutates learned state.
 * - Only `observeRequest`, `recordCompaction` and `endSession` update state.
 * - There is no global singleton, no `process.env` access and no persistence: the host
 *   owns durability through `exportState()` / `importState()`.
 */
export class FoldPoint {
  private readonly defaults: FoldPointDefaults;
  private readonly states = new Map<string, FoldPointProfileState>();

  constructor(options?: FoldPointOptions) {
    this.defaults = resolveDefaults(options?.defaults);
    if (options?.state !== undefined) {
      this.importState(options.state);
    }
  }

  /** Records one real model request. */
  observeRequest(profile: FoldPointProfile, observation: RequestObservation): void {
    const key = this.keyFor(profile);
    const current = this.states.get(key) ?? createProfileState(this.defaults);
    this.states.set(key, applyRequestObservation(current, observation, this.defaults));
  }

  /** Answers the only question FoldPoint answers. Pure with respect to learned state. */
  decide(input: FoldPointInput): FoldPointDecision {
    const key = this.keyFor(input.profile);
    const state = this.states.get(key) ?? createProfileState(this.defaults);
    return decideFoldPoint(input, state, { defaults: this.defaults });
  }

  /** Records the outcome of a real compaction attempt. */
  recordCompaction(profile: FoldPointProfile, observation: CompactionObservation): void {
    const key = this.keyFor(profile);
    const current = this.states.get(key) ?? createProfileState(this.defaults);
    this.states.set(
      key,
      applyCompactionObservation(current, observation, this.defaults, profile.pricing),
    );
  }

  /** Records the end of a session, so the reuse horizon can be learned. */
  endSession(profile: FoldPointProfile, observation: SessionEndObservation): void {
    const key = this.keyFor(profile);
    const current = this.states.get(key);
    if (!current) {
      return;
    }
    this.states.set(key, applySessionEnd(current, observation, this.defaults));
  }

  /** Snapshot of every profile's learned state. JSON-serializable, content-free. */
  exportState(): FoldPointState {
    const profiles: Record<string, FoldPointProfileState> = {};
    for (const key of [...this.states.keys()].sort()) {
      const state = this.states.get(key);
      if (state) {
        profiles[key] = { ...state };
      }
    }
    return { version: 1, profiles };
  }

  /** Replaces all learned state with the provided snapshot. */
  importState(state: FoldPointState): void {
    if (state === null || typeof state !== "object") {
      throw new RangeError("FoldPoint state must be an object");
    }
    if (state.version !== undefined && state.version !== 1) {
      throw new RangeError(`Unsupported FoldPoint state version: ${String(state.version)}`);
    }

    const profiles = state.profiles ?? {};
    if (profiles === null || typeof profiles !== "object") {
      throw new RangeError("FoldPoint state profiles must be an object");
    }

    this.states.clear();
    for (const [key, raw] of Object.entries(profiles)) {
      this.states.set(key, normalizeProfileState(raw, this.defaults));
    }
  }

  /** Copy of one profile's state; a fresh default state when the profile is unknown. */
  getProfileState(profile: FoldPointProfile): FoldPointProfileState {
    const key = this.keyFor(profile);
    const state = this.states.get(key);
    return state ? { ...state } : createProfileState(this.defaults);
  }

  /** Forgets one profile's learned state. */
  resetProfile(profile: FoldPointProfile): void {
    this.states.delete(this.keyFor(profile));
  }

  /** The resolved defaults this engine uses. */
  getDefaults(): FoldPointDefaults {
    return { ...this.defaults };
  }

  private keyFor(profile: FoldPointProfile): string {
    assertProfile(profile);
    return profileKey(profile);
  }
}
