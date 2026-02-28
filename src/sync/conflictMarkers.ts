export type ConflictResolveStrategy = 'local-first' | 'remote-first';

export interface ConflictMarkerAnalysis {
	conflictCount: number;
	hasConflictMarkers: boolean;
	hasUnbalancedMarkers: boolean;
	firstMarkerLine: number | null;
}

export interface ConflictResolveResult {
	content: string;
	resolvedCount: number;
}

const START_MARKER = /^<{7}(?: .*)?$/u;
const SEPARATOR_MARKER = /^={7}$/u;
const END_MARKER = /^>{7}(?: .*)?$/u;

function normalizeMarkerLine(line: string): string {
	return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function markerType(line: string): 'start' | 'separator' | 'end' | null {
	if (START_MARKER.test(line)) {
		return 'start';
	}
	if (SEPARATOR_MARKER.test(line)) {
		return 'separator';
	}
	if (END_MARKER.test(line)) {
		return 'end';
	}
	return null;
}

export function analyzeConflictMarkers(content: string): ConflictMarkerAnalysis {
	const lines = content.split('\n');
	let state: 'normal' | 'local' | 'remote' = 'normal';
	let conflictCount = 0;
	let hasUnbalancedMarkers = false;
	let firstMarkerLine: number | null = null;

	for (const [index, rawLine] of lines.entries()) {
		const type = markerType(normalizeMarkerLine(rawLine));
		if (type && firstMarkerLine === null) {
			firstMarkerLine = index + 1;
		}

		if (state === 'normal') {
			if (type === 'start') {
				state = 'local';
				continue;
			}
			if (type === 'separator' || type === 'end') {
				hasUnbalancedMarkers = true;
			}
			continue;
		}

		if (state === 'local') {
			if (type === 'separator') {
				state = 'remote';
				continue;
			}
			if (type === 'start' || type === 'end') {
				hasUnbalancedMarkers = true;
			}
			continue;
		}

		if (type === 'end') {
			conflictCount += 1;
			state = 'normal';
			continue;
		}
		if (type === 'start' || type === 'separator') {
			hasUnbalancedMarkers = true;
		}
	}

	if (state !== 'normal') {
		hasUnbalancedMarkers = true;
	}

	return {
		conflictCount,
		hasConflictMarkers: firstMarkerLine !== null,
		hasUnbalancedMarkers,
		firstMarkerLine,
	};
}

export function resolveConflictMarkers(content: string, strategy: ConflictResolveStrategy): ConflictResolveResult {
	const lines = content.split('\n');
	let state: 'normal' | 'local' | 'remote' = 'normal';
	let resolvedCount = 0;
	const output: string[] = [];
	let localSection: string[] = [];
	let remoteSection: string[] = [];

	for (const [index, rawLine] of lines.entries()) {
		const type = markerType(normalizeMarkerLine(rawLine));

		if (state === 'normal') {
			if (type === 'start') {
				state = 'local';
				localSection = [];
				remoteSection = [];
				continue;
			}
			if (type === 'separator' || type === 'end') {
				throw new Error(`Unexpected conflict marker at line ${index + 1}.`);
			}
			output.push(rawLine);
			continue;
		}

		if (state === 'local') {
			if (type === 'separator') {
				state = 'remote';
				continue;
			}
			if (type === 'start' || type === 'end') {
				throw new Error(`Malformed conflict block near line ${index + 1}.`);
			}
			localSection.push(rawLine);
			continue;
		}

		if (type === 'end') {
			output.push(...(strategy === 'local-first' ? localSection : remoteSection));
			resolvedCount += 1;
			state = 'normal';
			continue;
		}
		if (type === 'start' || type === 'separator') {
			throw new Error(`Malformed conflict block near line ${index + 1}.`);
		}
		remoteSection.push(rawLine);
	}

	if (state !== 'normal') {
		throw new Error('Conflict markers are incomplete.');
	}

	return {
		content: output.join('\n'),
		resolvedCount,
	};
}
