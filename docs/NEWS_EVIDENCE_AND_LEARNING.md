# News evidence and public-learning safety

**Security update:** public/shared conversational stores are now fully quarantined;
`SOHAM_PUBLIC_AUTO_LEARN_ENABLED=1` no longer re-enables publishing. Private
features require signed identity. See [current isolation rollout](USER_DATA_ISOLATION.md).
The historical opt-in description below is superseded by that containment policy.

## Reported incident

The search pipeline returned multiple India-related stories, but the answer said
only an unrelated US article was returned. Separately, the public FAQ log included
an appended `USER_MEMORY` block containing a response preference.

The old executor capped tool output at 2200 characters after concatenating raw
article snippets. A long first article could crowd out later headlines even while
all six source URLs were returned to the client. The supplied trace is consistent
with that failure path; without the exact prompt we cannot prove it was the only
cause of the model's response.

## Changes

- For news queries, relevance/freshness ranking runs before the top-10 truncation
  and page enrichment. An India headline query is not satisfied merely because a
  US story is published by an Indian outlet. Known stale/future dates are filtered.
- The news tool packs up to six bounded headlines, snippets, dates, and source
  labels into the existing 2200-character executor budget. Full URLs remain in
  structured sources; short URLs also appear directly in the text. The model is
  told to summarize available reports, rather than generalize one bad hit to an
  entirely failed lookup. This reduces prompt loss; it cannot guarantee LLM accuracy.
- Unknown publication times are labelled explicitly, not presented as confirmed
  today's headlines. The broad-headline freshness window is 36 hours to tolerate
  timezone boundaries; it is not proof of publication on the user's local date.
- Appended private-context blocks are removed from routing/learning questions,
  including a `USER_MEMORY` marker concatenated after the question punctuation.
- Automatic cross-user publishing (FAQ, corrections, suggestions, and tool-result
  auto-learning) is now disabled unless `SOHAM_PUBLIC_AUTO_LEARN_ENABLED=1`.
  Private user memory and curated knowledge APIs are separate and unchanged.
- Even when explicitly enabled, marker-contaminated/personal inputs are rejected;
  transient news/weather/live questions, lookup failures, and tool-derived QAs are
  not promoted into durable public FAQs. This policy is conservative, not a PII
  detector; opt in only for an operator-reviewed public workflow.
- Previously generated FAQ entries are suppressed by default; marker-contaminated
  entries are always excluded. Obvious contaminated realtime-cache records are
  also filtered. Existing records and logs are **not deleted**. Operators should
  audit previously shared entries and remove sensitive records through an approved
  process. No blanket deletion/migration is performed here.

## Validation

`npm run test:news-learning` uses synthetic reproductions, not the user's export.
It covers India relevance, stale dates, all six headlines surviving the real agent
output cap, source preservation, appended-context stripping, literal marker text,
default-off public publishing, refusal/transient/tool-result rejection, and
filtering existing contaminated entries. Provider requests are mocked in tests;
deployed model responses still need smoke testing after release.
