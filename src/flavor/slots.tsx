import type { ReactNode } from 'react'

/**
 * Places the public build fills (scripts/flavor.ts swaps this module for
 * src/flavor/public/slots.tsx). Each one renders nothing here, so the personal
 * DOM is the same with or without them.
 */

/** First-run onboarding, over the app. Mounted in App after the sheets. */
export const FirstRun: (props: { onConnectBank: () => void }) => ReactNode = () => null
