/**
 * Structural tests for the hand-written browser bundle.
 *
 * The factory body is pure definition: it only touches `document` when the
 * plugin is applied, so the bundle contract (module id, factory shape, exports)
 * is testable in Node. The DOM behavior itself is verified in a real browser
 * (see README).
 */
import assert from "node:assert/strict";
import test from "node:test";

/** Load the bundle with a fake module-loader facade and return the registration. */
async function loadRegistration() {
	/** @type {any} */
	let registration;
	globalThis.window = /** @type {any} */ ({
		__ModuleLoader__: {
			load: (definition) => {
				registration = definition;
			},
		},
	});
	try {
		await import(`../lib/client.js?test=${Math.random()}`);
	} finally {
		delete globalThis.window;
	}
	return registration;
}

test("browser bundle registers the package id with a factory", async () => {
	const registration = await loadRegistration();
	assert.equal(registration.id, "dsh-plugin-mobile-tweaks");
	assert.equal(typeof registration.factory, "function");
	const instance = registration.factory();
	assert.equal(typeof instance.apply, "function");
	assert.ok(Array.isArray(instance.inject));
});

test("applying with behavior disabled is a no-op and needs no DOM", async () => {
	const registration = await loadRegistration();
	const instance = registration.factory();
	assert.doesNotThrow(() => instance.apply({}, { behavior: false }));
});

test("a changed selection collapses the sidebar only on a narrow, expanded viewport", async () => {
	const registration = await loadRegistration();
	const { shouldAutoCollapse } = registration.factory();

	// The wanted case: mobile, sidebar open, another session selected.
	assert.equal(shouldAutoCollapse("s1", "s2", true, false), true);
	// No selection change (re-render, re-click on the active session).
	assert.equal(shouldAutoCollapse("s1", "s1", true, false), false);
	// Desktop keeps its own sidebar state.
	assert.equal(shouldAutoCollapse("s1", "s2", false, false), false);
	// Already collapsed: nothing to toggle.
	assert.equal(shouldAutoCollapse("s1", "s2", true, true), false);
	// Clearing back to the blank page also counts as a change.
	assert.equal(shouldAutoCollapse("s1", undefined, true, false), true);
});
