/**
 * Classifies why a generation stream stopped, from the signals the client has:
 * the final chunk's `finish_reason`, its timings, the model's n_ctx, and the
 * request's own max_tokens.
 */

export type StopSignal =
	| 'complete' // EOS / stop word / tool_calls, or a normal end
	| 'context-exhausted' // blow n_ctx mid-generation - the reply is truncated
	| 'output-budget' // hit the request's max_tokens - benign, context has room
	| 'unknown'; // "length" with no explanation the client can see

interface StopTimings {
	prompt_n?: number;
	cache_n?: number;
	predicted_n?: number;
}

export interface StopSignalInput {
	finishReason?: string | null;
	timings?: StopTimings | null;
	nCtx?: number | null;
	maxTokens?: number | null;
}

export function classifyStopSignal(input: StopSignalInput): StopSignal {
	if (input.finishReason !== 'length') return 'complete';

	const timings = input.timings;
	const predicted = timings?.predicted_n ?? 0;

	// Context exhaustion first: occupancy within slack of n_ctx means the turn was
	// cut by a full KV cache. Slack absorbs timing-field drift and speculative
	// draft headroom so a genuine budget stop below the cap is not misread.
	const nCtx = input.nCtx;
	if (typeof nCtx === 'number' && nCtx > 0 && timings) {
		const occupancy = (timings.cache_n ?? 0) + (timings.prompt_n ?? 0) + predicted;
		const slack = Math.max(32, Math.ceil(nCtx * 0.002));
		if (occupancy >= nCtx - slack) return 'context-exhausted';
	}

	// The user's own max_tokens cap (>= because speculative decoding can overshoot).
	const maxTokens = input.maxTokens;
	if (typeof maxTokens === 'number' && maxTokens > 0 && predicted >= maxTokens) {
		return 'output-budget';
	}

	return 'unknown';
}
