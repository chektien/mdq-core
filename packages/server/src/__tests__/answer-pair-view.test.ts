import path from "path";
import { buildSync } from "esbuild";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import type { AnswerSubmitPayload } from "@mdq/shared";
import type { QuestionState } from "../../../client/src/hooks/useSocket";

// Exercise the real phone submit handlers with controlled draft input.
const root = path.resolve(__dirname, "../../../..");
const bundle = buildSync({
  entryPoints: [path.join(root, "packages/client/src/views/StudentView.tsx")],
  bundle: true, platform: "node", format: "cjs", jsx: "automatic", write: false, packages: "external",
  alias: { "@mdq/shared": path.join(root, "packages/shared/src/index.ts") },
});
const compiled = { exports: {} };
const react = {
  ...require("react"),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => undefined],
  useEffect: () => undefined, useRef: (current: unknown) => ({ current }),
  useMemo: (factory: () => unknown) => factory(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
};
new Function("require", "module", "exports", bundle.outputFiles[0].text)((name: string) => name === "react" ? react : require(name), compiled, compiled.exports);
type Props = {
  question: QuestionState; state: "QUESTION_OPEN"; remainingSec: null; submitted: boolean;
  submittedOptions: string[]; submittedResponseText: null; timedOut: boolean; connected: boolean;
  draft: { selectedOptions: string[]; responseText: string }; onSubmit: (payload: AnswerSubmitPayload) => void;
};
const { QuestionView } = compiled.exports as { QuestionView: (props: Props) => ReactElement };
const submitButton = (node: ReactNode): ReactElement<{ onClick: () => void }> | undefined => {
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return;
  if (node.type === "button" && typeof node.props.children === "string" && node.props.children.startsWith("Submit")) return node as ReactElement<{ onClick: () => void }>;
  return Children.toArray(node.props.children).map(submitButton).find(Boolean);
};

it.each((["multiple_choice", "poll", "open_response"] as const).flatMap(questionType => [undefined, 0, 4].map(contentVersion => ({ questionType, contentVersion }))))(
  "the $questionType phone handler captures displayed version $contentVersion before delivery", ({ questionType, contentVersion }) => {
    const delivered: AnswerSubmitPayload[] = [];
    const question: QuestionState = {
      questionIndex: 2, topic: "Sample", text: "Sample prompt", questionType,
      options: [{ label: "A", text: "Sample option" }], allowsMultiple: false, isPoll: questionType === "poll",
      startedAt: 100, timeLimitSec: null, attempt: 2, ...(contentVersion !== undefined ? { contentVersion } : {}),
    };
    const view = QuestionView({
      question, state: "QUESTION_OPEN", remainingSec: null, submitted: false, submittedOptions: [], submittedResponseText: null,
      timedOut: false, connected: true, draft: { selectedOptions: ["A"], responseText: "Sample response" }, onSubmit: payload => delivered.push(payload),
    });
    const button = submitButton(view);
    expect(button).toBeDefined();
    button!.props.onClick();
    expect(delivered).toEqual([{
      questionIndex: 2, attempt: 2, ...(contentVersion !== undefined ? { contentVersion } : {}),
      ...(questionType === "open_response" ? { responseText: "Sample response" } : { selectedOptions: ["A"] }),
    }]);
  });
