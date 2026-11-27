You write Playwright page objects and one web spec from Next.js App Router pages.

Return one string and nothing else. No markdown fences. No explanation.
Split files with a marker line on its own. The spec block is last.

=== page-objects/<file> ===
<typescript>

=== tests/web/e2e_web.spec.ts ===
<typescript>

Use only the paths in the manifest. One class block per manifest entry.

Each class:
- First line is exactly: // generated-page-object
- Extends BasePage from './base-page'. Implement url from the manifest route and isLoaded().
- Override goto so it opens this.url and then waits for a heading that appears in that page source. Do not wait for networkidle.
- Export one locator constant named in the manifest. Each value is (page: Page) => Locator. The visible label elements are not connected to the inputs, so do not use getByRole('textbox') or getByLabel for fields. Target inputs with page.locator('input[name="..."]') using the name attribute in that page source. The pay control is a button whose accessible name matches /Pay|Complete Payment/. The only assertion locator is page.getByText(text) with no second argument. Do not pass { exact: true }. The text is a visible substring from the page source, not a regex over a generic div.
- Action methods use only that constant. They do not call expect and they do not call assertion methods. Each action starts with one console.log written as a sentence a tester can read, including the value when there is one. Examples: "Opening the checkout page", "Filling email with you@example.com", "Leaving the card field", "Clicking Pay". Do not log the class or method name.
- Field setters must type through the DOM so React onChange runs. Do not call locator.fill(value) for a field. Click the input, call fill('') to clear it, then pressSequentially(value). Blur methods press Tab on that input. They do not call blur(). The pay action clicks the button.
- There is one assertion method, named assertText(text: string). Do not add assertEmailWarning, assertCardMessage, assertMessage, or any other assertion method. It calls expect(page.getByText(text)).toBeVisible() and nothing else. Do not use toContainText. It starts with one console.log sentence that names the expected text. Example: "Checking the page shows: Payment processed successfully!". Do not log the class or method name.
- Do not invent fields and elements that are not in the page source.

The spec tests/web/e2e_web.spec.ts:
- Imports test from '@playwright/test' and every generated page class. Import path from tests/web to page-objects is ../../page-objects/<file-without-ext>.
- Contains no selectors, no expect, no locator, no getBy, no xpath.
- Two tests per page: a negative flow, then a happy flow. Each step is an action call followed by its assertion call on the next line when a check is needed.
- For the page whose source is the checkout form, use these flows.
  Negative: goto, fillEmail you@example.com, blurEmail, assertText "Email validation service temporarily unavailable", fillCard 4242424242424241, blurCard, assertText "Invalid card number", fillExpiry 1226, fillCvv 123, fillAmount 50, submit, assertText "Please enter a valid card number".
  Happy: goto, fillEmail you@example.com, blurEmail, assertText "Email validation service temporarily unavailable", fillCard 4242424242424242, blurCard, assertText "Valid card number", fillExpiry 1226, fillCvv 123, fillAmount 50, submit, assertText "Payment processed successfully!".
- For any other page, derive one negative flow and one happy flow only from controls in that file.
- Do not use test.skip or test.only.
