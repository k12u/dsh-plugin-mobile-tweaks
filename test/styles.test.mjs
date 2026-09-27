/**
 * Policy tests for the shipped style layers.
 *
 * The iOS focus-zoom floor is invisible on desktop, so a future edit could drop
 * it without any local symptom. These tests keep that from happening silently.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PACKAGE_ROOT, listStyleFiles, readStyleBundle } from "../lib/inject.js";

/** Read one style layer from the package. */
function readLayer(name) {
	return readFileSync(join(PACKAGE_ROOT, "styles", name), "utf8");
}

test("style layers load in numeric prefix order", () => {
	const files = listStyleFiles(join(PACKAGE_ROOT, "styles"));
	assert.deepEqual(files, [...files].sort());
	assert.ok(files.includes("00-base.css"));
	assert.ok(files.includes("20-input-zoom.css"));
	assert.ok(files.includes("90-mobile.css"));
	assert.ok(files.indexOf("00-base.css") < files.indexOf("20-input-zoom.css"));
});

test("the text-entry layer keeps a 16px floor against iOS focus zoom", () => {
	const css = readLayer("20-input-zoom.css");
	assert.match(css, /font-size:\s*max\(\s*16px\s*,\s*1em\s*\)/);
	assert.match(css, /\[contenteditable="true"\]/);
	assert.match(css, /textarea/);
	assert.match(css, /input:not\(/);
	// Guard the scope: coarse pointers always, plus the narrow no-hover fallback.
	assert.match(css, /@media\s*\(pointer:\s*coarse\)/);
	assert.match(css, /\(max-width:\s*820px\)\s*and\s*\(hover:\s*none\)/);
	// iPadOS with a keyboard/trackpad reports `pointer: fine`, so the floor needs
	// the iOS-only feature query as well. Both scopes must carry the rule.
	assert.match(css, /@supports\s*\(-webkit-overflow-scrolling:\s*touch\)/);
	assert.equal(css.match(/font-size:\s*max\(\s*16px\s*,\s*1em\s*\)/g)?.length, 2);
});

test("style layers have balanced braces and no stray block openers", () => {
	for (const name of listStyleFiles(join(PACKAGE_ROOT, "styles"))) {
		const css = readLayer(name);
		const open = (css.match(/\{/g) ?? []).length;
		const close = (css.match(/\}/g) ?? []).length;
		assert.equal(open, close, `${name}: unbalanced braces`);
		assert.ok(open > 0, `${name}: no rules`);
	}
});

test("every style layer is safe to inline and non-empty", () => {
	const bundle = readStyleBundle(join(PACKAGE_ROOT, "styles"));
	assert.ok(bundle.files.length >= 3);
	assert.ok(bundle.css.length > 0);
	assert.doesNotMatch(bundle.css, /<\/style/i);
});
