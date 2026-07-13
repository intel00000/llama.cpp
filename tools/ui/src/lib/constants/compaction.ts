/* Conversation auto-compaction constants. */
export const COMPACTION = {
	/** Occupancy (percent of n_ctx) at which auto-compaction triggers. */
	DEFAULT_THRESHOLD: 80,
	/** Recent context (percent of n_ctx) kept verbatim; older turns are folded. */
	DEFAULT_RETAIN: 20,
	/** Default cap on the recap summary's own generated length, in tokens. */
	DEFAULT_SUMMARY_MAX_TOKENS: 2048,
	/** Instruction used to summarize the folded turns. */
	DEFAULT_PROMPT:
		'You are compacting a long conversation to save context. Summarize everything above into a concise but complete recap that preserves all information needed to continue: decisions made, facts established, the user goals, open questions, identifiers/paths/code mentioned, and any state to remember. Write plain prose, third person, no preamble, and do not omit details needed to continue the task.'
} as const;
