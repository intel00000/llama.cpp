import { describe, it, expect } from 'vitest';
import { classifyStopSignal } from '$lib/utils/stop-signal';

/**
 * The classifier must tell context exhaustion (needs compaction recovery) apart
 * from the benign reasons the server also reports as finish_reason "length".
 */
describe('classifyStopSignal', () => {
	const N_CTX = 8192;

	it('non-length reasons are complete', () => {
		expect(classifyStopSignal({ finishReason: 'stop' })).toBe('complete');
		expect(classifyStopSignal({ finishReason: 'tool_calls' })).toBe('complete');
		expect(classifyStopSignal({ finishReason: null })).toBe('complete');
		expect(classifyStopSignal({ finishReason: undefined })).toBe('complete');
	});

	it('length with occupancy at n_ctx is context exhaustion', () => {
		expect(
			classifyStopSignal({
				finishReason: 'length',
				timings: { prompt_n: 8000, cache_n: 180, predicted_n: 10 },
				nCtx: N_CTX
			})
		).toBe('context-exhausted');
	});

	it('length at the user max_tokens with headroom is an output budget stop', () => {
		expect(
			classifyStopSignal({
				finishReason: 'length',
				timings: { prompt_n: 1500, cache_n: 0, predicted_n: 256 },
				nCtx: N_CTX,
				maxTokens: 256
			})
		).toBe('output-budget');
	});

	it('context exhaustion wins when both the budget and n_ctx are hit', () => {
		// max_tokens reached AND the KV is full: the next send overflows regardless.
		expect(
			classifyStopSignal({
				finishReason: 'length',
				timings: { prompt_n: 8100, cache_n: 0, predicted_n: 90 },
				nCtx: N_CTX,
				maxTokens: 90
			})
		).toBe('context-exhausted');
	});

	it('speculative overshoot past max_tokens still reads as budget', () => {
		expect(
			classifyStopSignal({
				finishReason: 'length',
				timings: { prompt_n: 1000, cache_n: 0, predicted_n: 259 },
				nCtx: N_CTX,
				maxTokens: 256
			})
		).toBe('output-budget');
	});

	it('the slack boundary is inclusive', () => {
		const slack = Math.max(32, Math.ceil(N_CTX * 0.002)); // 32
		const atEdge = { prompt_n: N_CTX - slack, cache_n: 0, predicted_n: 0 };
		const belowEdge = { prompt_n: N_CTX - slack - 1, cache_n: 0, predicted_n: 0 };
		expect(classifyStopSignal({ finishReason: 'length', timings: atEdge, nCtx: N_CTX })).toBe(
			'context-exhausted'
		);
		expect(classifyStopSignal({ finishReason: 'length', timings: belowEdge, nCtx: N_CTX })).toBe(
			'unknown'
		);
	});

	it('length with no context or budget explanation is unknown', () => {
		expect(
			classifyStopSignal({
				finishReason: 'length',
				timings: { prompt_n: 1000, cache_n: 0, predicted_n: 40 },
				nCtx: N_CTX
			})
		).toBe('unknown');
		expect(classifyStopSignal({ finishReason: 'length', timings: { predicted_n: 40 } })).toBe(
			'unknown'
		);
	});
});
