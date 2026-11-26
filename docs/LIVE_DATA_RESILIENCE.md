# Live data, follow-up context, and safe recovery

## Why this changed

A reported conversation asked for information about an IND vs UAE highlights video.
The assistant switched to a 2023 match and later attached music sources. The backend
now resolves explicit follow-ups against the user's recent subject before planning
and execution, keeps a bounded video-subject hint from widget history, and routes
anchored match follow-ups to the sports tool even when a planner returns an empty or
unrelated search plan. Previous assistant prose is not treated as verified evidence.

Security update: chat now uses authenticated server-side history, not browser
history/widget payloads, to prevent stale account data crossing sessions. A
follow-up requires the initiating request to have been saved for the same verified
user; otherwise SOHAM must ask for the match identity. See USER_DATA_ISOLATION.md.

## CricketData

- Set `CRICKETDATA_API_KEY` in Render; existing `CRICAPI_KEY` remains an alias.
- Register for a key at https://cricketdata.org/member.aspx (do not send keys in chat).
- Uses the documented `https://api.cricapi.com/v1/currentMatches` endpoint.
- Filters by teams (including IND/UAE aliases) and explicit year, instead of returning
  the first unrelated matches. Returns innings, runs/wickets, overs, status, date,
  venue, source attribution, and retrieval time.
- The public feed is cached for 60 seconds with concurrent-request deduplication.
  Provider failures trigger a 60-second cooldown before direct requests resume.
  Cache timestamps remain the original fetch time; no expired feed is served as live.
- API authentication/quota errors, malformed JSON, empty/nonmatching data, network
  failure, and timeouts trigger one web-search fallback. Unrelated results and
  conflicting explicit years are discarded. When no year was requested, older
  dated web results are excluded rather than silently substituted for the current
  match. This intentionally sacrifices some historical recall; ask for a year.
- Web references are labelled as unverified live data. Multiple possible matches
  require clarification rather than choosing a tournament arbitrarily.
- The provider advertises a free quota of 100 requests/day and delayed data; verify
  current account limits. This is not a guaranteed instantaneous live-score feed.
  The current-matches endpoint is not a full historical archive; missing matches
  are not proof that a match never happened. Full health probes also consume API
  calls, so do not use them as high-frequency liveness checks.

Sources reviewed:
- https://cricketdata.org/live-cricket-score-api/
- https://cricketdata.org/pricing/

## Weather

SOHAM already had a basic Open-Meteo integration; this change expands and hardens it.
No weather key is required for the public endpoint. It geocodes a supplied city and
retrieves current model estimates plus seven daily forecasts, humidity, wind,
minimum/maximum temperatures and precipitation probability. Data carries location,
timezone, timestamp, units and Open-Meteo attribution.

It does not silently default to New York. Missing locations prompt for city/country;
selected geocoding locations are shown so ambiguity is visible. It does not implement
historical weather, air-quality alerts, or an extended forecast beyond seven days.
Failed lookups use a bounded, clearly labelled web fallback, then admit unavailability.

**Licence:** Open-Meteo's public tier is for non-commercial use and has usage limits
and no uptime guarantee. A commercial SOHAM deployment needs a suitable licence or
provider arrangement; no subscription or paid service is enabled by this change.
See https://open-meteo.com/en/pricing and https://open-meteo.com/en/docs.

## Recovery boundaries

- Direct HTTP requests have 4.5-second deadlines and use a single fallback path,
  not recursive retries or automatic account creation.
- Existing agent execution isolates failed tools and caps tool execution time.
- Empty/error results are marked failed, not described as live evidence.
- Evidence instructions require identity/date checks and clarification when uncertain.
- If YouTube oEmbed fails for a placeholder title, the first titled search candidate
  is preferred over the opaque video-ID result.
- These changes improve defensive behaviour; they do not make an LLM infallible,
  repair missing credentials, change infrastructure, or guarantee API availability.
- Local and CI tests mock APIs. Live connectivity, provider coverage, licences and
  account quota must still be checked in the deployed environment.

Run `npm run test:live-data` for the regression suite. It covers follow-up query
binding, contradictory assistant history, widget subject preservation, team/year
matching, scores, quota/HTTP/JSON/empty-feed failures, irrelevant-source rejection,
weather forecasts and missing cities, offline fallback, and title recovery.
