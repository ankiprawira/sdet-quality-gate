# Quality gate

This repository uses an LLM to generate Playwright API tests and web end-to-end checkout tests, then runs both on every pull request. A failed test fails the **gate** check and blocks the merge.

## Prompt design

API generation uses `scripts/prompts/api-tests.md`. The model may return only a Playwright spec. For each operation it writes one test per status listed in that operation's `responses`, including 400 and 500 when the spec documents them. A 2xx test uses the request examples. Any other documented status is sent an empty JSON object when the spec has no separate failure example, then asserts that status and the response schema examples. It must not invent a status, skip tests, or hardcode a host.

End-to-end generation uses `scripts/prompts/e2e-tests.md`. The model returns page objects and `tests/web/e2e_web.spec.ts`, split by marker lines. Selectors come from the page source: inputs by `name`, the pay control by its accessible name, and checks by visible text. The spec has no selectors of its own. One checkout page produces a negative flow and a happy flow. Fields are typed with `pressSequentially` and left with Tab, because the checkout page reads React state on blur and `fill()` does not update that state.

## Swagger to Playwright

`npm run generate:api` reads `application_code/docs/swagger.yaml` and the API prompt, calls Gemini at temperature 0, and writes `tests/api/payment-api.spec.ts` and the same file under `generated_test/`. Paths, methods, example bodies, and example responses come from the spec. Playwright's `baseURL` is the environment API URL, so the generated requests stay relative (`/api/...`).

## How to regenerate

```bash
export GEMINI_API_KEY=...
# optional: export GEMINI_MODEL=...
npm run generate:api
npm run generate:e2e
```

`generate:e2e` reads every `page.tsx` under `application_code/app` and writes the page objects and web spec into both `tests/` and `generated_test/`. The generator refuses the result if the file set is wrong, the spec contains selectors or `test.skip`, a page object calls `blur()`, or the output contains the API key.

## How CI gates a change

A pull request runs `.github/workflows/quality-gate.yml` (the copy for this exercise is `scripts/github_action.yaml`). The job:

1. Installs Go 1.21 and Node 20 on `ubuntu-24.04`.
2. Runs `scripts/start-apps.sh`, which starts the Go API on port 8080 and a production Next.js server on port 3000, then waits until both respond.
3. Installs Playwright Chromium.
4. Runs `npm run generate:api` and `npm run generate:e2e`.
5. Runs the `api-tests` and `chromium` Playwright projects against `http://127.0.0.1:8080` and `http://127.0.0.1:3000`.
6. Uploads the HTML report even when tests fail.

A failed step fails the **gate** check. Branch protection on `master` requires that check, so the pull request cannot merge.

## Scaling to more endpoints

The API prompt walks every documented response under the Swagger `paths` object. A new path, or a new status on an existing path, becomes one more test without a new script. The end-to-end generator discovers each `page.tsx` and asks for two flows per page. Adding a page means adding that file, not editing the workflow.

## Incorrect generated tests

Generation uses `temperature` 0. The API prompt may use only paths, statuses, and fields from the Swagger file, and the generator requires one test per documented response. The end-to-end prompt may use only fields, selectors, and visible text from the page source, and the generator requires two tests per page, `pressSequentially`, no selectors in the spec, and no `blur()` or `test.skip`. A reply that breaks these rules, or that contains the API key, is not saved and the workflow fails. A test that is saved and still wrong fails against the running API or checkout page, which fails the pull request.

## Flaky tests

API checks are single HTTP calls. UI checks wait with Playwright `expect` rather than a fixed sleep. The checkout app is started with `next start` so the dev HMR socket cannot block hydration. CI retries twice. A test that still flakes should be quarantined with a linked issue and a deadline, not left as `test.skip` inside the generator, which rejects skips.

## End-to-end selectors

The prompt forbids label and role lookups for the inputs because the visible labels are not tied to the fields. Locators use `input[name="..."]` from the page source, and the pay button uses the accessible name `/Pay|Complete Payment/`. Assertions use a visible substring from that same source, so a class or layout change does not break the test. Typing goes through the keyboard so React `onChange` runs before Tab fires `onBlur`.

## Secrets

The Gemini key is never written into the repo or into generated tests. Locally, export `GEMINI_API_KEY` in the shell. In GitHub Actions it is the repository secret `GEMINI_API_KEY`, passed only into the two generation steps. `GEMINI_MODEL` is optional. The generator tries `gemini-3.5-flash-lite`, then `gemini-3.1-flash-lite`, then `gemini-3.8-flash`. If every model is unavailable, generation exits with an error and the workflow fails.
