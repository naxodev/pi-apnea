# jj-first commit semantics

If `.jj/` exists, use jj only for mutations (`describe` + `new` after each approved phase). Never run mutating git commands in a jj repo. Git backend: branch `apnea/<slug>` at start, one commit per phase. jj bookmark `apnea/<slug>` is created at **terminus** (when writing/finishing PR description), not at start — bookmarks do not follow `@`. “Clean tree” for start means empty meaningful file diff (jj: empty `@` changes the user cares about; not “op log quiet”). Neither VCS → refuse auto-commit. Coder commits are a protocol violation and must escalate.
