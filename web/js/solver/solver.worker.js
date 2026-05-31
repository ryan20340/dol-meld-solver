import { solveLegalityOnly } from "./engine.js";

function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

self.onmessage = (event) => {
  const payload = event.data ?? {};
  if (payload?.type !== "solve") {
    return;
  }

  const requestId = payload.requestId ?? null;
  const startedAtMs = nowMs();

  try {
    const solveOutput = solveLegalityOnly(payload?.solveInput ?? {}, {
      onProgress: (progress) => {
        self.postMessage({
          type: "solve_progress",
          requestId,
          progress,
        });
      },
    });
    self.postMessage({
      type: "solve_result",
      requestId,
      status: "ok",
      elapsedMs: Math.max(0, Math.round(nowMs() - startedAtMs)),
      solveOutput,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    self.postMessage({
      type: "solve_result",
      requestId,
      status: "error",
      elapsedMs: Math.max(0, Math.round(nowMs() - startedAtMs)),
      message,
    });
  }
};
