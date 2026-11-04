import path from "path";
import { buildSync } from "esbuild";

// Execute the real hooks with deterministic state, effects and I/O. No browser or live socket is needed.
export function hookHarness() {
  let cursor = 0, dirty = true;
  const slots: unknown[] = [], effects: (() => void)[] = [];
  const same = (a: unknown[] | undefined, b: unknown[] | undefined) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const memo = <T>(factory: () => T, deps: unknown[]) => {
    const index = cursor++, previous = slots[index] as { deps: unknown[]; value: T } | undefined;
    if (!previous || !same(previous.deps, deps)) slots[index] = { deps, value: factory() };
    return (slots[index] as { value: T }).value;
  };
  const react = {
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [slots[index], (update: T | ((previous: T) => T)) => {
        const next = typeof update === "function" ? (update as (previous: T) => T)(slots[index] as T) : update;
        if (!Object.is(slots[index], next)) { slots[index] = next; dirty = true; }
      }];
    },
    useRef<T>(initial: T) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useMemo: memo,
    useCallback<T>(callback: T, deps: unknown[]) { return memo(() => callback, deps); },
    useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const index = cursor++, previous = slots[index] as { deps?: unknown[]; cleanup?: () => void } | undefined;
      if (!previous || !same(previous.deps, deps)) {
        const record = { deps, cleanup: previous?.cleanup };
        slots[index] = record;
        effects.push(() => { record.cleanup?.(); record.cleanup = effect() || undefined; });
      }
    },
  };
  const handlers = new Map<string, (data?: unknown) => void>();
  const sent: { event: string; payload: unknown }[] = [];
  const socket = {
    connected: false,
    on(event: string, handler: (data?: unknown) => void) { handlers.set(event, handler); },
    emit(event: string, payload: unknown) { sent.push({ event, payload }); },
    connect() { socket.connected = true; handlers.get("connect")?.(); },
    disconnect() { socket.connected = false; handlers.get("disconnect")?.(); },
  };
  const root = path.resolve(__dirname, "../../../..");
  const bundle = buildSync({
    stdin: { contents: 'export { useSocket } from "./packages/client/src/hooks/useSocket"; export { useParticipantStudy } from "./packages/client/src/hooks/useParticipantStudy";', resolveDir: root },
    bundle: true, platform: "node", format: "cjs", write: false, packages: "external",
    alias: { "@mdq/shared": path.join(root, "packages/shared/src/index.ts") },
  });
  const compiled = { exports: {} };
  new Function("require", "module", "exports", "window", bundle.outputFiles[0].text)((name: string) => name === "react" ? react : name === "socket.io-client" ? { io: () => socket } : require(name), compiled, compiled.exports, { addEventListener() {}, removeEventListener() {} });
  const hooks = compiled.exports as Pick<typeof import("../../../client/src/hooks/useSocket"), "useSocket"> & Pick<typeof import("../../../client/src/hooks/useParticipantStudy"), "useParticipantStudy">;
  return {
    ...hooks, sent,
    receive(event: string, payload?: unknown) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`No handler for ${event}`);
      handler(payload);
    },
    render<T>(run: () => T): T {
      let value: T, passes = 0;
      do {
        if (++passes > 50) throw new Error("Hook render did not settle");
        dirty = false; cursor = 0; value = run();
        for (const effect of effects.splice(0)) effect();
      } while (dirty);
      return value;
    },
    unmount() {
      for (const slot of slots) (slot as { cleanup?: () => void } | undefined)?.cleanup?.();
    },
  };
}
