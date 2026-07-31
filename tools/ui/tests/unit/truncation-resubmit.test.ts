import { describe, it, expect } from 'vitest';
import { chooseTruncationResubmit } from '$lib/utils/stop-signal';

/**
 * After a turn is cut off by a full context, the resubmit primitive depends on
 * where the cut landed: a prefill the server can extend (continue) vs a new
 * generation on the folded context (regenerate).
 */
describe('chooseTruncationResubmit', () => {
	it('visible content continues as a prefill', () => {
		expect(chooseTruncationResubmit({ content: 'partial answer' })).toBe('continue');
	});

	it('reasoning-only continues when the reasoning is sent back', () => {
		expect(chooseTruncationResubmit({ content: '', reasoningContent: 'still thinking' })).toBe(
			'continue'
		);
	});

	it('reasoning-only regenerates when reasoning is excluded from context', () => {
		// The server would render no assistant header and continue would restart new
		// onto the dead partial - regenerate on the folded context instead.
		expect(
			chooseTruncationResubmit({
				content: '',
				reasoningContent: 'still thinking',
				excludeReasoning: true
			})
		).toBe('regenerate');
	});

	it('a cut inside tool-call arguments cannot be continued', () => {
		expect(chooseTruncationResubmit({ content: '', toolCalls: '[{"name":"x","arg' })).toBe(
			'regenerate'
		);
	});

	it('visible content wins over a trailing tool call', () => {
		expect(chooseTruncationResubmit({ content: 'here', toolCalls: '[{"name":"x"}]' })).toBe(
			'continue'
		);
	});

	it('an empty turn regenerates', () => {
		expect(chooseTruncationResubmit({ content: '', reasoningContent: '' })).toBe('regenerate');
		expect(chooseTruncationResubmit({})).toBe('regenerate');
	});
});
