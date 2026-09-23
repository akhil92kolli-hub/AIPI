# Full AIPI demo and release evidence

## Demo story

Run `npm run demo:aipi` for the one-command deterministic version, or walk through the individual tools below.

1. Start the intentionally mismatched fixture app or inspect `fixtures/next-contract-mismatch`.
2. Ask the editor to call `trace_route` for `POST /api/users`. AIPI returns the Next.js handler, Zod `customerId: uuid` field, and Prisma model.
3. Ask it to call `diff_contract` with the fixture frontend file. AIPI returns `customerId` as frontend `number` versus backend `uuid`.
4. Route a failing local request through the observer and call `run_local_diagnostic`. The tool identifies the validation or database failure from captured runtime evidence.
5. Propose the narrow code correction, then call `check_blast_radius` before changing the provider contract.
6. After a successful request, call `generate_fixture` for Vitest and let the editor place/review the returned test.
7. Run `npm run guard -- fixtures/next-contract-mismatch` to demonstrate that CI blocks the known mismatch.

## Marketplace test cases

These cases form the initial release evaluation set. Expected outputs must be checked before each submission.

### Positive cases

1. Trace `POST /api/users` in the fixture; expect the handler file, Zod schema, and Prisma model.
2. Compare the fixture frontend with `POST /api/users`; expect one `customerId` type mismatch.
3. Diagnose a captured Zod failure; expect `validation` as the first failing layer and no credential values.
4. Generate a Vitest fixture from a successful observed request; expect deterministic test source without a repository write.
5. Change a registered provider field used by two consumers; expect both repository/file/line impacts.

### Negative and safety cases

1. Attempt to replay a POST diagnostic without `allow_state_change`; expect refusal and no request.
2. Request a route outside the configured project root; expect bounded lookup and no arbitrary file disclosure.
3. Query another user's Supabase organization with a valid user token; expect an empty result or RLS denial.

## Completion boundary

The repository contains the local observer, deterministic MCP tools, fixture generator, CI guard, file-backed remote demo, Supabase migration, and RLS-backed Edge Function. Public marketplace availability remains external work until a production endpoint, OAuth flow, legal URLs, verified publisher/domain, production evaluation evidence, and OpenAI approval exist.
