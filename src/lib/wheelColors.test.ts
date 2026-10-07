/**
 * B69: a custom category hashed onto a built-in's colour ('Travel' drew in
 * Dining's colour beside Dining). Built-ins keep their token; each custom slice
 * takes a colour no other visible slice uses. Names are invented.
 */
import { describe, expect, it } from 'vitest'
import { assignColors } from './wheelColors'

const s = (key: string, name: string) => ({ key, name })

describe('assignColors', () => {
  it('built-ins keep their own token', () => {
    const c = assignColors([s('2', 'Dining'), s('1', 'Groceries'), s('9', 'Other')])
    expect(c.get('2')).toBe('var(--cat-dining)')
    expect(c.get('1')).toBe('var(--cat-groceries)')
    expect(c.get('9')).toBe('var(--cat-other)')
  })

  it('a custom slice next to a built-in gets a different colour', () => {
    const c = assignColors([s('2', 'Dining'), s('30', 'Travel')])
    expect(c.get('30')).not.toBe(c.get('2'))
    expect(c.get('30')).toMatch(/^var\(--cat-/)
  })

  it('two custom slices never share a colour', () => {
    const c = assignColors([s('31', 'Pets'), s('32', 'Coffee'), s('33', 'Kids'), s('34', 'Cats')])
    const colours = [...c.values()]
    expect(new Set(colours).size).toBe(colours.length)
  })

  it('a custom colour does not change with spend order', () => {
    const a = assignColors([s('2', 'Dining'), s('31', 'Pets'), s('32', 'Coffee')])
    const b = assignColors([s('32', 'Coffee'), s('31', 'Pets'), s('2', 'Dining')])
    expect(b.get('31')).toBe(a.get('31'))
    expect(b.get('32')).toBe(a.get('32'))
  })

  it('Uncategorized is hatched and takes no colour', () => {
    const c = assignColors([s('uncat', 'Uncategorized')])
    expect(c.has('uncat')).toBe(false)
  })

  it('with every colour taken by a built-in, a custom slice falls back to the pattern', () => {
    const builtins = ['Rent', 'Groceries', 'Dining', 'Transport', 'Subscriptions', 'Health', 'Shopping', 'Fun']
    const c = assignColors([...builtins.map((n, i) => s(String(i + 1), n)), s('40', 'Travel')])
    expect(c.get('40')).toBeNull()
    expect(new Set(builtins.map((_, i) => c.get(String(i + 1)))).size).toBe(8)
  })
})
