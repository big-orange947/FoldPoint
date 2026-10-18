/** Bounded counters only. No messages, token-size learner, billing predictor or I/O. */
import type { TraceEvent } from "../../src/index";

export class PiSteadyLifecycle {
  private state = this.empty();
  private lastSeq = -1;

  private empty() {
    return {
      sessionId: null as string | null,
      runtimeId: null as string | null,
      runtimeActive: false,
      completedOrdinaryCalls: 0,
      runtimeUnknownOutcomeRequests: 0,
      ordinaryRequests: 0,
      successfulOrdinaryRequests: 0,
      failedOrdinaryRequests: 0,
      unknownOutcomeRequests: 0,
      outsideRuntimeRequests: 0,
      summaryAttempts: 0,
      successfulSummaries: 0,
      failedSummaries: 0,
      vetoes: 0,
      summariesWithoutUsage: 0,
      estimatedAfterSizes: 0,
      cacheWarmCalls: 0,
      reportedCacheWarmCost: 0,
    };
  }

  startSession(sessionId: string) {
    this.state = { ...this.empty(), sessionId };
    this.lastSeq = -1;
  }

  startRuntime(runtimeId: string) {
    this.state.runtimeId = runtimeId;
    this.state.runtimeActive = true;
    this.state.completedOrdinaryCalls = 0;
    this.state.runtimeUnknownOutcomeRequests = 0;
  }

  /** Missing usage is unknown, not a successful zero-cost call. */
  unknownRequest() {
    this.state.ordinaryRequests++;
    this.state.unknownOutcomeRequests++;
    if (this.state.runtimeActive) this.state.runtimeUnknownOutcomeRequests++;
    else this.state.outsideRuntimeRequests++;
  }

  observe(event: TraceEvent) {
    if (event.type === "header" || event.sessionId !== this.state.sessionId) return;
    // The adapter emits in sequence order. Re-reading a persisted entry must not bill it twice.
    if (event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    const s = this.state;
    if (event.type === "request") {
      s.ordinaryRequests++;
      if (!s.runtimeActive) s.outsideRuntimeRequests++;
      if (event.outcome === "ok") {
        s.successfulOrdinaryRequests++;
        if (s.runtimeActive) s.completedOrdinaryCalls++;
      } else if (event.outcome === undefined) {
        s.unknownOutcomeRequests++;
        if (s.runtimeActive) s.runtimeUnknownOutcomeRequests++;
      } else s.failedOrdinaryRequests++;
    } else if (event.type === "cache_warm") {
      s.cacheWarmCalls++;
      s.reportedCacheWarmCost += event.usage.actualCost;
    } else if (event.type === "compaction") {
      if (event.errorCode === "vetoed") {
        s.vetoes++;
        return;
      }
      s.summaryAttempts++;
      if (event.success) s.successfulSummaries++;
      else s.failedSummaries++;
      if (event.usage === undefined) s.summariesWithoutUsage++;
      if (event.afterTokensSource === "host-estimate") s.estimatedAfterSizes++;
    } else if (
      event.type === "session_end" ||
      (event.type === "runtime_end" && event.runtimeId === s.runtimeId)
    ) {
      s.runtimeActive = false;
    }
  }

  snapshot() {
    return { ...this.state, exactRetentionSamples: 0 as const, canDrivePolicy: false as const };
  }
}

export type PiSteadyLifecycleSnapshot = ReturnType<PiSteadyLifecycle["snapshot"]>;
