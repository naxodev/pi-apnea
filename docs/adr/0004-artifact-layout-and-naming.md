# `.apnea/` layout and per-round paths

Runtime state lives under `.apnea/` (package name, not “pi-herdr”) and is VCS-ignored. Artifacts use `phase-N/round-M/` paths so rework never overwrites audit history. Glossary terms (Run, Phase, Phase package, Dispatch, Round, Verdict, Brief, Artifact, Gate, Profile, Role) are mandatory in briefs and tool errors so foreign harnesses pattern-match one vocabulary.
