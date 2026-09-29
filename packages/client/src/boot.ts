/**
 * Resolve with the promise's value if it settles within `ms`, otherwise with
 * undefined. A rejection also resolves undefined, so boot can go on with its
 * fallbacks either way. DOM-free so it can be tested without a browser.
 */
export function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => { globalThis.clearTimeout(timer); resolve(value); },
      () => { globalThis.clearTimeout(timer); resolve(undefined); },
    );
  });
}
