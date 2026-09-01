'use strict';

/**
 * lib/soql.js
 * ---------------------------------------------------------------------------
 * Safe construction of SOQL string literals.
 *
 * The original exporter did this:
 *     options.connector.replaceAll(',', "','")   ->  WHERE Name IN ('abc','efg')
 *
 * That breaks (or worse, changes the query's meaning) as soon as a connector
 * name contains an apostrophe, a backslash, or a stray comma. "O'Brien Sync"
 * would terminate the literal early and turn the rest of the name into SOQL.
 *
 * Salesforce escapes reserved characters inside a string literal with a
 * backslash, so the order matters: backslashes first, then quotes.
 * ---------------------------------------------------------------------------
 */

// Control characters other than \t \n \r, plus DEL. These have no legitimate
// place in a connector name and are what makes escaping unreliable.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

class SoqlError extends Error {}

/**
 * Escape a value for use inside single quotes in a SOQL string literal.
 * Does NOT add the surrounding quotes -- see soqlLiteral().
 */
function escapeSoqlString(value) {
	if (typeof value !== 'string') {
		throw new SoqlError(`Expected a string SOQL literal, received ${typeof value}.`);
	}
	if (CONTROL_CHARS_RE.test(value)) {
		throw new SoqlError(`SOQL literal contains control characters: ${JSON.stringify(value)}`);
	}
	return value
		.replace(/\\/g, '\\\\') // must run first
		.replace(/'/g, "\\'")
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t');
}

/** Escape and wrap in single quotes: O'Brien -> 'O\'Brien' */
function soqlLiteral(value) {
	return `'${escapeSoqlString(value)}'`;
}

/**
 * Build the inside of an IN (...) clause from a list of strings.
 * Throws on an empty list -- `IN ()` is not valid SOQL, and silently emitting a
 * filter that matches nothing would be worse than failing loudly.
 */
function soqlStringList(values) {
	if (!Array.isArray(values) || values.length === 0) {
		throw new SoqlError('Cannot build an IN (...) clause from an empty list.');
	}
	return values.map(soqlLiteral).join(', ');
}

/**
 * Parse a `--connector` value into a clean list.
 * Accepts "abc" and "abc,efg" and "abc, efg ,". Empty segments are dropped.
 * Returns [] when nothing was supplied, which callers read as "no filter".
 */
function parseConnectorList(raw) {
	if (raw == null) return [];
	if (Array.isArray(raw)) {
		return raw.map((s) => String(s).trim()).filter(Boolean);
	}
	return String(raw)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Validate an sObject / field API name that will be interpolated into SOQL. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
function assertApiName(value, label = 'API name') {
	if (typeof value !== 'string' || !API_NAME_RE.test(value)) {
		throw new SoqlError(`${label} has an unexpected shape: ${JSON.stringify(value)}`);
	}
	return value;
}

/** Validate a relationship name (may end in __r). */
function assertRelationshipName(value, label = 'relationship name') {
	return assertApiName(value, label);
}

module.exports = {
	SoqlError,
	assertApiName,
	assertRelationshipName,
	escapeSoqlString,
	parseConnectorList,
	soqlLiteral,
	soqlStringList,
};
