/**
 * Marks an object as "claimed" and reports whether this call won the claim.
 */
const CLAIMED = Symbol('claimOnce');

export function claimOnce(target: object): boolean {
	const holder = target as Record<symbol, unknown>;
	if (holder[CLAIMED]) return false;
	holder[CLAIMED] = true;
	return true;
}
