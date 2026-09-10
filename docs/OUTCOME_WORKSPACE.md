# Outcome workspace contract

The revised direction is a spacious workspace for exploring a biological outcome, comparing alternatives, and inspecting the evidence. The next release improves that workflow; it does not add a new predictive engine or claim to simulate a whole organism.

## Near-term release

- **Outcome view:** an illustrative 3D blood-flow comparison makes sickling and impaired flow understandable. Its evidence anchor is the FDA's **December 8, 2023 Casgevy report**: 29 of 31 evaluable participants achieved freedom from severe vaso-occlusive crises for at least 12 consecutive months within the 24-month follow-up period; 44 participants were treated. The displayed 29/31 is that historical cohort result, not a cure rate or a prediction for a visitor or proposed edit. Keep its date, denominator, endpoint, and source beside the number. [FDA report](https://www.fda.gov/news-events/press-announcements/fda-approves-first-gene-therapies-treat-patients-sickle-cell-disease)
- **Mutation view:** retain the editable DNM1 example. The documented variant can replay its published example; an arbitrary edit remains unscored unless an actual supported computation returns a result. DNM1 and the Casgevy illustration are separate cases, not steps in one demonstrated causal chain.
- **Candidate workspace:** save alternatives across reloads; duplicate a candidate, compare it with another, add notes, and export the comparison. An outcome goal records the investigator's question. Saving it does not establish that the goal is achievable.
- **Spacious layout:** keep the outcome, selected alternative, and comparison visible together. Put detailed evidence within reach without allowing decoration or animation to conceal whether a result exists.

## Evidence and action language

| Label | Meaning |
| --- | --- |
| Measured | A sourced observation, with cohort or experiment, endpoint, and date. |
| Predicted | A numerical output from an identified model computation, with provenance and applicable limits. |
| Illustration | A visual explanation; geometry, motion, and apparent blood-flow speed are not measured or simulated physiological outputs. |

Use **Candidate**, **Duplicate**, **Compare**, **Save notes**, and **Replay** for those actions. Reserve **Run**, **Completed**, and **Prediction** for actual computation and its output. Persisting a hypothesis must not create a result, success score, or confidence estimate. Changing an illustrative scene or candidate must never alter the historical Casgevy statistic.

AlphaGenome concerns molecular effects of sequence variation; it does not supply arbitrary vaccine-efficacy percentages, clinical cure probabilities, or whole-body transformations. Such estimates require their own defined endpoint, population, evidence, and validated model. [AlphaGenome limitations](https://www.alphagenomedocs.com/faqs.html#what-are-some-of-the-limitations-of-the-model)

Fictional creature and human-enhancement scenarios, including Spider-Man, are labeled **Fiction**. Unsupported species or phenotype outcomes remain **Not assessed**. Generated appearances are concept art, not inferred phenotypes or actionable genetic-edit recipes.

## Research credibility milestone

Choose one model-supported, measurable molecular endpoint and a researcher task that uses it. Before claiming predictive research utility, demonstrate performance on held-out experimental observations, report failures and uncertainty, and preserve each computation's inputs, model/data versions, context, outputs, and evidence sources. Any claimed probabilities need endpoint-specific calibration; absent calibration must remain explicit.

Release checks: saved alternatives survive reload; exports retain evidence labels; unscored edits cannot inherit a published result; measured statistics remain unchanged by user edits. This release is an outcome-and-evidence workspace until those research gates are met.

Implementation tracking: [Worklist](../WORKLIST.md).
