#!/usr/bin/env node
/**
 * Regenerate Playwright API tests from the Swagger spec.
 *
 *   export GEMINI_API_KEY=...
 *   npm run generate:api
 *
 * Optional: GEMINI_MODEL tries that model first.
 * Fallback order: gemini-3.5-flash-lite, gemini-3.1-flash-lite, gemini-3.8-flash.
 * Writes tests/api/payment-api.spec.ts and generated_test/test/api/payment-api.spec.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specPath = path.join(repoRoot, 'application_code/docs/swagger.yaml');
const promptPath = path.join(repoRoot, 'scripts/prompts/api-tests.md');
const outPaths = [
    path.join(repoRoot, 'tests/api/payment-api.spec.ts'),
    path.join(repoRoot, 'generated_test/test/api/payment-api.spec.ts'),
];

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error('GEMINI_API_KEY is not set. Export it and run npm run generate:api.');
    process.exit(1);
}

const fallbackModels = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];
const models = [...new Set([process.env.GEMINI_MODEL, ...fallbackModels].filter(Boolean))];
const spec = fs.readFileSync(specPath, 'utf8');
const prompt = fs.readFileSync(promptPath, 'utf8');
const responseCount = countDocumentedResponses(spec);

if (responseCount === 0) {
    console.error(`No documented responses found in ${specPath}`);
    process.exit(1);
}

console.log(`Model order: ${models.join(' -> ')}`);
const { source, model } = await generateSpec({ apiKey, models, prompt, spec });
assertSpec(source, { apiKey, responseCount });

for (const outPath of outPaths) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, source.endsWith('\n') ? source : `${source}\n`);
}

console.log(`Generated with model ${model}.`);
console.log(`Wrote ${responseCount} API tests to:`);
for (const outPath of outPaths) {
    console.log(`  ${path.relative(repoRoot, outPath)}`);
}

function countDocumentedResponses(yaml) {
    const lines = yaml.split('\n');
    const start = lines.findIndex((line) => line === 'paths:');
    if (start === -1) return 0;
    let count = 0;
    let inPaths = false;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 0 && !line.startsWith(' ')) break;
        inPaths = true;
        if (/^        "[0-9]{3}":\s*$/.test(line)) count += 1;
    }
    return inPaths ? count : 0;
}

async function generateSpec({ apiKey, models, prompt, spec }) {
    const payload = JSON.stringify({
        generationConfig: { temperature: 0 },
        contents: [
            {
                role: 'user',
                parts: [{ text: `${prompt}\n\nSwagger 2.0 document:\n${spec}` }],
            },
        ],
    });

    let lastStatus = 0;
    let lastBody = '';

    for (const model of models) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        console.log(`Calling model ${model}`);

        for (let attempt = 1; attempt <= 2; attempt++) {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey,
                },
                body: payload,
            });
            const bodyText = await response.text();
            if (response.ok) {
                const text = readCandidateText(bodyText, model);
                return { source: stripFence(text).trim(), model };
            }

            lastStatus = response.status;
            lastBody = bodyText;
            const retryable = response.status === 429 || response.status === 503;
            const switchModel = response.status === 404 || retryable;
            if (!switchModel) {
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
        console.error(`Model ${model} returned an empty test file.`);
        console.error(JSON.stringify(body).slice(0, 2000));
        process.exit(1);
    }
    return text;
}

function stripFence(text) {
    const fenced = text.match(/```(?:typescript|ts)?\s*([\s\S]*?)```/);
    return fenced ? fenced[1].trim() : text.trim();
}

function assertSpec(source, { apiKey, responseCount }) {
    if (!source.includes("from '@playwright/test'") || !/(?<![\w.])test\s*\(/.test(source)) {
        console.error('Generated file is not a Playwright spec. Nothing was written.');
        process.exit(1);
    }
    if (source.includes(apiKey) || /\btest\.skip\s*\(/.test(source) || /\btest\.only\s*\(/.test(source)) {
        console.error('Generated file failed the safety check. Nothing was written.');
        process.exit(1);
    }
    const tests = source.match(/(?<![\w.])test\s*\(/g) || [];
    if (tests.length !== responseCount) {
        console.error(
            `Expected ${responseCount} tests (one per documented response) but the model returned ${tests.length}. Nothing was written.`
        );
        process.exit(1);
    }
}
