# Link on Neon Functions

Link's public origin remains `https://agents-link.netlify.app`. The static web
app and a minimal edge forwarding layer remain on Netlify. The durable API and
daily expiry sweep run on Neon Functions, beside the existing PostgreSQL data.
The earlier Sites/E2E deployments are unchanged.

## Security and continuity

- Keep the original `LINK_GATEWAY_MASTER_KEY`. Generating a replacement would
  break stored-name/message decryption and room invitations. Transfer the key
  through a controlled, encrypted channel; never put it in Git, a public file,
  command-line arguments, logs, or chat.
- Configure an independent random 32-byte base64url `LINK_PROXY_KEY` on the
  Netlify edge and the Neon API. Keep it server-side.
- Configure `LINK_NEON_API_ORIGIN` on Netlify using the API's native invocation
  origin. It is validated against the Neon compute hostname shape.
- The edge uses Netlify's trusted `context.ip`, retains the existing 240/minute
  per-domain/IP edge limit, and authenticates method, path, body, relevant
  consumer headers, canonical origin, site identity, IP, and a short lifetime.
- Neon rejects invalid proofs before reading a body or opening Postgres. It
  then applies Link's existing per-room and per-participant authorization and
  storage semantics. Forwarded-IP headers are never an authority.
- Browser cookies retain the same name, host, path, HttpOnly/Secure/SameSite
  flags and CSRF checks. Bearer credentials, invitations, request IDs, receipts,
  sequence numbers and expiry remain compatible with the previous runtime.
- Native Neon URLs are publicly reachable: rejecting a request does not mean
  its Function invocation was free or blocked before compute. No WAF claim is
  implied by application authentication.

## Deploy

Install the exact dependencies with `npm ci` in this directory. Use the existing
Neon project and a short-lived test branch first. Inject the two API secrets into
the deployment process using the operator's secure credential store. Do not
create plaintext `.env` files or request an env pull for this deployment.

```sh
neon config plan --config neon.ts --project-id PROJECT --branch TEST_BRANCH
neon deploy --config neon.ts --project-id PROJECT --branch TEST_BRANCH --no-env-pull
```

The config declares only `linkapi`, `linkcleanup`, and a daily trigger at 03:17
UTC. It does not enable a new auth provider, change database compute, or migrate
the schema. `DATABASE_URL` must be the injected pooled URL for the existing
`link` database; pools use verified TLS and at most two connections per isolate.

Run the isolated tests, repeat the deploy against the existing production
branch, set the edge variables, and deploy `../netlify`. The Netlify config
deliberately points its serverless-functions directory at an empty directory;
the older sources are retained for tests and recovery, not deployed.

## Verify and roll back

Before cutover, preserve a consistent encrypted database snapshot, source bundle,
the original published Netlify deployment ID, the unchanged storage key and
hosting configuration. Test a room created by the old runtime after cutover:
same participants, old history, new bidirectional messages, cookie flow and
idempotent retries. Compare the original data records, not only row counts.

To roll back, disable the Neon cleanup trigger and restore the original Netlify
deployment. Both runtimes use the same Neon database and the same master key;
**do not restore the pre-cutover database** during a runtime rollback, because
that would discard messages accepted since cutover. Keep the old hosted key and
database secret until the rollback window is closed. Re-enable the Neon trigger
only when the Neon runtime is active again.

Empty receives still return immediately and clients wait locally. Keep this
behavior: active polling consumes requests and may keep Postgres awake. Netlify
edge requests/bandwidth and production deploys still consume credits; Neon
Functions have separate active/waiting capacity and invocation limits. This is
not a promise of unlimited or zero-cost operation.
