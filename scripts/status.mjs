#!/usr/bin/env node
/**
 * Report whether dsh-plugin-mobile-tweaks is wired into a profile and, when a
 * host URL is given, whether the running host serves the expected artifacts:
 * the stylesheet route, the injected index `<style>`, and the `dsh.client`
 * browser bundle.
 *
 * Usage:
 *   node scripts/status.mjs                       # $DSH_PROFILE_DIR, else $DSH_HOME/profiles/web
 *   node scripts/status.mjs --url http://127.0.0.1:3081
 *   node scripts/status.mjs --profile-dir DIR --no-fetch
 *   node scripts/status.mjs --no-client           # skip the browser-half route check
 *
 * Exit code is non-zero when the wiring is incomplete or a served artifact does
 * not match the local package, so it is safe to use in a check.
 */
import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { readStyleBundle } from "../lib/inject.js";
import { PACKAGE_NAME, PACKAGE_ROOT, resolveProfileDir, statusFor } from "./profiles.mjs";

/**
 * Recompute the client-modules artifact revision for the browser bundle.
 * Mirrors `artifactRevision()` in @deepseek-ai/dsh-client-modules: an identity
 * built from file metadata, so the served one-resource URL can be requested
 * without fetching the (authenticated) index for the boot graph.
 * @returns {string} 12-hex-char revision.
 */
function clientRevision() {
	const stat = statSync(resolve(PACKAGE_ROOT, "lib/client.js"));
	const hash = createHash("sha1").update("plugin-artifact").update("\0");
	for (const part of [String(stat.mtimeMs), String(stat.ctimeMs), String(stat.size)]) {
		hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
	}
	return hash.digest("hex").slice(0, 12);
}

const argv = process.argv.slice(2);
const options = {
	profile: "web",
	fetch: true,
	client: true,
	url: process.env.DSH_WEB_URL ?? "http://127.0.0.1:3081",
	route: "/dsh-mobile-tweaks.css",
};
for (let i = 0; i < argv.length; i += 1) {
	const arg = argv[i];
	if (arg === "--profile-dir") options.profileDir = argv[++i];
	else if (arg === "--dsh-home") options.dshHome = argv[++i];
	else if (arg === "--profile") options.profile = argv[++i];
	else if (arg === "--url") options.url = argv[++i];
	else if (arg === "--route") options.route = argv[++i];
	else if (arg === "--no-fetch") options.fetch = false;
	else if (arg === "--no-client") options.client = false;
	else {
		process.stderr.write(`status: unknown argument ${JSON.stringify(arg)}\n`);
		process.exit(2);
	}
}

const base = options.url.replace(/\/$/, "");
const profileDir = resolveProfileDir(options);
let failed = false;

/** @type {{ dir: string, css: string, files: { name: string, bytes: number }[] } | undefined} */
let bundle;
try {
	bundle = readStyleBundle(resolve(PACKAGE_ROOT, "styles"));
} catch (error) {
	failed = true;
	process.stderr.write(`status: cannot read the local stylesheet bundle: ${error.message}\n`);
}

process.stdout.write(`package:  ${PACKAGE_ROOT}\n`);
process.stdout.write(`profile:  ${profileDir}\n`);
if (bundle !== undefined) {
	process.stdout.write(`styles:   ${bundle.files.length} file(s), ${Buffer.byteLength(bundle.css)} bytes\n`);
	for (const file of bundle.files) process.stdout.write(`  - ${file.name} (${file.bytes} bytes)\n`);
}

if (!existsSync(profileDir)) {
	process.stderr.write("status: profile directory does not exist\n");
	process.exit(1);
}

const wiring = statusFor(profileDir);
process.stdout.write(`manifest: ${wiring.manifestSpec ?? "(no dependency entry)"}\n`);
process.stdout.write(
	`link:     ${wiring.linked ?? "(not linked)"}${wiring.linkedIsThisPackage || wiring.linked === undefined ? "" : "  <-- points elsewhere"}\n`,
);
process.stdout.write(
	`patch:    ${wiring.managedBlock ? "managed entry present" : "managed entry MISSING"} (${wiring.patchPath})\n`,
);
const wired = wiring.manifestSpec !== undefined && wiring.linkedIsThisPackage && wiring.managedBlock;
if (!wired) failed = true;
process.stdout.write(`wiring:   ${wired ? "ok" : "INCOMPLETE"}\n`);

/**
 * Fetch one URL, reporting transport failures instead of throwing.
 * @param {string} url - absolute URL.
 * @returns {Promise<{ status: number, body: string, response: Response } | undefined>}
 */
async function get(url) {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
		return { status: response.status, body: await response.text(), response };
	} catch (error) {
		process.stdout.write(`fetch:    GET ${url} -> ${error.name}: ${error.message}\n`);
		return undefined;
	}
}

if (options.fetch && bundle !== undefined) {
	const url = `${base}${options.route}`;
	const result = await get(url);
	if (result === undefined) {
		failed = true;
	} else {
		const served = result.response.headers.get("x-dsh-mobile-tweaks-files");
		process.stdout.write(
			`fetch:    GET ${url} -> ${result.status} ${result.response.headers.get("content-type") ?? ""}\n`,
		);
		if (served !== null) process.stdout.write(`  files:  ${served}\n`);
		if (result.status !== 200) {
			failed = true;
			process.stdout.write(`  body:   ${result.body.split("\n")[0]}\n`);
		} else if (result.body !== bundle.css) {
			failed = true;
			process.stdout.write(
				`  MISMATCH: served ${Buffer.byteLength(result.body)} bytes, local ${Buffer.byteLength(bundle.css)} bytes\n`,
			);
		} else {
			process.stdout.write("  served bytes match the local styles/ bundle\n");
		}
	}
}

if (options.fetch && options.client) {
	const rev = clientRevision();
	const url = `${base}/plugins/??${PACKAGE_NAME}/client.js&rev=${rev}`;
	const result = await get(url);
	if (result === undefined) {
		failed = true;
	} else if (result.status !== 200) {
		failed = true;
		process.stdout.write(`fetch:    GET ${url} -> ${result.status}\n`);
		process.stdout.write(
			"  browser half NOT served — the host caches dsh.client metadata per process; restart it once to rescan\n",
		);
	} else {
		const ok = result.body.includes("__ModuleLoader__.load") && result.body.includes(PACKAGE_NAME);
		if (!ok) failed = true;
		process.stdout.write(
			`fetch:    GET plugins/??${PACKAGE_NAME}/client.js&rev=${rev} -> 200 ${
				ok ? `bundle ok (${Buffer.byteLength(result.body)} bytes)` : "unexpected bundle body"
			}\n`,
		);
	}
}

process.stdout.write(`status:   ${failed ? "FAILED" : "ok"}\n`);
process.exit(failed ? 1 : 0);
