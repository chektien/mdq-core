/**
 * Whether this browser shows Student IDs on the instructor's console. IDs are
 * hidden by default, so a mirrored screen never shows them by accident; the
 * choice is remembered per browser. Names and labels always show.
 */
const KEY = "mdq_show_student_ids";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const browserStorage = (): StorageLike | undefined => {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    return undefined;
  }
};

export function readShowStudentIds(storage: StorageLike | undefined = browserStorage()): boolean {
  try {
    return storage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShowStudentIds(show: boolean, storage: StorageLike | undefined = browserStorage()): void {
  try {
    if (show) storage?.setItem(KEY, "1");
    else storage?.removeItem(KEY);
  } catch {
    // The choice just is not remembered.
  }
}
