/**
 * Query keys in one place so an invalidation can never miss a consumer.
 * Stock changes on every sale, so `stock` is the key everything batch-shaped
 * hangs off and posting a sale invalidates exactly that subtree.
 */
export const qk = {
  store: ['store'] as const,
  search: (term: string) => ['search', term] as const,
  batches: (medicineId: number) => ['stock', 'batches', medicineId] as const,
  stock: ['stock'] as const,
  quote: (fingerprint: string) => ['quote', fingerprint] as const,
  customers: (term: string) => ['customers', term] as const,
  held: ['held'] as const,
  invoice: (id: number) => ['invoice', id] as const,
}
