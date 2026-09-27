#!/usr/bin/env node
/**
 * Wire dsh-plugin-mobile-tweaks into a DSH profile, or report/undo the wiring.
 *
 * Two idempotent steps:
 *   1. `pnpm add link:<this package>` (or `dsh plugin add`) inside the profile
 *      directory, so the profile's node_modules resolves the package name.
 *   2. append or refresh one marked loader entry in the profile's
 *      `cordis.patch.yml`, so the profile mounts the plugin.
 *
 * Usage:
 *   node scripts/install.mjs                       # $DSH_PROFILE_DIR, else $DSH_HOME/profiles/web
 *   node scripts/install.mjs --profile-dir DIR
 *   node scripts/install.mjs --dsh-home DIR --profile web
 *   node scripts/install.mjs --check               # report only, change nothing
 *   node scripts/install.mjs --remove              # undo both steps
 *   node scripts/install.mjs --no-pnpm             # edit cordis.patch.yml only
 *   node scripts/install.mjs --via-dsh             # use `dsh plugin add` instead of pnpm
 *   node scripts/install.mjs --restart             # restart the user service afterwards
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
	PACKAGE_ROOT,
	PATCH_FILE,
	readPatch,
	resolveProfileDir,
	dshHomeOf,
	statusFor,
	stripBlock,
	upsertBlock,
} from "./profiles.mjs";

/**
 * Parse this script's command line.
 * @returns {Record<string, any>} parsed options.
 */
function parseArgs() {
	const argv = process.argv.slice(2);
	const options = { profile: "web", check: false, remove: false, pnpm: true, viaDsh: false, restart: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--profile-dir") options.profileDir = argv[++i];
		else if (arg === "--dsh-home") options.dshHome = argv[++i];
		else if (arg === "--profile") options.profile = argv[++i];
		else if (arg === "--check") options.check = true;
		else if (arg === "--remove") options.remove = true;
		else if (arg === "--no-pnpm") options.pnpm = false;
		else if (arg === "--via-dsh") options.viaDsh = true;
		else if (arg === "--restart") options.restart = true;
		else if (arg === "-h" || arg === "--help") {
			const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
			process.stdout.write(`${lines.slice(1, 22).join("\n")}\n`);
			process.exit(0);
		} else {
			process.stderr.write(`install: unknown argument ${JSON.stringify(arg)}\n`);
			process.exit(2);
		}
	}
	return options;
}

/**
 * Run one child process, inheriting stdio, and return its status.
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @param {{ cwd: string, env?: Record<string, string | undefined> }} options - spawn options.
 * @returns {number} exit status (127 when the executable is missing).
 */
function run(command, args, options) {
	process.stdout.write(`$ ${command} ${args.join(" ")}\n`);
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: "inherit",
	});
	if (result.error) {
		process.stderr.write(`install: ${result.error.message}\n`);
		return 127;
	}
	return result.status ?? 0;
}

const options = parseArgs();
const profileDir = resolveProfileDir(options);
const patchPath = join(profileDir, PATCH_FILE);

if (!existsSync(profileDir)) {
	process.stderr.write(`install: profile directory does not exist: ${profileDir}\n`);
	process.exit(1);
}

if (options.check) {
	const current = statusFor(profileDir);
	process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
	const ok = current.managedBlock && current.manifestSpec !== undefined && current.linkedIsThisPackage;
	process.stdout.write(ok ? "install: wired\n" : "install: NOT wired\n");
	process.exit(ok ? 0 : 1);
}

if (options.remove) {
	if (options.pnpm) {
		const code = run("pnpm", ["remove", "dsh-plugin-mobile-tweaks"], { cwd: profileDir });
		if (code !== 0) process.stderr.write("install: pnpm remove failed; continuing with the patch cleanup\n");
	}
	const { body, removed } = stripBlock(readPatch(patchPath));
	if (removed) writeFileSync(patchPath, body);
	process.stdout.write(`install: ${removed ? "removed the loader entry" : "no managed loader entry found"}\n`);
	process.exit(0);
}

if (options.pnpm) {
	const spec = `link:${PACKAGE_ROOT}`;
	let code;
	if (options.viaDsh) {
		code = run(process.env.DSH_BIN ?? "dsh", ["plugin", "--profile", options.profile, "add", spec], {
			cwd: profileDir,
			env: { DSH_HOME: dshHomeOf(profileDir) },
		});
		if (code === 127) {
			process.stderr.write("install: `dsh` not found; retry with --no-pnpm or set DSH_BIN\n");
			process.exit(1);
		}
	} else {
		code = run("pnpm", ["add", spec], { cwd: profileDir });
	}
	if (code !== 0) {
		process.stderr.write(`install: dependency install failed (exit ${code}); the patch entry was not touched\n`);
		process.exit(code);
	}
}

writeFileSync(patchPath, upsertBlock(readPatch(patchPath)));
process.stdout.write(`install: wrote the mobile-tweaks loader entry to ${patchPath}\n`);
process.stdout.write(`${JSON.stringify(statusFor(profileDir), null, 2)}\n`);
process.stdout.write(
	[
		"install: done.",
		"  The web profile reloads its patch layer live; confirm the running host with:",
		"    node scripts/status.mjs",
		`  If the stylesheet route stays 404, restart once: systemctl --user restart ${process.env.DSH_WEB_UNIT ?? "dsh-web"}`,
		"",
	].join("\n"),
);

if (options.restart) {
	process.exit(run("systemctl", ["--user", "restart", process.env.DSH_WEB_UNIT ?? "dsh-web"], { cwd: profileDir }));
}
