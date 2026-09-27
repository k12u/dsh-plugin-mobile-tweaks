/**
 * Unit tests for the pure index/stylesheet transforms.
 * Run with: node --test test/   (no host, no profile, no network)
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	PACKAGE_ROOT,
	assertSafeCss,
	listStyleFiles,
	mergeViewportContent,
	patchIndexHtml,
	parseViewportTokens,
	readStyleBundle,
	renderStyleElement,
	resolveStylesDir,
	sanitizeComment,
} from "../lib/inject.js";

/** A stand-in for the shipped shell index (same shape as dsh-web-frontend dist). */
const SHELL_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DeepSeek Harness</title>
    <link rel="stylesheet" crossorigin href="./assets/vendor.css">
    <link rel="stylesheet" crossorigin href="./assets/index.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

test("style element lands last in head, after the shell stylesheets", () => {
	const out = patchIndexHtml(SHELL_INDEX, { css: "html{color:red}", files: [{ name: "90-mobile.css" }] });
	const styleAt = out.indexOf('id="dsh-mobile-tweaks"');
	const lastShellSheet = out.lastIndexOf("./assets/index.css");
	const headEnd = out.indexOf("</head>");
	assert.ok(styleAt > lastShellSheet, "injected style must follow the shell stylesheets");
	assert.ok(styleAt < headEnd, "injected style must stay inside head");
	assert.match(out, /data-dsh-mobile-tweaks="1"/);
	assert.match(out, /\/\* dsh-plugin-mobile-tweaks: 90-mobile\.css \*\//);
});

test("viewport flags merge without dropping existing tokens", () => {
	const out = patchIndexHtml(SHELL_INDEX, { css: "" });
	assert.match(out, /content="width=device-width, initial-scale=1, viewport-fit=cover"/);
	assert.equal(out.match(/name="viewport"/g)?.length, 1);
});

test("viewport meta is created when the shell ships none", () => {
	const html = "<html><head><title>x</title></head><body></body></html>";
	const out = patchIndexHtml(html, { css: "" });
	assert.match(out, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" \/>/);
});

test("patching twice is idempotent", () => {
	const once = patchIndexHtml(SHELL_INDEX, { css: "html{color:red}", files: [{ name: "90-mobile.css" }] });
	const twice = patchIndexHtml(once, { css: "html{color:red}", files: [{ name: "90-mobile.css" }] });
	assert.equal(twice, once);
	assert.equal(twice.match(/id="dsh-mobile-tweaks"/g)?.length, 1);
	assert.equal(twice.match(/viewport-fit=cover/g)?.length, 1);
});

test("viewport patch can be disabled, and existing flags keep their values", () => {
	const out = patchIndexHtml(
		'<head><meta name="viewport" content="width=device-width, viewport-fit=contain"></head>',
		{ css: "", viewport: { "viewport-fit": "cover" } },
	);
	assert.match(out, /viewport-fit=contain/);
	const disabled = patchIndexHtml(SHELL_INDEX, { css: "", viewport: null });
	assert.doesNotMatch(disabled, /viewport-fit/);
});

test("extra head markup is injected before the style element", () => {
	const out = patchIndexHtml(SHELL_INDEX, {
		css: "html{color:red}",
		headHtml: '<meta name="theme-color" content="#000000" />',
	});
	assert.ok(out.indexOf('name="theme-color"') < out.indexOf('id="dsh-mobile-tweaks"'));
});

test("a bundle problem degrades to a comment instead of breaking the page", () => {
	const out = patchIndexHtml(SHELL_INDEX, { problem: "ENOENT: styles missing" });
	assert.match(out, /PROBLEM: ENOENT: styles missing/);
	assert.match(out, /id="dsh-mobile-tweaks"/);
});

test("problem text cannot close the style element it is reported in", () => {
	const out = patchIndexHtml(SHELL_INDEX, { problem: "bad */ </style><script>alert(1)</script>" });
	assert.equal(out.match(/<\/style>/gi)?.length, 1);
	assert.doesNotMatch(out, /<script>alert\(1\)<\/script>/);
});

test("renderStyleElement escapes the inventory it reports", () => {
	const element = renderStyleElement("", { files: [{ name: "a.css" }, { name: "b.css" }] });
	assert.match(element, /data-dsh-mobile-tweaks="2"/);
	assert.match(element, /a\.css, b\.css/);
});

test("viewport token parsing and merging is order preserving and non-destructive", () => {
	const tokens = parseViewportTokens("width = device-width, initial-scale=1");
	assert.deepEqual([...tokens], [["width", "device-width"], ["initial-scale", "1"]]);
	assert.equal(
		mergeViewportContent("width=device-width, initial-scale=1", { "viewport-fit": "cover" }),
		"width=device-width, initial-scale=1, viewport-fit=cover",
	);
	assert.equal(
		mergeViewportContent("width=device-width, viewport-fit=contain", { "viewport-fit": "cover" }),
		"width=device-width, viewport-fit=contain",
	);
});

test("CSS that would close the injected style element is refused loudly", () => {
	assert.throws(() => assertSafeCss("a{} </STYLE><script>x</script>"), /<\/style/);
	assert.equal(assertSafeCss("a{}"), "a{}");
});

test("sanitizeComment neutralizes comment and element terminators", () => {
	assert.equal(sanitizeComment("a */ b </style>"), "a *\\/ b <\\/style>");
});

test("style files load in file-name order and non-css files are ignored", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-mt-"));
	writeFileSync(join(dir, "90-mobile.css"), "b{}\n");
	writeFileSync(join(dir, "00-base.css"), "a{}\n");
	writeFileSync(join(dir, "notes.txt"), "ignored\n");
	assert.deepEqual(listStyleFiles(dir), ["00-base.css", "90-mobile.css"]);
	const bundle = readStyleBundle(dir);
	assert.ok(bundle.css.indexOf("==== 00-base.css ====") < bundle.css.indexOf("==== 90-mobile.css ===="));
	assert.deepEqual(bundle.files.map((file) => file.name), ["00-base.css", "90-mobile.css"]);
	assert.ok(bundle.files.every((file) => file.bytes > 0 && file.mtimeMs > 0));
});

test("stylesDir resolves relative to the package root", () => {
	assert.equal(resolveStylesDir(undefined), join(PACKAGE_ROOT, "styles"));
	assert.equal(resolveStylesDir("styles"), join(PACKAGE_ROOT, "styles"));
	assert.equal(resolveStylesDir("/tmp/x"), "/tmp/x");
});
