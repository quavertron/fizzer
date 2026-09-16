# Local prompt token comparison

Measure the same saved inputs through the old and new prompt projections, then
save their exact text as ordered sections in a private JSON file. The command
concatenates sections without adding separators, counts complete prompt bodies
separately, and reports each section's tokens and share of its own version's total.
Do not compare captures taken at different times as if their input was identical.

One-time setup (downloads the tokenizer and its encoding data):

```sh
python -m venv /tmp/fizzer-token-venv
/tmp/fizzer-token-venv/bin/pip install tiktoken==0.12.0
/tmp/fizzer-token-venv/bin/python -c 'import tiktoken; tiktoken.get_encoding("o200k_base")'
```

Subsequent comparisons run locally without a provider request:

```sh
/tmp/fizzer-token-venv/bin/python scripts/compare-prompt-tokens.py /tmp/prompt-pairs.json > /tmp/token-results.json
python scripts/compare-prompt-tokens.test.py
```

Input shape (include real delimiters/newlines in the sections; this tiny example
only illustrates the format):

```json
{
  "samples": [{
    "name": "saved-example",
    "scope": "Complete prompt body, excluding outer runner context",
    "sections": [
      {"name": "Authority", "before": "Honor Stop.\n", "after": "Honor Stop.\n", "check": "identical"},
      {"name": "Context", "before": "{\"a\":\"evidence\",\"b\":\"evidence\"}", "after": "{\"a\":\"evidence\",\"b\":{\"contextRef\":[\"a\"]}}", "check": "contextRefs"},
      {"name": "Retrieval", "before": "\nRead mission history.", "after": "\nRead mission history.", "required": ["mission history"]}
    ]
  }]
}
```

`identical` guards authority text. `contextRefs` resolves paths in that section's
JSON and requires exact equality to the original JSON, including unresolved
commitments, questions, source IDs and evidence references. It fails on missing
paths or targets that are not retained strings. `required` guards explicitly
selected retrieval or responsibility instructions in both versions. These are
content preservation checks, not proof that a model will interpret them correctly.

Generate projections with the actual implementation at each revision. For the
83f64a0e reference cleanup, `Cascade.Missions.Interpretation.encode_context/1`
can run offline on saved JSON; no application, database or provider need start:

```sh
cd backend_elixir
# Requires existing compiled Jason dependencies; use the applicable build path.
elixir -pa _build/test/lib/jason/ebin \
  -r lib/cascade/content/privacy.ex \
  -r lib/cascade/missions/interpretation.ex \
  -e 'IO.write(Cascade.Missions.Interpretation.encode_context(Jason.decode!(File.read!(hd(System.argv())))))' \
  /tmp/context-before.json > /tmp/context-after.json
```

Retain the original prompt prefix and suffix, applying any instruction changes
from the same revision to the suffix. Include added reference guidance in the
new whole-prompt count. Label payload-only samples explicitly; they cannot
establish full-prompt savings. Keep private saved inputs in live vault notes or
local artifacts, not in the public repository.

Output includes tokenizer version/encoding, input and prompt SHA-256 hashes,
absolute before/after counts, saved tokens, percentage reduction, section shares,
and `boundaryDifference` (whole count minus sum of section counts). A negative
saving means growth. Boundary differences arise because separately tokenized
sections can merge differently when concatenated. Shares can therefore sum to
slightly more or less than 100%. Check repeatability with a second run and `cmp`.

These are tiktoken text counts for the selected encoding, not billed usage or a
claim about a specific provider/model. They exclude API framing, outer/hidden
context, cached-token pricing, output tokens, retries and full-task efficiency.
No live model trials or telemetry are involved. Text alone cannot prove retention
in explicit retrieval endpoints; verify those separately when making that claim.
