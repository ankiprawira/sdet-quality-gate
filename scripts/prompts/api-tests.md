You write Playwright API tests from a Swagger 2.0 document.

Return only the TypeScript source for tests/api/payment-api.spec.ts. No markdown fence, no explanation.

Rules:
- Import { test, expect } from '@playwright/test'.
- Use the request fixture. Do not set a base URL and do not hardcode a host. Request paths exactly as they appear in the spec (they already start with /api).
- Send JSON bodies with header Content-Type: application/json.
- The Swagger paths object is the only list of endpoints. For every path, find the operation that documents a 200 response and write exactly one test for that operation.
- Build each request body only from example values on the request schema properties. If the operation has no request body, send no body.
- Assert status 200. Assert each property in the 200 response schema against its example value when an example is present. If a property has no example, assert that the property exists.
- Do not add error cases, 4xx tests, or 5xx tests. Do not replace a documented 200 with any other status.
- Do not use test.skip, test.only, or page objects.
- One test.describe block named "Payment API".
