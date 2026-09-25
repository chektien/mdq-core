# Week 00 Quiz: Localhost Smoke Test (5 Questions + 6 Slides)

---

## Smoke Test Overview

type: slide

- Confirm that the instructor, student, and projector surfaces are connected.
  > Attendee Note: This slide is a public smoke-test example for fold-out notes.
  > Presenter Note: Keep this slide brief, then advance into the first live question.

- Use the quiz questions to verify answer submission, polling, open responses, and images.

---

## System Check: Session Basics

time-limit: 20

You are testing the quiz platform before class.

**Which screen should the instructor use to create a new live session?**

A. Student join page
B. Instructor page
C. Leaderboard page
D. Browser developer tools

> Correct Answer: B. Instructor page
> Overall Feedback: The instructor page is where you select a quiz and create a session code for students to join.

---

## System Check: Student Join

time-limit: 25
multi-select: true

A student opens the join link and enters their student ID.

**Which details should confirm the join flow is working before the first question opens?**

A. The student sees a waiting state until the instructor starts the quiz
B. The session code stays visible on the join form
C. The student is sent directly to the leaderboard
D. The student can see their student ID and optional display name were accepted

> Correct Answers: A, D
> Overall Feedback: A valid join keeps the student in the lobby until the instructor starts, and the accepted student identity should carry into the live session.

---

## System Check: Readiness Pulse

time-limit: 20
question-type: poll

The instructor wants a quick pulse check before the final smoke-test step.

**Which mdq view are you currently looking at during this test run?**

A. Instructor controls
B. Student question screen
C. Projected presentation view
D. I am between screens right now

> Overall Feedback: This poll confirms which surface each tester is validating, without changing the score.

---

## System Check: Open Response

time-limit: 25
question-type: open-response

The instructor wants to confirm that written replies are working before the final smoke-test step.

**In one sentence, describe what a student should see after submitting an open response while the question is still open.**

> Overall Feedback: After submitting, the student should see that the response was accepted, remains unscored, and can still be updated while the question is open.

---

## System Check: Image Attachment

time-limit: 25

![](../images/week00-smoke-diagram.svg)

**According to the sample setup diagram, which device is serving the live mdq session?**

A. Student phone
B. Instructor laptop
C. Classroom projector
D. Campus Wi-Fi router

> Correct Answer: B. Instructor laptop
> Overall Feedback: The diagram shows the instructor laptop hosting mdq, while the phone joins as a student client and the projector mirrors the instructor screen.

---

## Visual Smoke: Image Left

type: slide

![Smoke diagram left](../images/week00-smoke-diagram.svg -left)

- The diagram should sit on the left.
- This slide checks the `-left` media suffix.

---

## Visual Smoke: Image Right

type: slide

![Smoke diagram right](../images/week00-smoke-diagram.svg -right)

- The diagram should sit on the right.
- This slide checks the `-right` media suffix.

---

## Visual Smoke: Image Top

type: slide

![Smoke diagram top](../images/week00-smoke-diagram.svg -top)

- The diagram should sit above the text.
- This slide checks the `-top` media suffix.

---

## Visual Smoke: Image Bottom

type: slide

![Smoke diagram bottom](../images/week00-smoke-diagram.svg -bottom)

- The diagram should sit below the text.
- This slide checks the `-bottom` media suffix.

---

## Visual Smoke: Image Background

type: slide

![Smoke diagram background](../images/week00-smoke-diagram.svg -background:0.22)

- The diagram should appear as a muted background.
- This slide checks the `-background` media suffix with explicit opacity.

---
