import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The stylesheet lives at <web-pkg>/src/styles/app.css. process.cwd() is the
// web package dir under the per-package runner but the repo root under the
// aggregate `test:cov` runner, so try both anchors. (jsdom rewrites
// import.meta.url to a non-file URL, so it can't anchor this.)
function read(relPath: string): string {
  const found = [relPath, join('packages/web', relPath)]
    .map((p) => join(process.cwd(), p))
    .find(existsSync)
  return found ? readFileSync(found, 'utf8') : ''
}

const css = read('src/styles/app.css')
const tokensCss = read('src/theme/tokens.css')

/**
 * The declarations of every `selector { ... }` block for `selector`, joined.
 * All blocks rather than the first: a base element like `body` is declared more
 * than once (the shared reset, then the app's own typography), and which block
 * a given property lands in is not what these tests are about.
 */
function ruleIn(sheet: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const blocks = [...sheet.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
  return blocks.map((m) => m[1] ?? '').join('\n')
}

const rule = (selector: string): string => ruleIn(css, selector)

describe('world nav rail stylesheet', () => {
  // Regression: tier links are default-inline <a>; without an explicit block
  // they flow horizontally inside the collapsible <details> tier and overflow
  // the fixed-width rail, overlapping page content.
  it('renders the collapsible-tier links as block so they stack within the rail', () => {
    expect(rule('.nav-tier a')).toMatch(/display:\s*block/)
  })

  it('draws an indenting solid left rule beside the tier links', () => {
    const links = rule('.nav-tier-links')
    expect(links).toMatch(/border-left:\s*\d.*solid/)
    expect(links).toMatch(/padding-left:/) // items sit inboard of the rule
  })

  it('keeps the nav rail in its own grid column beside the content', () => {
    expect(rule('.world')).toMatch(/grid-template-columns:\s*var\(--rail-width\)\s+1fr/)
  })

  // Regression: the rail used to collapse to a stacked single column below
  // 600px, which put a full-height list of links above every screen — tapping
  // an entity kind looked like it did nothing until you scrolled past the nav.
  // The rail narrows instead, so nothing may reassign .world's columns.
  it('never re-stacks the rail above the content at any width', () => {
    expect(css).not.toMatch(/@media[^{]*\{[^}]*\.world\s*\{[^}]*grid-template-columns/)
  })

  // Regression: the content column is a grid item, so it defaults to
  // `min-width: auto` and refuses to shrink below the widest unbreakable thing
  // inside it. One long URL in an entity body widened the track, the grid and
  // the document, leaving the viewport-width header short of the page's right
  // edge. Verified end to end in e2e/specs/responsive.spec.ts.
  it('lets the content column shrink below its content, so long text cannot widen the page', () => {
    expect(rule('.world-content')).toMatch(/min-width:\s*0/)
  })
})

describe('fluid shell metrics', () => {
  // The shell's two size-dependent measurements are tokens, so the header, the
  // page body and the rail cannot drift apart, and there is no media query to
  // keep in sync with them.
  it('defines the gutter, rail width and rail font as viewport-fluid clamps', () => {
    for (const token of ['--gutter', '--rail-width', '--rail-font']) {
      // `[^;]*` rather than `[^)]*`: the clamp bounds are themselves var() calls.
      expect(tokensCss).toMatch(new RegExp(`${token}:\\s*clamp\\([^;]*vw`))
    }
  })

  it('spends the same gutter on the header and the page body, so they share a left edge', () => {
    expect(rule('.app-header')).toMatch(/padding:[^;]*var\(--gutter\)/)
    expect(rule('.app-main')).toMatch(/padding:\s*var\(--gutter\)/)
  })

  // `anywhere`, not `break-word`: only `anywhere` also shrinks min-content
  // width, which is what stops a long word from forcing a track wider than the
  // viewport. On body rather than the app shell so the signed-out pages
  // (login, invite, the legal pages) inherit it too.
  it('breaks overlong user-authored strings rather than letting them widen the page', () => {
    expect(ruleIn(tokensCss, 'body')).toMatch(/overflow-wrap:\s*anywhere/)
  })

  // A text input defaults to ~20 characters wide and a file input to its button
  // plus filename; as flex items that intrinsic width is a floor, and one
  // control is enough to push a phone-width page into horizontal scrolling.
  it('lets form controls shrink to their container instead of setting a width floor', () => {
    const controls = rule('input,\ntextarea,\nselect')
    expect(controls).toMatch(/min-width:\s*0/)
    expect(controls).toMatch(/max-width:\s*100%/)
  })
})

describe('shared panel stylesheet', () => {
  // The single layout primitive: every page panel (read views + forms) is
  // full-width with padding, overriding the narrow default form max-width. This
  // is the one place the full-width treatment is asserted.
  it('renders the shared .panel full-width with padding', () => {
    const panel = rule('.panel')
    expect(panel).toMatch(/width:\s*100%/)
    expect(panel).toMatch(/max-width:\s*none/)
    expect(panel).toMatch(/padding:/)
  })
})

describe('modal stylesheet', () => {
  it('overlays a fixed full-screen scrim that centers the dialog', () => {
    const overlay = rule('.modal-overlay')
    expect(overlay).toMatch(/position:\s*fixed/)
    expect(overlay).toMatch(/inset:\s*0/)
    expect(overlay).toMatch(/justify-content:\s*center/)
  })

  it('constrains the dialog to an elevated, max-width surface', () => {
    const dialog = rule('.modal-dialog')
    expect(dialog).toMatch(/max-width:/)
    expect(dialog).toMatch(/background:/)
  })
})

describe('bracket picker stylesheet', () => {
  // Regression: the picker wraps its textarea in a div, which took the field out
  // of the `label` flex column that had been stretching it to full width. As a
  // block container the textarea fell back to its intrinsic `cols` width — a
  // ~20-character box for a paragraph field. A flex column restores the stretch
  // with the same mechanism a plain `label` wrapper uses, rather than a
  // `width: 100%` that has to be kept in step with the field's own padding.
  it('stretches the field to full width via a flex column, not a percentage width', () => {
    const picker = rule('.bracket-picker')
    expect(picker).toMatch(/display:\s*flex/)
    expect(picker).toMatch(/flex-direction:\s*column/)
  })

  it('keeps the picker a positioning context for its suggestion list', () => {
    expect(rule('.bracket-picker')).toMatch(/position:\s*relative/)
    expect(rule('.bracket-suggestions')).toMatch(/position:\s*absolute/)
  })
})
