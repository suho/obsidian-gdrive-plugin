import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function readJson(filePath) {
	return JSON.parse(readFileSync(filePath, 'utf8'));
}

function runGit(args) {
	execFileSync('git', args, { stdio: 'inherit' });
}

function main() {
	const cwd = process.cwd();
	const targets = [
		{ name: 'package.json', path: path.join(cwd, 'package.json') },
		{ name: 'manifest.json', path: path.join(cwd, 'manifest.json') },
		{ name: 'manifest-beta.json', path: path.join(cwd, 'manifest-beta.json') },
	];

	const versions = targets.map((target) => {
		const value = String(readJson(target.path).version ?? '');
		return { ...target, version: value };
	});

	for (const entry of versions) {
		if (!SEMVER_RE.test(entry.version)) {
			throw new Error(`${entry.name} has invalid version "${entry.version}". Expected x.y.z`);
		}
	}

	const [first, ...rest] = versions;
	const mismatches = rest.filter((entry) => entry.version !== first.version);
	if (mismatches.length > 0) {
		console.error('Version mismatch detected. No tag was created.');
		for (const entry of versions) {
			console.error(`- ${entry.name}: ${entry.version}`);
		}
		process.exitCode = 1;
		return;
	}

	const version = first.version;

	console.log(`Creating git tag ${version}`);
	runGit(['tag', version]);

	console.log(`Pushing git tag ${version} to origin`);
	runGit(['push', 'origin', version]);

	console.log(`Done: pushed tag ${version}`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
