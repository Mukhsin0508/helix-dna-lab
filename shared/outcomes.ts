/** Historical clinical evidence. These counts do not describe the illustrative scene. */
export const SICKLE_CELL_EVIDENCE = {
  title: "Sickle cell disease",
  question: "Can gene editing reduce severe sickle cell crises?",
  intervention: "Casgevy · blood stem cell gene therapy",
  summary:
    "Edited blood stem cells increase fetal hemoglobin, which helps prevent red blood cells from sickling. The scene illustrates this mechanism; it does not simulate a patient's response.",
  sourceUrl:
    "https://www.fda.gov/news-events/press-announcements/fda-approves-first-gene-therapies-treat-patients-sickle-cell-disease",
  sourceTitle: "FDA · Casgevy approval announcement",
  reportedDate: "2023-12-08",
  endpoint:
    "No severe vaso-occlusive crises for at least 12 consecutive months during the 24-month follow-up period.",
  treated: 44,
  evaluable: 31,
  responders: 29,
  resultLabel: "29 of 31 evaluable participants met the endpoint",
  context:
    "Historical single-arm trial observation, reported December 2023. Of 44 treated participants, 31 had sufficient follow-up for this assessment. This is not an individual cure probability or a new prediction.",
  limitations:
    "Treatment includes stem cell collection, conditioning chemotherapy and transplantation, with risks and long-term follow-up. Review the source for safety information.",
} as const;
