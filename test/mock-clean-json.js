#!/usr/bin/env node
'use strict';
/**
 * Stand-in for the project's real clean-json.js, implementing the contract the
 * exporter depends on:  node clean-json.js <directory> <comma,separated,fields>
 * Used only by the test harness. Your real clean-json.js replaces it.
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const fields = new Set((process.argv[3] || '').split(',').map((s) => s.trim()).filter(Boolean));

if (!dir || !fs.existsSync(dir)) {
	process.stderr.write(`clean-json: directory not found: ${dir}\n`);
	process.exit(1);
}
if (process.env.MOCK_CLEAN_FAIL === '1') {
	process.stderr.write('clean-json: simulated failure\n');
	process.exit(1);
}

const strip = (node) => {
	if (Array.isArray(node)) return node.map(strip);
	if (node && typeof node === 'object') {
		const out = {};
		for (const [k, v] of Object.entries(node)) {
			if (fields.has(k)) continue;
			out[k] = strip(v);
		}
		return out;
	}
	return node;
};

let n = 0;
for (const f of fs.readdirSync(dir)) {
	if (!f.toLowerCase().endsWith('.json')) continue;
	if (f === '_export-summary.json') continue;
	const p = path.join(dir, f);
	try {
		fs.writeFileSync(p, JSON.stringify(strip(JSON.parse(fs.readFileSync(p, 'utf8'))), null, 2));
		n += 1;
	} catch (_) {
		/* skip non-JSON */
	}
}
process.stdout.write(`clean-json: cleaned ${n} file(s) in ${dir}\n`);
process.exit(0);
