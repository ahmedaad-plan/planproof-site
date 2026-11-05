---
title: "What does NCEMA 7000:2021 require for exercising and testing?"
searchTitle: "NCEMA 7000:2021 exercising and testing requirements"
description: "What NCEMA 7000:2021 clause 8.6 requires for exercising and testing: the five design elements, when to exercise, and the evidence auditors ask for."
slug: ncema-7000-2021-exercising-and-testing-requirements
date: 2026-10-25
updated: 2026-10-25
order: 1
topic: NCEMA 7000
shortAnswer: "NCEMA 7000:2021 requires a planned exercise and test process with realistic scenarios, clear objectives, defined success criteria and a post-exercise report with recommendations, run at planned intervals and after any significant change. It does not name a type of exercise and it does not set a fixed frequency — those decisions are left to you, and you need to be able to justify them."
related:
  - iso-22301-exercise-programme
  - tabletop-exercise-or-simulation-what-auditors-expect
  - annual-business-continuity-exercise-checklist
---

Most of the questions we get about NCEMA 7000:2021 come down to one worry: "Are we doing enough exercising to pass?" It is a fair question, and the honest answer is that the standard is shorter on this subject than people expect. Clause 8.6 is short. What it asks for is specific, though, and it is worth knowing exactly where the line is, because a lot of time gets spent on things the standard never asked for.

## Who this applies to

AE/SCNS/NCEMA 7000:2021 is the third edition of the UAE's national business continuity standard, issued by the National Emergency Crisis and Disasters Management Authority. It is written as a "shall" specification and it applies to UAE entities, government and private. NCEMA monitors how it is implemented. If you are an ISO 22301 organization you are most of the way there already: the standard says its requirements are consistent with ISO 22301:2019, although the clause numbers are different (the equivalent ISO clause is 8.5, Exercise programme) and the vocabulary is its own.

## The five things the exercise process must include

Clause 8.6.1 covers the design of exercises and tests. It says the process must include:

1. **Appropriate and realistic scenarios.** Not a generic fire drill borrowed from another company. A scenario that could actually happen to your organization, in your location, with your dependencies.
2. **Clearly defined objectives, and an assessment of how far they were achieved.** This is the one most often missed. An exercise without objectives produces a pleasant afternoon and no evidence.
3. **The involvement needed from external providers.** If your recovery depends on a data-centre provider, a cash-in-transit company or a district-cooling operator, the standard expects you to have thought about whether they need to be in the room, or at least on the other end of a phone.
4. **Identification of outcomes, including post-exercise reports, and recommendations for improvement.** The report is not optional. It is the output the standard names, and it defines one as "documented information summarizing exercise outcomes" (2.41).
5. **Criteria for measuring the success of tests and exercises, and the adequacy of your strategies.** In other words, you decide beforehand what "good" looks like, then you measure against it.

Read those five again and notice what is not there. No required duration. No required number of participants. No required format.

## When exercises must happen

Clause 8.6.2 is even shorter. Exercises and tests are performed at planned intervals and when there are significant changes in the organization or its context, and they must not adversely affect normal business operations.

"Planned intervals" means you set the interval and write it down. "Significant change" is the part that catches organizations out. A new site, a new core system, a restructure, a change of a critical supplier, or a real event that showed the plan did not fit — each of these is a trigger to exercise again, regardless of where you are in the annual cycle. When the UAE recorded its heaviest rain in 75 years in April 2024, with main roads closed for days, many plans that quietly assumed people could reach the office were found wanting. An event like that is a good reason to ask whether your context has changed significantly. If it has, clause 8.6.2 calls for another exercise.

## What the auditor will ask to see

Two other clauses matter here. Clause 7.3 lists the minimum documented information, and it includes the exercising and testing plan and the post-exercise reports. Clause 9.1.2 lists performance indicators, and two of them concern exercises directly: that exercises and tests were designed and planned, and that they were conducted, with post-exercise reports produced and approved.

So the evidence pack is predictable. An exercise plan showing what was going to be exercised and when. A post-exercise report for each one. Evidence that the report was approved by someone with authority. And, in practice, evidence that the recommendations turned into actions with owners and dates, because clause 10 expects nonconformities to be corrected in a timely manner. An auditor who finds last year's report with the same three gaps as this year's report will not be impressed by the fact that you exercised.

## Two things people assume it says, but it does not

**It does not name a type of exercise.** The word "tabletop" does not appear in the standard. Nor do "simulation" or "live test". The standard's own guidance says that a good starting point is a team walk-through of the response structure, and it notes that exercises build teamwork, competence, confidence and knowledge, while tests check whether a specific outcome can actually be achieved, such as a system being recovered within a time limit. Beyond that, the format is yours to choose. We have written separately about which format auditors tend to expect in practice.

**It does not set a frequency.** "At planned intervals" is deliberately open. The guidance acknowledges that it is usually not practical to cover everything in a one-year programme, and that the programme may be spread over several years. That said, an annual cycle is the common choice, and it fits neatly with the management review the standard requires at least once a year (9.3.1). A longer gap is allowed, but you would need a reason you are comfortable explaining.

## A practical starting point

If you are building a programme from nothing, the standard's own suggestion is a sensible one: start with a walk-through, where the response team reads the plan together and talks through what each person would do. It is low-cost, it finds the obvious gaps, and it gets people comfortable before anything with time pressure.

Then move to a scenario exercise with objectives and a report, because that is what produces the evidence the standard asks for. One per year, each testing a different risk, is a programme most mid-sized organizations can sustain. Add a test, such as a real restoration of a critical system from backup, where a plan makes a recovery promise you have never actually tried.

In short: plan the exercises, report each one, close the actions, and keep the evidence. The clause numbers are just where to file it.

## Sources

- [NCEMA — National Emergency Crisis and Disasters Management Authority](https://www.ncema.gov.ae/) — the issuing body for AE/SCNS/NCEMA 7000:2021. Clauses referred to above: 2.41 (definition of a post-exercise report), 7.3, 8.6, 8.6.1, 8.6.2, 9.1.2, 9.3.1 and 10.
- [NCEMA launches third edition of its BCMS standard](https://thebci.org/news/ncema-launch-3rd-edition-of-bcms-standards.html) — Business Continuity Institute.
- [UAE witnesses largest amount of rainfall in 75 years](https://gulfnews.com/uae/weather/uae-witnesses-largest-amount-of-rainfall-in-75-years-1.1713319645595) — Gulf News / WAM, 18 April 2024.
- [ISO 22301:2019 — Security and resilience — Business continuity management systems — Requirements](https://www.iso.org/standard/75106.html) — ISO, clause 8.5.
