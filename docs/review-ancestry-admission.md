# Review ancestry admission

New review tasks must declare an existing implementation/fix ancestor through `dependsOn`. This checks the earliest declaration boundary, before task/work-item persistence, instead of allowing a genuine review to run and discovering its missing ancestry only when integration is declared. Planned predecessors need not already be completed; normal successful bound-run settlement and independent-review checks still control dispatch.

This does not change scheduling of existing historical review rows, synthesize dependency edges, turn free-form release prose into verifier evidence, or reconcile cross-mission delivery. Existing Stop, authorization and delivery gates remain unchanged. A declared task edge is not an immutable Git/release receipt. Missing historical exact-artifact binding remains unresolved rather than fabricated.

Verification: actual Store add_task rejects an unbound review without inserting a task; valid explicit ancestry is retained, duplicate declaration is idempotent, and the review remains unschedulable before its implementation completes. The negative assertion fails against the preceding revision.
