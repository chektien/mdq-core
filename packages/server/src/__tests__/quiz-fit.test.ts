import {
  DENSITY_ORDER,
  FIT_GROWTH_TOLERANCE,
  initialFitState,
  stepFit,
  type FitRoom,
  type FitState,
} from "../../../client/src/quizFit";

const room: FitRoom = { width: 800, height: 600 };

/** Runs a measurement per entry and returns the densities after each. */
function run(state: FitState, measurements: Array<{ ratio: number; room?: FitRoom; contentKey?: string }>): { state: FitState; densities: string[] } {
  const densities: string[] = [];
  let current = state;
  for (const measurement of measurements) {
    current = stepFit(current, { ratio: measurement.ratio, room: measurement.room ?? room, contentKey: measurement.contentKey ?? current.contentKey });
    densities.push(current.density);
  }
  return { state: current, densities };
}

describe("quiz fit steps", () => {
  it("steps down one density for each measurement that overflows, and stops at the last", () => {
    const { densities } = run(initialFitState(), [{ ratio: 1.2 }, { ratio: 1.1 }, { ratio: 1.05 }, { ratio: 1.3 }]);
    expect(densities).toEqual(["compact", "tight", "scaled", "scaled"]);
  });

  it("keeps the density while the content fills 78 to 100 percent of the room", () => {
    const { densities } = run(initialFitState(), [{ ratio: 1.2 }, { ratio: 0.78 }, { ratio: 0.9 }, { ratio: 1 }]);
    expect(densities).toEqual(["compact", "compact", "compact", "compact"]);
  });

  it("does not step back up to a density that overflowed in the same room", () => {
    // Compact overflows and tight leaves plenty of room. A fit that stepped up
    // again would overflow again and go on alternating with every measurement.
    const { densities, state } = run(initialFitState(), [{ ratio: 1.15 }, { ratio: 0.6 }, { ratio: 0.6 }, { ratio: 0.6 }, { ratio: 0.6 }]);
    expect(densities).toEqual(["compact", "compact", "compact", "compact", "compact"]);
    const last = run(state, [{ ratio: 1.15 }, { ratio: 0.5 }, { ratio: 0.5 }]);
    expect(last.densities).toEqual(["tight", "tight", "tight"]);
  });

  it("steps up to a density that has not overflowed", () => {
    const tight = run(initialFitState(), [{ ratio: 1.2 }, { ratio: 1.2 }]).state;
    expect(tight.density).toBe("tight");
    // The floor of tight blocks every step up in this room.
    expect(run(tight, [{ ratio: 0.5 }]).densities).toEqual(["tight"]);
    // After a reset the floor is gone and the fit can step up one density at a time.
    const grown = run(tight, [{ ratio: 0.5, room: { ...room, height: room.height + 200 } }, { ratio: 0.5, room: { ...room, height: room.height + 200 } }]);
    expect(grown.densities).toEqual(["compact", "comfortable"]);
  });

  it("settles after trying one density up once the room has grown and it overflows again", () => {
    const tight = run(initialFitState(), [{ ratio: 1.2 }, { ratio: 1.2 }]).state;
    const bigger = { width: room.width, height: room.height + 100 };
    const { densities } = run(tight, [{ ratio: 0.5, room: bigger }, { ratio: 1.1, room: bigger }, { ratio: 0.5, room: bigger }, { ratio: 0.5, room: bigger }]);
    expect(densities).toEqual(["compact", "tight", "tight", "tight"]);
  });

  it("forgets what overflowed when the room grows by more than the tolerance in either direction", () => {
    const tight = run(initialFitState(), [{ ratio: 1.2 }, { ratio: 1.2 }]).state;
    const small = { width: room.width + FIT_GROWTH_TOLERANCE, height: room.height + FIT_GROWTH_TOLERANCE };
    expect(run(tight, [{ ratio: 0.5, room: small }]).densities).toEqual(["tight"]);
    expect(run(tight, [{ ratio: 0.5, room: { ...room, width: room.width + FIT_GROWTH_TOLERANCE + 1 } }]).densities).toEqual(["compact"]);
    expect(run(tight, [{ ratio: 0.5, room: { ...room, height: room.height + FIT_GROWTH_TOLERANCE + 1 } }]).densities).toEqual(["compact"]);
  });

  it("keeps what overflowed when the room shrinks", () => {
    const tight = run(initialFitState(), [{ ratio: 1.2 }, { ratio: 1.2 }]).state;
    const shrunk = { width: room.width - 200, height: room.height - 200 };
    expect(run(tight, [{ ratio: 0.5, room: shrunk }]).densities).toEqual(["tight"]);
    expect(run(tight, [{ ratio: 1.2, room: shrunk }]).densities).toEqual(["scaled"]);
  });

  it("forgets what overflowed when the content changes", () => {
    const tight = run(initialFitState("1:QUESTION_OPEN"), [{ ratio: 1.2 }, { ratio: 1.2 }]).state;
    expect(run(tight, [{ ratio: 0.5 }]).densities).toEqual(["tight"]);
    expect(run(tight, [{ ratio: 0.5, contentKey: "2:QUESTION_OPEN" }]).densities).toEqual(["compact"]);
  });

  it("makes a measurement that repeats change nothing once the fit has settled", () => {
    const settled = run(initialFitState(), [{ ratio: 1.3 }, { ratio: 0.5 }, { ratio: 0.9 }]).state;
    const again = stepFit(settled, { ratio: 0.9, room, contentKey: settled.contentKey });
    expect(again).toEqual(settled);
  });

  it("never alternates for any sequence of ratios in an unchanged room", () => {
    // Whatever the measurements say, the density only moves down the order
    // once it has stepped down, apart from the steps up before the first overflow.
    let seed = 7;
    const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    for (let trial = 0; trial < 200; trial += 1) {
      let state = initialFitState();
      let overflowed = false;
      for (let i = 0; i < 40; i += 1) {
        const before = DENSITY_ORDER.indexOf(state.density);
        state = stepFit(state, { ratio: random() * 1.6, room, contentKey: "same" });
        const after = DENSITY_ORDER.indexOf(state.density);
        if (overflowed) expect(after).toBeGreaterThanOrEqual(before);
        if (after > before) overflowed = true;
      }
    }
  });
});
