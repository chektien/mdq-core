# Contrived Sample Quiz 01: Coffee Bot Debug Drill (Synthetic) (3 Questions)

---

## Warmup: Team Rituals

This is a synthetic sample quiz for MDQ onboarding.

**What is the best first step before touching production code?**

A. Push directly to main
B. Read logs and reproduce the issue
C. Delete the failing module
D. Disable tests permanently

> Correct Answer: B. Read logs and reproduce the issue
> Overall Feedback: Reproducing and observing behavior first prevents random fixes and makes debugging faster.

---

## Code Reading: Null Safety Check

time-limit: 40

Look at this TypeScript snippet:

```typescript
type User = { id: string; nickname?: string };

const label = (user: User): string => {
  return user.nickname?.toUpperCase() ?? "ANON";
};
```

**If `nickname` is missing, what does `label(user)` return?**

A. `undefined`
B. `null`
C. `"ANON"`
D. It throws an exception

> Correct Answer: C. "ANON"
> Overall Feedback: Optional chaining returns undefined when nickname is absent, then nullish coalescing falls back to "ANON".

---

## Release Hygiene: Safe Defaults

**Which checklist item is most important right before a small release?**

A. Remove all commit history
B. Skip typecheck to save time
C. Run verification and keep notes short
D. Change every dependency version

> Correct Answer: C. Run verification and keep notes short
> Overall Feedback: Lightweight verification plus clear notes helps catch regressions and keeps handoff readable.

---
