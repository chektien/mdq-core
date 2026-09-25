import { parseQuizMarkdown, QuizParseError } from "../parser";
import { DEFAULT_TIME_LIMIT_SEC } from "@mdq/shared";
import * as fs from "fs";
import * as path from "path";

describe("parseQuizMarkdown", () => {
  describe("basic parsing", () => {
    it("parses a single-select question with default time limit", () => {
      const md = `# Test Quiz (1 Question)

---

## Topic: Subtopic

**What is 2 + 2?**

A. 3
B. 4
C. 5
D. 6

> Correct Answer: B. 4
> Overall Feedback: Basic arithmetic.

---
`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      expect(result.quiz).not.toBeNull();
      const q = result.quiz!;
      expect(q.week).toBe("week01");
      expect(q.title).toBe("Test Quiz (1 Question)");
      expect(q.questions).toHaveLength(1);

      const question = q.questions[0];
      expect(question.topic).toBe("Topic");
      expect(question.subtopic).toBe("Subtopic");
      expect(question.options).toHaveLength(4);
      expect(question.correctOptions).toEqual(["B"]);
      expect(question.allowsMultiple).toBe(false);
      expect(question.explanation).toBe("Basic arithmetic.");
      expect(question.timeLimitSec).toBe(DEFAULT_TIME_LIMIT_SEC);
    });

    it("parses time_limit field", () => {
      const md = `# Quiz

---

## Topic

time_limit: 45

**Question?**

A. Yes
B. No

> Correct Answer: A
> Overall Feedback: Explanation.

---
`;
      const result = parseQuizMarkdown(md, "week03.md");
      expect(result.errors).toHaveLength(0);
      expect(result.quiz!.questions[0].timeLimitSec).toBe(45);
    });

    it("parses multiline overall feedback blockquotes until the next metadata block", () => {
      const md = `# Quiz

---

## Topic

**Question?**

A. Yes
B. No

> Correct Answer: A
> Overall Feedback: First line.
>
> **Learning Objective:** Explain the idea.
>
> **Gap:** Keep this in the explanation.
> Presenter Note:
> - Do not include this in feedback.

---
`;
      const result = parseQuizMarkdown(md, "week03.md");
      expect(result.errors).toHaveLength(0);
      expect(result.quiz!.questions[0].explanation).toBe(
        "First line.\n\n**Learning Objective:** Explain the idea.\n\n**Gap:** Keep this in the explanation.",
      );
    });

    it("defaults time_limit to 35 when not specified", () => {
      const md = `# Quiz

---

## Topic

**Question?**

A. Yes
B. No

> Correct Answer: A
> Overall Feedback: Explanation.

---
`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.quiz!.questions[0].timeLimitSec).toBe(35);
    });

    it("parses multi-select questions", () => {
      const md = `# Quiz

---

## Multi Select

**Select all that apply.**

A. First
B. Second
C. Third
D. Fourth

> Correct Answers: A, C
> Overall Feedback: A and C are correct.

---
`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      const q = result.quiz!.questions[0];
      expect(q.correctOptions).toEqual(["A", "C"]);
      expect(q.allowsMultiple).toBe(true);
    });

    it("supports explicit multi_select for single-answer questions", () => {
      const md = `# Quiz

---

## Multi Select Mode

multi_select: true

**Pick any options you think fit.**

A. First
B. Second
C. Third

> Correct Answer: B
> Overall Feedback: Only B is graded as correct.

---
`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      expect(result.quiz!.questions[0].allowsMultiple).toBe(true);
    });

    it("parses poll questions without correct answers", () => {
      const md = `# Quiz

---

## Live Poll

question_type: poll

**How are you feeling about the topic?**

A. Great
B. Okay
C. Lost

> Overall Feedback: Thanks for the signal.

---
`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      const q = result.quiz!.questions[0];
      expect(q.isPoll).toBe(true);
      expect(q.correctOptions).toEqual([]);
      expect(q.allowsMultiple).toBe(false);
    });

    it("supports multi-select poll questions", () => {
      const md = `# Quiz

---

## Live Poll

question_type: poll
multi_select: true

**Which topics need more revision?**

A. Testing
B. Networking
C. Git

> Overall Feedback: Thanks for the signal.

---
`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      const q = result.quiz!.questions[0];
      expect(q.isPoll).toBe(true);
      expect(q.allowsMultiple).toBe(true);
      expect(q.correctOptions).toEqual([]);
    });

    it("parses open_response questions without answer options", () => {
      const md = `# Quiz

---

## Reflection

question_type: open_response
time_limit: 50

**What was the hardest concept in today&apos;s lecture?**

> Overall Feedback: Thanks for the feedback.

---
`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      const q = result.quiz!.questions[0];
      expect(q.questionType).toBe("open_response");
      expect(q.options).toEqual([]);
      expect(q.correctOptions).toEqual([]);
      expect(q.allowsMultiple).toBe(false);
      expect(q.timeLimitSec).toBe(50);
      expect(q.explanation).toBe("Thanks for the feedback.");
    });

    it("parses slide items with attendee and presenter foldout notes", () => {
      const md = `# Quiz

---

## Retrieval Practice

type: slide

- Start with a low-stakes recall prompt.
  > Presenter Note: Ask students to answer silently first.
  > Keep the pause short.
  > Attendee Note: Retrieval before explanation is the key idea.

> Attendee Note: This section sets up the quiz that follows.

---`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      const q = result.quiz!.questions[0];
      expect(q.questionType).toBe("slide");
      expect(q.options).toEqual([]);
      expect(q.correctOptions).toEqual([]);
      expect(q.allowsMultiple).toBe(false);
      expect(q.timeLimitSec).toBe(0);
      expect(q.textMd).toContain("Start with a low-stakes recall prompt.");
      expect(q.textMd).not.toContain("Presenter Note");
      expect(q.attendeeNotes).toHaveLength(2);
      expect(q.presenterNotes).toHaveLength(1);
      expect(q.presenterNotes?.[0].bodyMd).toContain("Keep the pause short.");
    });

    it("extracts slide images into structured media", () => {
      const md = `# Quiz

---

## Visual Comparison

type: slide

- Compare the headset views.
- Look for overlap and field of view differences.

![Left frustum](../images/frustum-left.png "Left eye")
![Right frustum](../images/frustum-right.png "Right eye")

---`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      const q = result.quiz!.questions[0];
      expect(q.questionType).toBe("slide");
      expect(q.textMd).toContain("Compare the headset views.");
      expect(q.textMd).not.toContain("frustum-left.png");
      expect(q.textHtml).not.toContain("quiz-embedded-image");
      expect(q.slideMedia).toEqual([
        {
          src: "/data/images/frustum-left.png",
          alt: "Left frustum",
          title: "Left eye",
        },
        {
          src: "/data/images/frustum-right.png",
          alt: "Right frustum",
          title: "Right eye",
        },
      ]);
    });

    it("extracts live slide embed metadata without rendering it as body text", () => {
      const md = `# Quiz

---

## Live Demo

type: slide
live_url: https://example.com/demo
live_title_overlay: true
live_interactive: true

Use the live artifact as the slide.

> Attendee Note: Example Author. 2026. Demo System. In *Example Proceedings*. https://doi.org/10.1145/example

---`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      const q = result.quiz!.questions[0];
      expect(q.slideLiveEmbed).toEqual({
        url: "https://example.com/demo",
        titleOverlay: true,
        interactive: true,
      });
      expect(q.textMd).toBe("Use the live artifact as the slide.");
      expect(q.textHtml).not.toContain("live_url");
      expect(q.slideMedia).toBeUndefined();
      expect(q.attendeeNotes?.[0].bodyMd).toContain("Demo System");
    });

    it("resolves local slide videos through the private data media route", () => {
      const md = `# Quiz

---

## Local Demo

type: slide
video_card: ../videos/demo.mp4
video_thumbnail: ../images/demo-poster.png

Open the native player.

---`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      expect(result.quiz!.questions[0].slideVideo).toEqual({
        embedUrl: "/data/videos/demo.mp4",
        thumbnail: "/data/images/demo-poster.png",
      });
    });

    it("extracts slide references into footer-ready inline html", () => {
      const md = `# Quiz

---

## Paper Trail

type: slide

Use the result as visual context.

> Reference: [Milgram and Kishino, 1994](https://doi.org/10.1000/example)
> Image Source: [System schematic](https://example.com/system.png)

---`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      const q = result.quiz!.questions[0];
      expect(q.textMd).toBe("Use the result as visual context.");
      expect(q.textHtml).not.toContain("Reference:");
      expect(q.slideReferences).toHaveLength(2);
      expect(q.slideReferences?.[0].html).toContain('<a href="https://doi.org/10.1000/example"');
      expect(q.slideReferences?.[1].textMd).toContain("System schematic");
    });

    it("uses full week key from variant filenames", () => {
      const md = `# Quiz

---

## Topic

**Question?**

A. Yes
B. No

> Correct Answer: A
> Overall Feedback: Explanation.

---
`;
      const result = parseQuizMarkdown(md, "week03-lab.md");
      expect(result.errors).toHaveLength(0);
      expect(result.quiz!.week).toBe("week03-lab");
    });

    it("uses non-week deck keys from filenames", () => {
      const md = `# Quiz

---

## Topic

**Question?**

A. Yes
B. No

> Correct Answer: A
> Overall Feedback: Explanation.

---
`;
      const result = parseQuizMarkdown(md, "featured-demo.md");
      expect(result.errors).toHaveLength(0);
      expect(result.quiz!.week).toBe("featured-demo");
    });

    it("uses a preamble title when the deck has no H1", () => {
      const md = `title: "Featured Demo Session"

---

## Opening Slide

type: slide

Welcome to the session.

---`;
      const result = parseQuizMarkdown(md, "featured-demo.md");
      expect(result.errors).toHaveLength(0);
      expect(result.quiz!.title).toBe("Featured Demo Session");
      expect(result.quiz!.week).toBe("featured-demo");
      expect(result.quiz!.questions).toHaveLength(1);
    });

    it("parses code blocks in question text", () => {
      const md = `# Quiz

---

## Code

Consider:

\`\`\`typescript
const x = 42;
\`\`\`

**What is x?**

A. 42
B. undefined

> Correct Answer: A
> Overall Feedback: x is 42.

---
`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      const q = result.quiz!.questions[0];
      expect(q.textHtml).toContain("code");
      expect(q.textHtml).toContain("const x = 42;");
      expect(q.textMd).toContain("const x = 42;");
    });

    it("rewrites quiz image paths into the public data images route", () => {
      const md = `# Quiz

---

## Visual Prompt

![](../images/xr-setup.png)

**Which device is shown?**

A. Tablet
B. Router

> Correct Answer: A
> Overall Feedback: The image shows the capture tablet.

---
`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      const q = result.quiz!.questions[0];
      expect(q.textHtml).toContain('src="/data/images/xr-setup.png"');
      expect(q.textHtml).toContain('class="quiz-embedded-image"');
    });

    it("rewrites image paths inside answer options too", () => {
      const md = `# Quiz

---

## Visual Options

**Choose the correct device.**

A. ![Correct](../images/devices/tablet.png)
B. ![Incorrect](../images/devices/router.png)

> Correct Answer: A
> Overall Feedback: The tablet is the capture device.

---
`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      const q = result.quiz!.questions[0];
      expect(q.options[0].textHtml).toContain('src="/data/images/devices/tablet.png"');
      expect(q.options[1].textHtml).toContain('src="/data/images/devices/router.png"');
    });

    it("parses multiple questions from one file", () => {
      const md = `# Quiz (2 Questions)

---

## Q1

**First?**

A. Yes
B. No

> Correct Answer: A
> Overall Feedback: Yes.

---

## Q2

time_limit: 10

**Second?**

A. Alpha
B. Beta

> Correct Answer: B
> Overall Feedback: Beta.

---
`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      expect(result.quiz!.questions).toHaveLength(2);
      expect(result.quiz!.questions[0].timeLimitSec).toBe(35);
      expect(result.quiz!.questions[1].timeLimitSec).toBe(10);
    });
  });

  describe("stops at Learning Objectives", () => {
    it("stops parsing at ## Learning Objectives", () => {
      const md = `# Quiz

---

## Q1

**Question?**

A. Yes
B. No

> Correct Answer: A
> Overall Feedback: Yes.

---

## Learning Objectives

- Objective 1
- Objective 2
`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.quiz!.questions).toHaveLength(1);
    });
  });

  describe("validation errors", () => {
    it("rejects correct answers on open_response questions", () => {
      const md = `# Quiz

---

## Reflection

question_type: open_response

Share one takeaway.

> Correct Answer: A

---
`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.quiz).toBeNull();
      expect(result.errors[0]).toBeInstanceOf(QuizParseError);
      expect(result.errors[0].message).toContain("open-response questions must not define correct answers");
    });

    it("rejects multi_select on open_response questions", () => {
      const md = `# Quiz

---

## Reflection

question_type: open_response
multi_select: true

Share one takeaway.

---
`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.quiz).toBeNull();
      expect(result.errors[0].message).toContain("open-response questions must not use multi-select");
    });

    it("rejects answer options on slide items", () => {
      const md = `# Quiz

---

## Invalid Slide

type: slide

Slide text.

A. This should not be here

---`;
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.quiz).toBeNull();
      expect(result.errors[0].message).toContain("slide items must not define answer options");
    });

    it("reports missing correct answer", () => {
      const md = `# Quiz

---

## Topic

**Question?**

A. Yes
B. No

> Overall Feedback: Some feedback.

---
`;
      const result = parseQuizMarkdown(md, "test.md");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBeInstanceOf(QuizParseError);
      expect(result.errors[0].detail).toContain("Missing correct answer");
    });

    it("rejects poll questions that declare correct answers", () => {
      const md = `# Quiz

---

## Invalid Poll

question_type: poll

**How are you feeling?**

A. Great
B. Unsure

> Correct Answer: A

---
`;
      const result = parseQuizMarkdown(md, "test.md");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBeInstanceOf(QuizParseError);
      expect(result.errors[0].detail).toContain("must not define correct answers");
    });

    it("rejects multi-answer syntax on a singular correct-answer line", () => {
      const md = `# Quiz

---

## Invalid Config

multi_select: true

**Select all that apply.**

A. First
B. Second
C. Third

> Correct Answer: A, C
> Overall Feedback: A and C are correct.

---
`;
      const result = parseQuizMarkdown(md, "test.md");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].detail).toContain("Correct Answers");
    });

    it("rejects multi_select false when multiple correct answers are declared", () => {
      const md = `# Quiz

---

## Invalid Config

multi_select: false

**Select all that apply.**

A. First
B. Second
C. Third

> Correct Answers: A, C
> Overall Feedback: A and C are correct.

---
`;
      const result = parseQuizMarkdown(md, "test.md");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].detail).toContain("multi-select: false");
    });

    it("reports missing options", () => {
      const md = `# Quiz

---

## Topic

**Question with no options?**

> Correct Answer: A
> Overall Feedback: Oops.

---
`;
      const result = parseQuizMarkdown(md, "test.md");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].detail).toContain("No answer options");
      expect(result.errors[0].lineNumber).toBe(6);
      expect(result.errors[0].message).toContain("test.md:6");
    });

    it("reports correct answer referencing non-existent option", () => {
      const md = `# Quiz

---

## Topic

**Question?**

A. Yes
B. No

> Correct Answer: C
> Overall Feedback: C does not exist.

---
`;
      const result = parseQuizMarkdown(md, "test.md");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].detail).toContain('does not match any option label');
    });

    it("handles unterminated code block gracefully", () => {
      const md = `# Quiz

---

## Topic

\`\`\`python
def foo():
    pass

**No closing fence -- question text continues**

A. Yes
B. No

> Correct Answer: A
> Overall Feedback: Code block never closed.

---
`;
      // Should not crash -- parser may treat everything as code or produce an error,
      // but must not throw an unhandled exception
      const result = parseQuizMarkdown(md, "test.md");
      // The parser might produce a valid quiz or an error, but it must not crash
      expect(result).toBeDefined();
      expect(result.errors).toBeDefined();
    });

    it("handles empty question text with options", () => {
      const md = `# Quiz

---

## Topic

A. Yes
B. No

> Correct Answer: A
> Overall Feedback: Just options, no question text.

---
`;
      const result = parseQuizMarkdown(md, "test.md");
      expect(result.errors).toHaveLength(0);
      expect(result.quiz!.questions[0].textMd).toBe("");
    });

    it("reports no questions found in empty file", () => {
      const md = `# Just a title with no questions`;
      const result = parseQuizMarkdown(md, "empty.md");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].detail).toContain("No questions found");
      expect(result.quiz).toBeNull();
    });

    it("returns a partial parse result while preserving line-aware errors", () => {
      const md = `# Quiz

---

## Good Question

**What?**

A. Yes
B. No

> Correct Answer: A
> Overall Feedback: Fine.

---

## Bad Question

**No options here.**

> Correct Answer: A
> Overall Feedback: Oops.

---
`;
      const result = parseQuizMarkdown(md, "test.md");
      expect(result.quiz!.questions).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].lineNumber).toBe(18);
    });
  });

  describe("sample deck files", () => {
    const quizDir = path.join(__dirname, "fixtures/quizzes");

    it("parses week01.md", () => {
      const md = fs.readFileSync(path.join(quizDir, "week01.md"), "utf-8");
      const result = parseQuizMarkdown(md, "week01.md");
      expect(result.errors).toHaveLength(0);
      expect(result.quiz!.questions).toHaveLength(3);
      expect(result.quiz!.questions[0].timeLimitSec).toBe(30);
      expect(result.quiz!.questions[1].timeLimitSec).toBe(35); // default
      expect(result.quiz!.questions[2].timeLimitSec).toBe(45);
      expect(result.quiz!.questions[2].correctOptions).toEqual(["A", "B", "D"]);
      expect(result.quiz!.questions[2].allowsMultiple).toBe(true);
    });

    it("parses week02.md", () => {
      const md = fs.readFileSync(path.join(quizDir, "week02.md"), "utf-8");
      const result = parseQuizMarkdown(md, "week02.md");
      expect(result.errors).toHaveLength(0);
      expect(result.quiz!.questions).toHaveLength(2);
      expect(result.quiz!.questions[1].timeLimitSec).toBe(25);
    });
  });
});
