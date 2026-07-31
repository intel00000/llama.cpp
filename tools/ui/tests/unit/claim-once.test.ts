import { describe, it, expect } from 'vitest';
import { claimOnce } from '$lib/utils/claim-once';

/**
 * claimOnce makes the same instance handled by exactly one of several callers.
 */
describe('claimOnce', () => {
	it('the first caller wins and every later caller loses', () => {
		const err = new Error('boom');
		expect(claimOnce(err)).toBe(true);
		expect(claimOnce(err)).toBe(false);
		expect(claimOnce(err)).toBe(false);
	});

	it('distinct instances claim independently', () => {
		const a = new Error('a');
		const b = new Error('b');
		expect(claimOnce(a)).toBe(true);
		expect(claimOnce(b)).toBe(true);
	});

	it('the mark does not serialize or enumerate', () => {
		const err = Object.assign(new Error('x'), { contextInfo: { n_ctx: 8 } });
		claimOnce(err);
		expect(Object.keys(err)).not.toContain('claimOnce');
		expect(JSON.stringify({ contextInfo: err.contextInfo })).toBe('{"contextInfo":{"n_ctx":8}}');
	});
});
