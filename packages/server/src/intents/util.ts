/** Runtime check: a whole number (slots, entity ids, job indexes, ...). */
export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}
