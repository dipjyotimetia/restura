/**
 * Feature manifest for the AI chat. Kept minimal — there's no protocol-style
 * RequestSpec here because chat sends are owned by the store's actions, not
 * the protocol layer.
 */
export const AI_FEATURE_ID = 'ai' as const;
