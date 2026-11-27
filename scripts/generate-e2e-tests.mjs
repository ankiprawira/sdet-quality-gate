#!/usr/bin/env node
/**
 * Regenerate Playwright page objects and the web spec from application_code/app.
 *
 *   export GEMINI_API_KEY=...
 *   npm run generate:e2e
 *
 * Optional: GEMINI_MODEL tries that model first.
 * Fallback order: gemini-3.5-flash-lite, gemini-3.1-flash-lite, gemini-3.8-flash.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(repoRoot, 'application_code/app');
const promptPath = path.join(repoRoot, 'scripts/prompts/e2e-tests.md');
const pageObjectDir = path.join(repoRoot, 'page-objects');
const specRel = 'tests/web/e2e_web.spec.ts';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error('GEMINI_API_KEY is not set. Export it and run npm run generate:e2e.');
    process.exit(1);
}

const pages = discoverPages(appDir);
if (pages.length === 0) {
    console.error(`No page.tsx files found under ${appDir}`);
    process.exit(1);
}

const expectedRels = [...pages.map((page) => page.file), specRel];
const prompt = fs.readFileSync(promptPath, 'utf8');
const markerList = expectedRels.map((rel) => `=== ${rel} ===`).join('\n');
const manifest = pages
    .map(
        (page) =>
            `- route ${page.route} class ${page.className} file ${page.file} locator constant ${page.locators}\n${page.source}`
    )
    .join('\n\n');

const fallbackModels = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];
const models = [...new Set([process.env.GEMINI_MODEL, ...fallbackModels].filter(Boolean))];
console.log(`Pages: ${pages.map((page) => page.route).join(', ')}`);
console.log(`Model order: ${models.join(' -> ')}`);

const { source, model } = await generateText({
    apiKey,
    models,
    prompt: `${prompt}\n\nEmit these marker lines in this order, each on its own line:\n${markerList}\n\nManifest:\n${manifest}`,
});
const files = splitMarkedFiles(source);
assertFiles(files, { apiKey, pages, expectedRels, source });
removeStalePageObjects(pages);
writeFiles(files);

console.log(`Generated with model ${model}.`);
for (const rel of expectedRels) {
    console.log(`  ${rel}`);
}

function discoverPages(dir, segments = []) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            found.push(...discoverPages(path.join(dir, entry.name), [...segments, entry.name]));
        } else if (entry.name === 'page.tsx') {
            const route = segments.length === 0 ? '/' : `/${segments.join('/')}`;
            const classStem = segments.length === 0 ? 'Home' : segments.map(pascal).join('');
            const className = `${classStem}Page`;
            const fileStem = `${classStem.replace(/[A-Z]/g, (letter, index) => (index === 0 ? letter.toLowerCase() : `-${letter.toLowerCase()}`))}-page`;
            found.push({
                route,
                className,
                file: `page-objects/${fileStem}.ts`,
                locators: `${fileStem.replace(/-page$/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())}Locators`,
                source: fs.readFileSync(path.join(dir, entry.name), 'utf8'),
            });
        }
    }
    return found;
}

function pascal(segment) {
    return segment
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

async function generateText({ apiKey, models, prompt }) {
    const payload = JSON.stringify({
        generationConfig: { temperature: 0 },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    let lastStatus = 0;
    let lastBody = '';

    for (const model of models) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        console.log(`Calling model ${model}`);
        for (let attempt = 1; attempt <= 2; attempt++) {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                body: payload,
            });
            const bodyText = await response.text();
            if (response.ok) {
                return { source: readCandidateText(bodyText, model), model };
            }
            lastStatus = response.status;
            lastBody = bodyText;
            const retryable = response.status === 429 || response.status === 503;
            if (response.status !== 404 && !retryable) {
                console.error(`Gemini request failed (${response.status}) on model ${model}.`);
                console.error(bodyText.slice(0, 2000));
                process.exit(1);
            }
            if (retryable && attempt === 1) {
                console.error(`Model ${model} returned ${response.status}. Retrying once in 2s.`);
                await new Promise((resolve) => setTimeout(resolve, 2000));
                continue;
            }
            console.error(`Model ${model} returned ${response.status}. Trying the next model.`);
            break;
        }
    }

    console.error(`Every model failed. Last status: ${lastStatus}.`);
    console.error(lastBody.slice(0, 2000));
    process.exit(1);
}

function readCandidateText(bodyText, model) {
    let body;
    try {
        body = JSON.parse(bodyText);
    } catch {
        console.error(`Model ${model} returned a non-JSON body.`);
        process.exit(1);
    }
    const text = body?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    if (!text.trim()) {
        console.error(`Model ${model} returned an empty reply.`);
        process.exit(1);
    }
    return text.replace(/```(?:typescript|ts)?/g, '').replace(/```/g, '').trim();
}

function splitMarkedFiles(source) {
    const files = new Map();
    const parts = source.split(/^=== (.+?) ===\s*$/m);
    for (let i = 1; i < parts.length; i += 2) {
        const rel = parts[i].trim();
        const body = parts[i + 1].trim();
        if (files.has(rel) || !body) {
            console.error(`Marker ${rel} is missing a body or is duplicated. Nothing was written.`);
            process.exit(1);
        }
        files.set(rel, `${body}\n`);
    }
    return files;
}

function assertFiles(files, { apiKey, pages, expectedRels, source }) {
    const got = [...files.keys()].sort();
    const want = [...expectedRels].sort();
    if (got.join('\n') !== want.join('\n')) {
        console.error(`Expected files:\n${want.join('\n')}\nGot:\n${got.join('\n') || '(none)'}`);
        console.error('Reply started with:\n' + source.slice(0, 1500));
        console.error('Nothing was written.');
        process.exit(1);
    }

    for (const page of pages) {
        const source = files.get(page.file);
        if (!source.includes(`class ${page.className}`) || !source.includes(page.locators) || !source.includes('console.log') || !source.includes('pressSequentially') || source.includes('.blur(')) {
            console.error(`${page.file} must include ${page.className}, ${page.locators}, console.log, and pressSequentially, and must not call blur(). Nothing was written.`);
            process.exit(1);
        }
        if (!source.includes('async assertText(') || source.includes('exact:') || source.includes('toContainText') || (source.match(/async assert\w+\s*\(/g) || []).some((name) => !name.startsWith('async assertText'))) {
            console.error(`${page.file} must assert only with assertText, getByText without exact, and toBeVisible. Nothing was written.`);
            process.exit(1);
        }
        if (source.includes(apiKey)) {
            console.error('Generated file contains the API key. Nothing was written.');
            process.exit(1);
        }
    }

    const spec = files.get(specRel);
    const tests = spec.match(/(?<![\w.])test\s*\(/g) || [];
    if (tests.length !== pages.length * 2) {
        console.error(`Expected ${pages.length * 2} tests in ${specRel} but found ${tests.length}. Nothing was written.`);
        process.exit(1);
    }
    if (
        spec.includes(apiKey) ||
        /\btest\.skip\s*\(/.test(spec) ||
        /\btest\.only\s*\(/.test(spec) ||
        /\bexpect\s*\(/.test(spec) ||
        /\b(locator|getBy\w+|xpath)\s*\(/.test(spec) ||
        !spec.includes('assertText(')
    ) {
        console.error('The spec failed the safety check. Nothing was written.');
        process.exit(1);
    }
}

function removeStalePageObjects(pages) {
    const keep = new Set(pages.map((page) => path.basename(page.file)));
    if (!fs.existsSync(pageObjectDir)) return;
    for (const name of fs.readdirSync(pageObjectDir)) {
        if (!name.endsWith('-page.ts') || name === 'base-page.ts' || keep.has(name)) continue;
        const full = path.join(pageObjectDir, name);
        const text = fs.readFileSync(full, 'utf8');
        if (text.startsWith('// generated-page-object')) fs.unlinkSync(full);
    }
}

function writeFiles(files) {
    for (const [rel, body] of files) {
        const targets = [path.join(repoRoot, rel), path.join(repoRoot, 'generated_test', rel)];
        for (const target of targets) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, body.endsWith('\n') ? body : `${body}\n`);
        }
    }
}
