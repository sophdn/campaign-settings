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

/**
 * The body of the `@media` block whose condition matches, with braces balanced.
 *
 * A non-greedy regex stops at the first `}` inside the block, which is the end
 * of its FIRST rule rather than the end of the query — so it reports an empty
 * body for every rule after the first and the assertion passes for the wrong
 * reason.
 */
function mediaBlock(sheet: string, condition: string): string {
  const start = sheet.indexOf(`@media ${condition} {`)
  if (start < 0) return ''
  let depth = 0
  for (let i = sheet.indexOf('{', start); i < sheet.length; i += 1) {
    if (sheet[i] === '{') depth += 1
    else if (sheet[i] === '}') {
      depth -= 1
      if (depth === 0) return sheet.slice(start, i)
    }
  }
  return ''
}

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

  /**
   * THE invariant, carried forward from the guard this replaces.
   *
   * Regression, and the reason any guard exists here at all: the rail used to
   * collapse to a stacked single column below 600px, which put a full-height
   * list of links above every screen — tapping an entity kind looked like it
   * did nothing until you scrolled past the nav. The fix at the time was to
   * narrow the rail instead, and the guard was "nothing may reassign .world's
   * columns".
   *
   * That guard is retired, deliberately: the nav is a DRAWER on a phone now, so
   * the grid genuinely does change at the breakpoint. What must still never
   * happen is the original failure — the nav displacing the content downward.
   * So the invariant is stated directly instead: every column template .world
   * is ever given names TWO tracks, which is what keeps the nav (or the
   * hamburger that replaces it) beside the content rather than above it.
   */
  it('never displaces the content column with the nav, at any width', () => {
    const templates = [...css.matchAll(/\.world\s*\{[^}]*?grid-template-columns:\s*([^;]+);/g)]
    expect(templates.length).toBeGreaterThan(0)
    for (const [, value] of templates) {
      // Two tracks, always. A single-track template is exactly what puts the
      // nav on its own row above the screen you navigated to.
      expect((value ?? '').trim().split(/\s+(?![^(]*\))/)).toHaveLength(2)
    }
    // And nothing gives it explicit rows, which would be the other way to
    // arrive at the same stacked layout.
    expect(css).not.toMatch(/\.world\s*\{[^}]*grid-template-rows/)
  })

  // Below the breakpoint the rail is GONE rather than narrowed: a permanently
  // visible column steals width from exactly the screens with least of it.
  it('hides the rail on a phone and offers the hamburger instead', () => {
    const phone = mediaBlock(css, '(max-width: 30rem)')
    expect(phone).not.toBe('')
    expect(ruleIn(phone, '.world-nav')).toMatch(/display:\s*none/)
    expect(ruleIn(phone, '.world-nav-toggle')).toMatch(/display:\s*block/)
    // ONE breakpoint in the whole stylesheet: two blocks at the same width is
    // two places to keep in step.
    expect(css.match(/@media \(max-width: 30rem\)/g)).toHaveLength(1)
    // The toggle is hidden by DEFAULT, so a desktop never shows both.
    expect(rule('.world-nav-toggle')).toMatch(/display:\s*none/)
  })

  // The drawer is the shared modal surface with a different shape, not a second
  // overlay: full height, anchored right, and scrolling on its own.
  it('anchors the drawer to the right edge and lets it scroll', () => {
    const drawer = rule('.modal-drawer')
    expect(drawer).toMatch(/margin-left:\s*auto/)
    expect(drawer).toMatch(/height:\s*100%/)
    expect(drawer).toMatch(/overflow-y:\s*auto/)
    // The scrim's gutter keeps a CENTRED dialog off the viewport edges; a
    // drawer enters FROM one, so an overlay holding one gives that gutter up.
    expect(rule('.modal-overlay:has(.modal-drawer)')).toMatch(/padding:\s*0/)
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

describe('secondary sections and inline reference rows', () => {
  // The app has ONE disclosure idiom: <details>/<summary>. .nav-tier and
  // .imported-metadata were the first two; .accordion is the third use of the
  // same mechanism rather than a second mechanism to keep in step.
  it('clears the native details marker so one caret rule serves every engine', () => {
    expect(rule('.accordion > summary')).toMatch(/list-style:\s*none/)
    expect(rule('.accordion > summary::-webkit-details-marker')).toMatch(/display:\s*none/)
    expect(rule('.accordion > summary::before')).toMatch(/content:/)
  })

  it('keeps the folded heading a heading, with no margin of its own', () => {
    expect(rule('.accordion > summary h3')).toMatch(/margin:\s*0/)
  })

  // An inline reference list is not a browse grid. A row carries a rule and a
  // hover state and nothing else; the wiki index keeps its cards.
  it('draws a dividing rule under each reference row and lights it on hover', () => {
    expect(rule('.entity-row')).toMatch(/border-bottom:\s*\d.*solid/)
    expect(rule('.entity-row:hover')).toMatch(/background:/)
  })

  // The rows carry their own separation, so a gap between them would read as
  // two separations rather than one.
  it('drops the base list gap for a row list, since the rows divide themselves', () => {
    expect(rule('.entity-rows')).toMatch(/gap:\s*0/)
  })

  // Regression: the change-type button sat UNDER its dropdown because a field
  // wrapper is a full-width flex COLUMN, which made the button the column's
  // next row. This is the row that puts them on one line.
  it('lays a control and its button on one line, letting the control take the slack', () => {
    const inline = rule('.inline-control')
    expect(inline).toMatch(/display:\s*flex/)
    expect(inline).toMatch(/flex-wrap:\s*wrap/) // never widens a phone-width page
    expect(rule('.inline-control > :first-child')).toMatch(/flex:\s*1/)
    expect(rule('.inline-control > .btn')).toMatch(/flex:\s*none/)
  })

  // `.panel` sets `max-width: none`, which is right for prose and wrong for a
  // form: a 60rem text input is harder to use than a 34rem one, and a stretched
  // row of controls puts a label and its value at opposite ends of the screen.
  it('bounds a form’s measure rather than letting it span the content column', () => {
    expect(rule('.form-card,\n.bounded-form')).toMatch(/max-width:\s*\d/)
  })
})

describe('the entity avatar stylesheet', () => {
  // A CIRCLE for every kind (Sophi, 2026-08-21). Shape-per-kind is a later
  // change; recording the decision here means the crop reads as a choice.
  it('draws the avatar as a filled circle rather than a letterboxed frame', () => {
    const image = rule('.entity-avatar-image')
    expect(image).toMatch(/border-radius:\s*var\(--radius-pill\)/)
    // `cover`, not `contain`: a letterboxed circle reads as a rendering fault.
    expect(image).toMatch(/object-fit:\s*cover/)
  })

  it('anchors the plus to the disc, which is why the avatar is a positioning context', () => {
    expect(rule('.entity-avatar')).toMatch(/position:\s*relative/)
    expect(rule('.entity-avatar-add')).toMatch(/position:\s*absolute/)
  })

  // The file input is taken out of the FLOW, not out of the tab order.
  // `display: none` would make the control unreachable from a keyboard.
  it('hides the file input without removing it from the tab order', () => {
    const input = rule('.entity-avatar-add input')
    expect(input).toMatch(/opacity:\s*0/)
    expect(input).not.toMatch(/display:\s*none/)
    expect(input).not.toMatch(/visibility:\s*hidden/)
  })

  it('keeps a focus-visible affordance on the plus, since its input is invisible', () => {
    expect(rule('.entity-avatar-add:hover,\n.entity-avatar-add:focus-within')).toMatch(
      /border-color:/,
    )
  })
})
