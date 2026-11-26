# Cross-user disclosure containment and rollout

## Security changes (backend)

- A shared `SOHAM_API_KEY` authenticates the application, **not a person**. A caller
  can no longer select another account just by sending its `userId`.
- Private features require `X-User-Token`: a signed Firebase ID token or Supabase
  access token. Firebase signatures, issuer, audience, expiry, issued-at and
  authentication-time claims are verified against Google's keys. Supabase access
  tokens are checked with the configured project's Auth `/user` endpoint.
- `userId` is derived only from the verified token. Conflicting body, query,
  route-path and multipart user IDs return 403. Missing/invalid identity returns
  401 before private reads/writes. Authentication outages fail closed.
- Anonymous chat without a claimed user ID remains stateless. It has no private
  memory, profile, documents or history. Private-memory storage requires the
  backend-only `SUPABASE_SERVICE_ROLE_KEY`, not the public anon key.
- Chat, streaming and personality routes ignore client-supplied history. They load
  recent history from server storage scoped to the verified user, preventing stale
  browser history from a previous account entering a new user's model prompt.
  Without authenticated server history there is no conversation continuity.
- Client-injected `USER_MEMORY`/clock blocks are not forwarded as trusted model
  context. The backend supplies its own clock and owner-scoped profile/memories.
- Owner metadata must match exactly. An ID prefix cannot override a different or
  missing owner. Database responses are checked again after scoped queries.
- Shared conversation-derived knowledge and realtime-vector cache reads/writes
  are quarantined. Public knowledge APIs return 403. The old public auto-learning
  opt-in cannot bypass containment. No data is deleted automatically.
- Global prompts no longer disclose tester/friend lists or personal developer
  biography details, and explicitly forbid another user's private-data disclosure.
- Streaming responses explicitly use private/no-store cache headers.

## Required deployment / frontend work

1. Confirm the real production Supabase project and audit access logs. The project
   currently visible through the connected Supabase app did not contain the five
   expected SOHAM tables; it was **not changed**. This does not establish the
   security state of the actual production database.
2. Configure `SUPABASE_SERVICE_ROLE_KEY` **only on the backend**. Never ship this
   key to a browser, mobile bundle, public repo, or chat. Rotate any secret that
   may have been exposed and revoke affected sessions as appropriate.
3. Apply `supabase/migrations/202611180001_private_memory_lockdown.sql` to the
   confirmed project. The original setup policies were misleadingly named
   “service role full access” but permitted all roles. The migration removes that
   policy, revokes browser-role table privileges, and adds restrictive deny
   policies while preserving service-role access. It does not delete records.
   **Direct browser access to these tables intentionally stops working.** Move
   those reads/writes behind this backend before re-enabling personal features.
4. Set either:
   - `USER_AUTH_PROVIDER=firebase` and `FIREBASE_PROJECT_ID=<your Firebase project>`;
     use the Firebase ID token for that same project, **not** an arbitrary UID or
     custom token. The verifier is signature/expiry based; Firebase session
     revocation is not queried on every request. Use short-lived ID tokens and
     revoke sessions/rotate compromised credentials as part of incident response.
   - `USER_AUTH_PROVIDER=supabase` with the project's `SUPABASE_URL` and
     `SUPABASE_ANON_KEY` for Auth verification. The backend still needs its
     service-role key for private-table storage.
5. Update the frontend to send a fresh signed user token:

   ```ts
   const userToken = await firebaseAuth.currentUser.getIdToken();
   await fetch('/your-backend/api/chat', {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       'Authorization': `Bearer ${applicationApiKey}`,
       'X-User-Token': userToken,
     },
     body: JSON.stringify({ message: 'Hello' }),
   });
   ```

   For Supabase, use `session.access_token` instead. Do not send tokens in URLs.
   Clear browser chat, profile, document and service-worker caches on logout and
   account switch. Scope client-side state by authenticated UID; this backend
   cannot erase data already stored/displayed by the frontend. CORS allows the
   new header. Service-level API keys should preferably stay on a trusted proxy.
6. Deploy this backend (including the frontend contract change), then test two
   accounts: B cannot read, overwrite or delete A's profile/documents/memory; an
   injected A `userId` must return 403; private requests without a token must
   return 401. Verify old headers/legacy public-learning flags do not reopen access.

**Until the patch, database migration and frontend changes are deployed, do not
consider the incident contained.** Temporarily disable access to personalized
features/affected service while rolling out if continued disclosure is possible.

## Existing data

Existing public/shared records are quarantined, not removed. Audit and explicitly
approve any cleanup/reindexing. Private records that were previously contaminated
by a wrongly attributed answer cannot be reliably repaired by an ownership filter;
affected users' memories/history may need an approved review/reset. Previously
sent responses, logs, browser caches and Git history cannot be retracted by this
backend patch. These changes also do not prevent an authorized user from manually
pasting information they already possess into a request.

## Tests

`npm run test:user-isolation` uses synthetic A/B identities and hostile provider
responses. It covers HTTP impersonation, profile/document access, forged/expired/
wrong-project tokens, real RSA signatures, auth outages, conflicting/missing vector
ownership, foreign Supabase records, shared-store quarantine and both real chat
handlers receiving stale browser history. No real user records are read by tests.

CI also runs the SQL migration against disposable PostgreSQL 17, starting with a
permissive policy, then verifies browser-role denial, restrictive RLS even after an
accidental grant, preserved rows and service-role access. This is not a live
production database verification.
