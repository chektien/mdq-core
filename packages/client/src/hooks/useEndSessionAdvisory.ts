import { useEffect, useState } from "react";
import { API, type EndSessionAdvisory } from "@mdq/shared";

/** Refresh live hints only while the confirmation is open. End itself is serialized by the server. */
export function useEndSessionAdvisory(sessionId: string, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; value: EndSessionAdvisory } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    const update = async () => {
      if (inFlight) return;
      inFlight = true; controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), 10_000);
      try {
        const response = await fetch(API.SESSION_END_ADVISORY.replace(":id", encodeURIComponent(sessionId)), { credentials: "same-origin", signal: controller.signal });
        if (response.ok) {
          const value = await response.json() as EndSessionAdvisory;
          if (!cancelled) setSnapshot({ sessionId, value });
        }
      } catch { /* Counts are advisory. An unavailable hint must not prevent End. */ }
      finally { clearTimeout(timer); inFlight = false; }
    };
    void update(); const timer = setInterval(update, 2_000);
    return () => { cancelled = true; controller?.abort(); clearInterval(timer); };
  }, [sessionId, enabled]);
  return snapshot?.sessionId === sessionId ? snapshot.value : null;
}
