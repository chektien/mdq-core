import fs from "fs";
import path from "path";
import { clampOpenResponse, countCharacters, sentenceStop } from "../../../client/src/responseText";
import { checkJoinValues, errorField, fieldElementId, joinFormSpec, joinIdentity } from "../../../client/src/joinForm";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const read = (rel: string): string => fs.readFileSync(path.join(clientSrc, rel), "utf-8");

describe("join form fields", () => {
  it("asks for a required Student ID and an optional name by default", () => {
    const spec = joinFormSpec(true, false);
    expect(spec.mode).toBe("id");
    expect(spec.generatedId).toBe(false);
    expect(spec.studentId).toMatchObject({
      label: "Student ID", required: true, maxLength: 64, autoComplete: "off", autoCapitalize: "off", inputMode: "text", enterKeyHint: "next",
    });
    expect(spec.displayName).toMatchObject({
      label: "Name", required: false, maxLength: 60, autoComplete: "name", autoCapitalize: "words", inputMode: "text", enterKeyHint: "go",
    });
  });

  it("asks for a required name only when the deck turns Student IDs off", () => {
    const spec = joinFormSpec(false, false);
    expect(spec.mode).toBe("name");
    expect(spec.studentId).toBeUndefined();
    expect(spec.generatedId).toBe(false);
    expect(spec.displayName).toMatchObject({ label: "Name", required: true, maxLength: 60 });
  });

  it("keeps autoGenerateStudentIds as before: no ID field, a required name, and a generated ID", () => {
    const spec = joinFormSpec(true, true);
    expect(spec.studentId).toBeUndefined();
    expect(spec.generatedId).toBe(true);
    expect(spec.displayName.required).toBe(true);
  });

  it("lets a name-only deck win over autoGenerateStudentIds, so no ID is generated", () => {
    const spec = joinFormSpec(false, true);
    expect(spec.mode).toBe("name");
    expect(spec.generatedId).toBe(false);
    expect(spec.studentId).toBeUndefined();
    expect(spec.displayName.required).toBe(true);
  });

  it("checks what was typed before joining", () => {
    const ids = joinFormSpec(true, false);
    expect(checkJoinValues(ids, { studentId: "  ", displayName: "Alex" })).toEqual({ field: "studentId", message: "Enter your Student ID to join." });
    expect(checkJoinValues(ids, { studentId: "x".repeat(65), displayName: "" })?.field).toBe("studentId");
    expect(checkJoinValues(ids, { studentId: "S0001", displayName: "" })).toBeNull();
    expect(checkJoinValues(ids, { studentId: "S0001", displayName: "n".repeat(61) })?.field).toBe("displayName");
    const names = joinFormSpec(false, false);
    expect(checkJoinValues(names, { studentId: "", displayName: "  \t " })).toEqual({ field: "displayName", message: "Enter your name to join." });
    expect(checkJoinValues(names, { studentId: "", displayName: "Alex" })).toBeNull();
    expect(checkJoinValues(joinFormSpec(true, true), { studentId: "", displayName: "" })?.field).toBe("displayName");
  });

  it("sends the right identity for each form", () => {
    const generated = () => "auto-123";
    expect(joinIdentity(joinFormSpec(true, false), { studentId: " S0001 ", displayName: "  Alex   Tan " }, generated))
      .toEqual({ studentId: "S0001", displayName: "Alex Tan", seatKey: "S0001" });
    expect(joinIdentity(joinFormSpec(true, false), { studentId: "S0001", displayName: " " }, generated).displayName).toBeUndefined();
    expect(joinIdentity(joinFormSpec(true, true), { studentId: "", displayName: "Alex" }, generated))
      .toEqual({ studentId: "auto-123", displayName: "Alex", seatKey: "auto-123" });
    const nameOnly = joinIdentity(joinFormSpec(false, true), { studentId: "left-over", displayName: " alex  tan " }, () => { throw new Error("no ID is generated"); });
    expect(nameOnly).toEqual({ displayName: "alex tan", seatKey: "alex tan" });
    expect("studentId" in nameOnly).toBe(false);
  });

  it("points a refusal at the field it is about", () => {
    const ids = joinFormSpec(true, false);
    const names = joinFormSpec(false, false);
    expect(errorField(ids, 'The Student ID "S1" is already in this session on another device. Use that device, or check that you typed your own ID.')).toBe("studentId");
    expect(errorField(names, 'Someone here is already using the name "Alex Tan". Add an initial or your surname, for example "Alex Tan B."')).toBe("displayName");
    expect(errorField(ids, "Session has ended")).toBe("code");
    expect(errorField(ids, "Connection failed: xhr poll error")).toBeNull();
    expect(fieldElementId(ids, "studentId")).toBe("join-student-id");
    expect(fieldElementId(names, "studentId")).toBe("join-display-name");
    expect(fieldElementId(ids, "code")).toBe("join-session-code");
  });
});

describe("join form in the student view", () => {
  const view = read("views/StudentView.tsx");

  it("shows fields only once the deck's setting is known, from the code lookup", () => {
    expect(view).toContain("data.studentIds !== false");
    expect(view).toContain('const fieldsReady = codeLookup.status === "found"');
    expect(view).toContain("{fieldsReady && spec.studentId && (");
    expect(view).toContain("disabled={joining || !fieldsReady}");
  });

  it("marks fields required, with the input hints from the spec, inside a form", () => {
    expect(view).toContain("noValidate");
    expect(view).toContain("required: f.required");
    for (const hint of ["autoComplete: f.autoComplete", "autoCapitalize: f.autoCapitalize", "inputMode: f.inputMode", "maxLength: f.maxLength", "enterKeyHint: f.enterKeyHint"]) {
      expect(view).toContain(hint);
    }
    expect(view).toContain('type="submit"');
  });

  it("shows every message inline in an alert next to the form, and ties it to the field", () => {
    expect(view).toContain('id="join-error"');
    expect(view).toContain('role="alert"');
    expect(view).toContain('"aria-describedby": invalid(field) ? "join-error" : undefined');
    expect(view.indexOf('id="join-error"')).toBeGreaterThan(view.indexOf("<form"));
    expect(view.indexOf('id="join-error"')).toBeLessThan(view.indexOf("</form>"));
  });

  it("tells the participant their public label and why it differs on the waiting screen", () => {
    expect(view).toContain("sock.label");
    expect(view).toContain("sock.labelNote");
    expect(view).toContain("highlightPublicKey={sock.publicKey ?? undefined}");
  });

  it("does not put Student IDs on the projector", () => {
    const presentation = read("views/PresentationView.tsx");
    expect(presentation).not.toMatch(/showStudentIds=\{(?!false)/);
    expect(presentation).not.toContain("studentId");
  });
});

describe("response text helpers on the phone", () => {
  it("puts a full stop after a name unless it already ends in punctuation", () => {
    expect(sentenceStop("Alex Tan")).toBe(".");
    expect(sentenceStop("Alex Tan B.")).toBe("");
    expect(sentenceStop("Alex (2)")).toBe(".");
    expect(`You are in as Alex Tan B${sentenceStop("Alex Tan B.")}`).not.toContain("..");
  });

  it("counts an emoji as one character and clamps without splitting it", () => {
    const emoji = "\u{1F600}";
    expect(countCharacters(emoji.repeat(3))).toBe(3);
    expect(countCharacters("é字")).toBe(2);
    expect(countCharacters(clampOpenResponse(emoji.repeat(1200)))).toBe(1000);
    expect(clampOpenResponse(emoji.repeat(1200))).toBe(emoji.repeat(1000));
    expect(clampOpenResponse("short")).toBe("short");
  });
});
