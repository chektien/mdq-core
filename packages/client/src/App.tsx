import { useState, useEffect } from "react";
import InstructorView from "./views/InstructorView";
import PresentationView from "./views/PresentationView";
import StudentView from "./views/StudentView";
import InstructorLoginPrompt from "./components/InstructorLoginPrompt";
import { fetchInstructorSessionStatus } from "./hooks/api";
import type { RuntimeClientConfig } from "./hooks/api";
import type { DeckTheme } from "@mdq/shared";
import { applyClientTheme, resolveClientTheme } from "./theme";

const DEFAULT_INSTRUCTOR_ROUTE_SEGMENT = "instructor";

function normalizeRouteSegment(value?: string): string {
  const trimmed = (value || "").trim().replace(/^\/+|\/+$/g, "");
  return trimmed || DEFAULT_INSTRUCTOR_ROUTE_SEGMENT;
}

const INSTRUCTOR_ROUTE_SEGMENT = normalizeRouteSegment(
  (import.meta as { env?: { VITE_INSTRUCTOR_ROUTE_SEGMENT?: string } }).env?.VITE_INSTRUCTOR_ROUTE_SEGMENT,
);
const INSTRUCTOR_HASH_ROUTE = `/${INSTRUCTOR_ROUTE_SEGMENT}`;
const INSTRUCTOR_RESTORE_KEY = "mdquiz_instructor_session";

type AppPage = "home" | "instructor" | "join" | "student" | "presentation";
type AuthContext = "presentation";

interface AppRoute {
  page: AppPage;
  param?: string;
  next?: string;
  authContext?: AuthContext;
}

function sanitizeHashPath(value?: string | null): string | undefined {
  const trimmed = (value || "").trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return undefined;
  return trimmed;
}

function navigateToHashPath(path: string): void {
  window.location.hash = path;
}

function canonicalizePathRoute(path: string): void {
  window.history.replaceState(null, "", `/${window.location.search}#${path}`);
}

function hasStoredInstructorRestore(): boolean {
  try {
    const raw = sessionStorage.getItem(INSTRUCTOR_RESTORE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { sessionId?: unknown };
    return typeof parsed.sessionId === "string" && parsed.sessionId.trim().length > 0;
  } catch {
    return false;
  }
}

function buildInstructorLoginHash(options: { next?: string; authContext?: AuthContext } = {}): string {
  const params = new URLSearchParams();
  const next = sanitizeHashPath(options.next);

  if (next) {
    params.set("next", next);
  }

  if (options.authContext) {
    params.set("context", options.authContext);
  }

  const query = params.toString();
  return `#${INSTRUCTOR_HASH_ROUTE}${query ? `?${query}` : ""}`;
}

/**
 * Simple hash-based routing:
 *   /             -> role picker (instructor or student)
 *   /<segment>    -> instructor session setup + control
 *   /join/:code   -> student join via session code
 *   /s/:sessionId -> student in-session (after join)
 *   /present/:id  -> read-only projector view for an active session
 */
function getRoute(): AppRoute {
  const hash = window.location.hash.replace(/^#/, "");
  const routeSource = hash || `${window.location.pathname}${window.location.search}`;
  const [path, queryString = ""] = routeSource.split("?");
  const params = new URLSearchParams(queryString);
  const shouldCanonicalizePathRoute = !hash && path !== "/";

  if (!hash && path === "/" && hasStoredInstructorRestore()) {
    canonicalizePathRoute(INSTRUCTOR_HASH_ROUTE);
    return { page: "instructor" };
  }

  if (path === INSTRUCTOR_HASH_ROUTE || path === `${INSTRUCTOR_HASH_ROUTE}/`) {
    if (shouldCanonicalizePathRoute) canonicalizePathRoute(INSTRUCTOR_HASH_ROUTE);
    return {
      page: "instructor",
      next: sanitizeHashPath(params.get("next")),
      authContext: params.get("context") === "presentation" ? "presentation" : undefined,
    };
  }
  if (path.startsWith("/join/")) {
    if (shouldCanonicalizePathRoute) canonicalizePathRoute(path);
    return { page: "join", param: path.split("/")[2] };
  }
  if (path.startsWith("/s/")) {
    if (shouldCanonicalizePathRoute) canonicalizePathRoute(path);
    return { page: "student", param: path.split("/")[2] };
  }
  if (path.startsWith("/present/")) {
    if (shouldCanonicalizePathRoute) canonicalizePathRoute(path);
    return { page: "presentation", param: path.split("/")[2] };
  }
  return { page: "home" };
}

export default function App({ runtimeConfig = {} }: { runtimeConfig?: RuntimeClientConfig }) {
  const [route, setRoute] = useState(getRoute);
  const autoGenerateStudentIds = runtimeConfig.autoGenerateStudentIds === true;
  const defaultTheme = resolveClientTheme(runtimeConfig.theme);

  useEffect(() => {
    const onHash = () => setRoute(getRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (route.page === "home") applyClientTheme(defaultTheme);
  }, [defaultTheme, route.page]);

  if (route.page === "instructor") {
    return <InstructorGate returnTo={route.next} authContext={route.authContext} autoGenerateStudentIds={autoGenerateStudentIds} defaultTheme={defaultTheme} />;
  }

  if (route.page === "join") {
    return <StudentView initialSessionCode={route.param} autoGenerateStudentIds={autoGenerateStudentIds} defaultTheme={defaultTheme} />;
  }

  if (route.page === "student") {
    return <StudentView initialSessionId={route.param} autoGenerateStudentIds={autoGenerateStudentIds} defaultTheme={defaultTheme} />;
  }

  if (route.page === "presentation" && route.param) {
    return (
      <PresentationView
        sessionId={route.param}
        loginHref={buildInstructorLoginHash({
          next: `/present/${route.param}`,
          authContext: "presentation",
        })}
        autoGenerateStudentIds={autoGenerateStudentIds}
        defaultTheme={defaultTheme}
      />
    );
  }

  // Home: role picker
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-8 p-6">
      <div className="text-center">
        <h1 className="mb-2 text-4xl font-bold tracking-tight text-white">mdq</h1>
        <p className="mx-auto max-w-3xl text-lg text-zinc-400">
          Meet <span className="font-semibold text-indigo-300">MDQ</span>.
          <span className="font-medium text-zinc-200">
            {" "}Human- and agent-friendly <span className="text-indigo-300">M</span>ark<span className="text-indigo-300">D</span>own Decks &amp; <span className="text-indigo-300">Q</span>uestions.
          </span>
          <br />
          <span className="text-zinc-300">No clunky interfaces. No proprietary nonsense. No database.</span>
          <br />
          <span className="text-zinc-400">Just your own machine and a public secure tunnel (like Tailscale).</span>
          <br />
          <a
            href="https://github.com/chektien/mdq-core"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-1.5 text-zinc-300 transition-colors hover:text-white"
          >
            Open-source
            <svg
              aria-label="GitHub"
              className="h-5 w-5"
              viewBox="0 0 24 24"
              role="img"
              fill="currentColor"
            >
              <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.52 2.87 8.35 6.84 9.71.5.09.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.19-1.11-1.51-1.11-1.51-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.31.1-2.72 0 0 .84-.28 2.75 1.05A9.37 9.37 0 0 1 12 6.94c.85 0 1.7.12 2.5.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.46.1 2.72.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.59.69.49A10.08 10.08 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
            </svg>
          </a>
        </p>
      </div>
      <div className="flex w-full max-w-sm flex-col gap-4 sm:flex-row">
        <a
          href={`#${INSTRUCTOR_HASH_ROUTE}`}
          className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-center py-4 px-6 rounded-xl transition-colors text-lg"
        >
          Instructor
        </a>
        <a
          href="#/join/"
          className="flex-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white font-semibold text-center py-4 px-6 rounded-xl transition-colors text-lg"
        >
          Student
        </a>
      </div>
    </div>
  );
}

function InstructorGate({
  returnTo,
  authContext,
  autoGenerateStudentIds,
  defaultTheme,
}: {
  returnTo?: string;
  authContext?: AuthContext;
  autoGenerateStudentIds: boolean;
  defaultTheme: DeckTheme;
}) {
  const [checking, setChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    applyClientTheme(defaultTheme);
  }, [defaultTheme]);

  useEffect(() => {
    fetchInstructorSessionStatus()
      .then((status) => {
        setAuthenticated(status.authenticated);
      })
      .catch(() => {
        setError("Unable to verify instructor access.");
      })
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!checking && authenticated && returnTo) {
      navigateToHashPath(returnTo);
    }
  }, [authenticated, checking, returnTo]);

  if (checking) {
    return (
      <div className="min-h-dvh flex items-center justify-center p-6 text-zinc-300">
        Checking instructor access...
      </div>
    );
  }

  if (authenticated && returnTo) {
    return (
      <div className="min-h-dvh flex items-center justify-center p-6 text-zinc-300">
        Opening presentation view...
      </div>
    );
  }

  if (authenticated) {
    return <InstructorView autoGenerateStudentIds={autoGenerateStudentIds} defaultTheme={defaultTheme} />;
  }

  const isPresentationLogin = authContext === "presentation";
  const title = isPresentationLogin ? "Instructor Login Required" : "Instructor Login";
  const description = isPresentationLogin
    ? "Presentation mode is protected when the instructor password is enabled. Sign in and you will return to the presenter view."
    : "Enter the instructor password to access session controls.";

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-8 p-6">
      <InstructorLoginPrompt
        title={title}
        description={description}
        submitLabel={isPresentationLogin ? "Sign In to Open Presentation" : "Sign In"}
        onSuccess={() => {
          if (returnTo) {
            navigateToHashPath(returnTo);
            return;
          }
          setAuthenticated(true);
        }}
        backHref="#/"
        backLabel="Back home"
        secondaryHref={`#${INSTRUCTOR_HASH_ROUTE}`}
        secondaryLabel="Instructor controls"
      />
      {error && <p className="text-sm text-red-300">{error}</p>}
    </div>
  );
}
