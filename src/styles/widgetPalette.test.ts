/**
 * The widgets are Swift, so they cannot read the tokens. This holds their colours to
 * the web app's, in both themes, so a change to one shows up as a failure here.
 */
import { describe, expect, it } from 'vitest'
import palette from '../../ios/Widgets/Palette.swift?raw'
import tokens from './tokens.css?raw'

function block(selector: string): string {
  const start = tokens.indexOf(selector)
  expect(start).toBeGreaterThan(-1)
  return tokens.slice(start, tokens.indexOf('}', start))
}

const dark = block(":root[data-theme='dark']")
const light = block(":root[data-theme='light']")
const paper = dark.match(/--paper:\s*(#\w{6})/)![1]

function token(css: string, name: string): string {
  const value = css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim()
  if (!value) return token(dark, name)
  return (value === 'var(--paper)' ? paper : value).toUpperCase()
}

function swift(name: string): { dark: string; light: string } {
  const m = palette.match(new RegExp(`static let ${name} = color\\(dark: 0x(\\w{6}), light: 0x(\\w{6})\\)`))
  expect(m, name).not.toBeNull()
  return { dark: `#${m![1]}`, light: `#${m![2]}` }
}

describe('The widgets wear the tokens', () => {
  const pairs: [string, string][] = [
    ['canvas', 'bg'],
    ['text1', 'text-1'],
    ['text2', 'text-2'],
    ['text3', 'text-3'],
    ['ok', 'ok'],
    ['near', 'near'],
    ['nearMark', 'near-mark'],
    ['over', 'over'],
    ['overMark', 'over-mark'],
  ]

  it.each(pairs)('%s is --%s', (name, css) => {
    expect(swift(name)).toEqual({ dark: token(dark, css), light: token(light, css) })
  })
})
