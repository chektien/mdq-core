import { createServer } from "http";
import { createApp } from "./app";
import {
  setupSocket,
  broadcastQuestionOpen,
  broadcastReveal,
  broadcastLeaderboard,
  clearSessionTimers,
} from "./socket";
import { DEFAULT_PORT, Quiz, Session, SessionState, SocketEvents } from "@mdq/shared";
import { detectAccessInfo } from "./access-info";
import { getDistribution } from "./session";
import * as path from "path";
import * as fs from "fs";
import express from "express";
import type { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { loadRuntimeConfig } from "./config";
import { isInstructorAuthEnabled } from "./instructor-auth";

const runtimeConfig = loadRuntimeConfig();
const requestedPort = runtimeConfig.port || DEFAULT_PORT;
const bindHost = runtimeConfig.bindHost || undefined;
const maxPortFallbacks = runtimeConfig.portFallbacks;
const instanceId = runtimeConfig.instanceId || randomUUID();
const dataDir = path.resolve(__dirname, "../../../data");
const quizDir = runtimeConfig.quizDir || path.resolve(__dirname, "../../../data/decks");
const clientDist = path.join(__dirname, "../../client/dist");
const tailscaleDisabled = ["1", "true", "yes", "on"].includes(
  (process.env.MDQ_DISABLE_TAILSCALE || "").trim().toLowerCase(),
);

// We need io available for the state change callback, so we use a container
// that's populated after setupSocket. The callback won't fire before the server starts.
const ioRef: { current: ReturnType<typeof setupSocket> | null } = { current: null };

interface FunnelReadinessResult {
  ready: boolean;
  reason: string;
  details: string[];
}

interface PublicHealthCheckResult {
  ok: boolean;
  instanceId: string;
  error: string;
}

function inspectFunnelReadiness(publicUrl: string, boundPort: number): FunnelReadinessResult {
  try {
    const raw = execSync("tailscale funnel status --json", {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const statusText = String(raw);
    const host = (() => {
      try {
        return new URL(publicUrl).hostname;
      } catch {
        return "";
      }
    })();

    const hasPortMatch = statusText.includes(`:${boundPort}`) || statusText.includes(`"port":${boundPort}`);
    const hasHostMatch = host ? statusText.includes(host) : false;

    if (!hasPortMatch) {
      return {
        ready: false,
        reason: "wrong-port",
        details: [
          `funnel does not appear to publish bound port ${boundPort}`,
          `run: tailscale funnel ${boundPort}`,
          "run: tailscale funnel status",
        ],
      };
    }

    if (!hasHostMatch) {
      return {
        ready: false,
        reason: "host-mismatch",
        details: [
          `funnel status does not include expected host for ${publicUrl}`,
          "run: tailscale funnel status",
          "verify tailscale status host and Funnel host are aligned",
        ],
      };
    }

    return {
      ready: true,
      reason: "ok",
      details: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return {
      ready: false,
      reason: "status-unavailable",
      details: [
        `unable to read tailscale funnel status: ${message}`,
        "run: tailscale funnel status",
      ],
    };
  }
}

function logReadinessResult(params: {
  title: string;
  status: string;
  url: string;
  details?: string[];
  nextSteps?: string[];
}): void {
  console.log("");
  console.log(`mdq readiness result: ${params.title}`);
  console.log(`  Status: ${params.status}`);
  console.log(`  URL: ${params.url}`);
  for (const detail of params.details || []) {
    console.log(`  Detail: ${detail}`);
  }
  for (const nextStep of params.nextSteps || []) {
    console.log(`  Next: ${nextStep}`);
  }
}

async function checkPublicHealth(publicUrl: string): Promise<PublicHealthCheckResult> {
  const healthUrl = `${publicUrl}/api/health`;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    const payloadUnknown = await response.json().catch(() => ({}));
    const payload =
      payloadUnknown && typeof payloadUnknown === "object"
        ? (payloadUnknown as { instanceId?: unknown })
        : {};
    const publicInstanceId = typeof payload.instanceId === "string" ? payload.instanceId : "";

    if (!response.ok || !publicInstanceId) {
      return {
        ok: false,
        instanceId: publicInstanceId,
        error: `unexpected health response from ${healthUrl}`,
      };
    }

    return {
      ok: true,
      instanceId: publicInstanceId,
      error: "",
    };
  } catch (error) {
    return {
      ok: false,
      instanceId: "",
      error: error instanceof Error ? error.message : "unknown",
    };
  }
}

function sessionRoom(sessionId: string): string {
  return `session:${sessionId}`;
}

if (runtimeConfig.presenterNotes && !(process.env.INSTRUCTOR_PASSWORD || process.env.INSTRUCTOR_KEY)) {
  console.warn(
    "[mdq] presenterNotes is enabled but no instructor password is configured " +
    "(INSTRUCTOR_PASSWORD/INSTRUCTOR_KEY). Presenter notes will NOT be served " +
    "until instructor auth is configured, to keep them instructor-only.",
  );
}

const app = createApp({
  quizDir,
  dataDir,
  instanceId,
  theme: runtimeConfig.theme,
  palette: runtimeConfig.palette,
  autoGenerateStudentIds: runtimeConfig.autoGenerateStudentIds,
  presenterNotes: runtimeConfig.presenterNotes,
  presenterNotesDefaultOpen: runtimeConfig.presenterNotesDefaultOpen,
  onStateChange: (session: Session, sessionId: string, newState: SessionState, quiz?: Quiz) => {
    const io = ioRef.current;
    if (!io) return;

    // Any REST-driven state/navigation change invalidates the previous item timer.
    clearSessionTimers(sessionId);

    switch (newState) {
      case "QUESTION_OPEN":
        if (quiz) {
          broadcastQuestionOpen(io, session, sessionId, quiz);
        }
        break;

      case "QUESTION_CLOSED": {
        clearSessionTimers(sessionId);
        io.to(sessionRoom(sessionId)).emit(SocketEvents.QUESTION_CLOSE, {
          questionIndex: session.currentQuestionIndex,
        });
        io.to(sessionRoom(sessionId)).emit(SocketEvents.SESSION_STATE, {
          state: session.state,
          questionIndex: session.currentQuestionIndex,
        });
        // Send distribution
        const dist = getDistribution(session, session.currentQuestionIndex);
        io.to(sessionRoom(sessionId)).emit(SocketEvents.RESULTS_DISTRIBUTION, {
          questionIndex: session.currentQuestionIndex,
          distribution: dist,
        });
        break;
      }

      case "REVEAL":
        if (quiz) {
          broadcastReveal(io, session, sessionId, quiz);
        }
        break;

      case "LEADERBOARD":
        if (quiz) {
          broadcastLeaderboard(io, session, sessionId, quiz);
        }
        break;

      case "ENDED":
        io.to(sessionRoom(sessionId)).emit(SocketEvents.SESSION_STATE, {
          state: "ENDED",
        });
        break;
    }
  },
});

const httpServer = createServer(app);

// Access the quiz store from the app for socket setup
const quizzes = (app as unknown as { _quizzes: Map<string, Quiz> })._quizzes;
ioRef.current = setupSocket(httpServer, quizzes);

// ── Student join redirect ──
// QR scanners often strip hash fragments from URLs, so we support a clean
// path /join/:code that redirects to the hash-based client route /#/join/:code.
app.get("/join/:code", (req: express.Request, res: express.Response) => {
  res.redirect(`/#/join/${req.params.code}`);
});

// ── Serve client static files in production ──
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // SPA fallback: serve index.html for any non-API route
  app.get("*", (req: express.Request, res: express.Response) => {
    if (!req.path.startsWith("/api") && !req.path.startsWith("/socket.io")) {
      res.sendFile(path.join(clientDist, "index.html"));
    }
  });
}

async function onListening(): Promise<void> {
  const address = httpServer.address();
  const boundPort = typeof address === "object" && address ? (address as AddressInfo).port : requestedPort;
  const usedFallbackPort = boundPort !== requestedPort;

  console.log(`mdq server listening on port ${boundPort} (instance ${instanceId})`);
  if (bindHost) {
    console.log(`Bind host: ${bindHost}`);
  }
  console.log(
    `Runtime config: ${runtimeConfig.loadedFromFile ? runtimeConfig.configPath : "defaults only (data/config.json not found)"}`,
  );
  if (usedFallbackPort) {
    console.log(`Requested port ${requestedPort} unavailable, using fallback port ${boundPort}`);
  }
  console.log(`Port fallback retry limit: ${maxPortFallbacks}`);
  console.log(`Instructor password: ${isInstructorAuthEnabled() ? "configured" : "not configured"}`);
  console.log(`Data directory: ${dataDir}`);
  console.log(`Deck directory: ${quizDir}`);

  // Detect access info (Tailscale/LAN) on startup
  try {
    const info = await detectAccessInfo(boundPort);
    let tailscaleHealthVerified = false;
    console.log(`Access URL: ${info.fullUrl} (source: ${info.source})`);
    if (info.shortUrl) {
      console.log(`Short URL: ${info.shortUrl}`);
    }
    if (info.warning) {
      console.warn(`Warning: ${info.warning}`);
    }

    if (info.source === "public-override") {
      logReadinessResult({
        title: "using the configured public URL",
        status: "MDQ will use the URL you configured.",
        url: info.fullUrl,
        details: [`Local server port: ${boundPort}`],
      });
    } else if (info.source === "tailscale") {
      const readiness = inspectFunnelReadiness(info.fullUrl, boundPort);
      if (!readiness.ready) {
        logReadinessResult({
          title: "Tailscale is available, but Funnel needs attention",
          status: "The server is running, but the public classroom URL may not reach this MDQ instance yet.",
          url: info.fullUrl,
          details: [`Local server port: ${boundPort}`, `Check result: ${readiness.reason}`],
          nextSteps: readiness.details,
        });
      }
    } else {
      if (tailscaleDisabled) {
        logReadinessResult({
          title: "local test mode",
          status: "MDQ is running locally. Tailscale checks are off for this run.",
          url: info.fullUrl,
          details: [
            `Local server port: ${boundPort}`,
            "Good for checking the UI, projector flow, and mock students on this machine.",
          ],
          nextSteps: ["Use npm run try -- --publish when you want to test a public classroom link."],
        });
      } else {
        logReadinessResult({
          title: "Tailscale Funnel is not available",
          status: "MDQ is running on your local network, but this is probably not a reliable public classroom link.",
          url: info.fullUrl,
          details: [`Local server port: ${boundPort}`],
          nextSteps: [
            "Sign in to Tailscale or check that Tailscale is running.",
            `To publish this port later, run: tailscale funnel ${boundPort}`,
          ],
        });
      }
    }

    if (info.source === "tailscale") {
      const healthUrl = `${info.fullUrl}/api/health`;
      const health = await checkPublicHealth(info.fullUrl);

      if (!health.ok) {
        logReadinessResult({
          title: "Tailscale URL could not be checked",
          status: "The server is running, but MDQ could not confirm the public classroom URL.",
          url: info.fullUrl,
          details: [`Health check URL: ${healthUrl}`, `Health check failed: ${health.error}`],
          nextSteps: ["Check your network, then run: tailscale funnel status"],
        });
      } else if (health.instanceId !== instanceId) {
        logReadinessResult({
          title: "Tailscale URL points to another MDQ server",
          status: "The public URL is not connected to this server process.",
          url: info.fullUrl,
          details: [
            `Public instance: ${health.instanceId}`,
            `This instance: ${instanceId}`,
          ],
          nextSteps: ["Stop the old process on the published port, then restart MDQ."],
        });
      } else {
        tailscaleHealthVerified = true;
        logReadinessResult({
          title: "Tailscale Funnel is ready",
          status: "The public URL reaches this MDQ server.",
          url: info.fullUrl,
          details: [`Local server port: ${boundPort}`],
        });
      }
    }

    if (usedFallbackPort && info.source === "tailscale") {
      const healthUrl = `${info.fullUrl}/api/health`;
      if (tailscaleHealthVerified) {
        console.log(`Verified public host routes to this instance (${instanceId}) after fallback.`);
      } else {
        const health = await checkPublicHealth(info.fullUrl);
        if (!health.ok) {
          logReadinessResult({
            title: "stopped to avoid opening the wrong classroom link",
            status: "MDQ had to move to a fallback port, but the public URL did not prove that it reaches this server.",
            url: info.fullUrl,
            details: [
              `Requested port: ${requestedPort}`,
              `Actual server port: ${boundPort}`,
              `Health check URL: ${healthUrl}`,
              `Health check failed: ${health.error}`,
            ],
            nextSteps: [
              `Stop the process using port ${requestedPort}, then run npm run try again.`,
              "For local testing only, run: npm run try -- --local-only",
            ],
          });
          httpServer.close(() => {
            process.exit(1);
          });
          return;
        }

        if (health.instanceId !== instanceId) {
          logReadinessResult({
            title: "stopped because the public URL points to another MDQ server",
            status: "The fallback server started, but the classroom URL is connected to a different running MDQ instance.",
            url: info.fullUrl,
            details: [
              `Requested port: ${requestedPort}`,
              `Actual server port: ${boundPort}`,
              `Public instance: ${health.instanceId}`,
              `This instance: ${instanceId}`,
            ],
            nextSteps: [
              "Stop the old MDQ server on the published port, then run npm run try again.",
              "For local testing only, run: npm run try -- --local-only",
            ],
          });
          httpServer.close(() => {
            process.exit(1);
          });
          return;
        }

        console.log(`Verified public host routes to this instance (${instanceId}) after fallback.`);
      }
    }
  } catch (e) {
    console.error("Failed to detect access info:", e);
  }
}

function startWithPortFallback(portToTry: number, fallbackCount: number): void {
  const handleListening = (): void => {
    httpServer.off("error", handleError);
    void onListening();
  };

  const handleError = (error: NodeJS.ErrnoException): void => {
    httpServer.off("listening", handleListening);

    if (error.code === "EADDRINUSE" && fallbackCount < maxPortFallbacks) {
      const nextPort = portToTry + 1;
      console.warn(
        `Port ${portToTry} is already in use, retrying on port ${nextPort} (${fallbackCount + 1}/${maxPortFallbacks})`
      );
      startWithPortFallback(nextPort, fallbackCount + 1);
      return;
    }

    console.error(`Failed to start mdq server on port ${portToTry}:`, error);
    process.exitCode = 1;
  };

  httpServer.once("listening", handleListening);
  httpServer.once("error", handleError);
  if (bindHost) {
    httpServer.listen(portToTry, bindHost);
  } else {
    httpServer.listen(portToTry);
  }
}

startWithPortFallback(requestedPort, 0);
