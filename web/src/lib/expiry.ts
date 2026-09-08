import { daysUntil } from './format'

export type ExpiryBucket = 'expired' | 'd30' | 'd60' | 'd90' | 'd180' | 'ok'

/**
 * Buckets are store-configurable (stores.near_expiry_buckets); these are the
 * seeded defaults. The 180 bucket means "still returnable to the supplier" —
 * see tokens.css for why it is deliberately not a danger hue.
 */
export function expiryBucket(expiryIso: string, today: Date): ExpiryBucket {
  const d = daysUntil(expiryIso, today)
  if (d < 0) return 'expired'
  if (d <= 30) return 'd30'
  if (d <= 60) return 'd60'
  if (d <= 90) return 'd90'
  if (d <= 180) return 'd180'
  return 'ok'
}

export const EXPIRY_LABEL: Record<ExpiryBucket, string> = {
  expired: 'Expired',
  d30: '≤30 days',
  d60: '≤60 days',
  d90: '≤90 days',
  d180: 'Returnable',
  ok: 'In date',
}
