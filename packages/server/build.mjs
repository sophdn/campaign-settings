/**
 * Bundle the server to a single `dist/server.mjs` for the production image.
 *
 * Why a bundle rather than `node --import tsx src/main.ts` (what DEPLOY.md's
 * private/systemd deploy uses): the container would otherwise have to carry tsx
 * plus the whole pnpm `node_modules` tree, which on a CX22-class box is a large
 * dependency surface shipped into production for no runtime gain. One file has
 * no resolution story to get wrong and nothing on disk that is not reachable.
 *
 * Two things this has to get right, both learned by running the output rather
 * than by reading it:
 *
 *  - **The `createRequire` banner is load-bearing.** `pg` is CommonJS and calls
 *    `require('events')`. esbuild's ESM output rewrites that to a `__require`
 *    shim which throws unless a real `require` is in scope, so without the
 *    banner the bundle builds clean and dies on its first database connection.
 *    Format has to stay ESM: `main.ts` uses top-level await.
 *  - **`pg-native` stays external.** It is an optional native binding `pg`
 *    probes for and does not need; bundling it would make an optional
 *    dependency a hard one.
 *
 * Migrations need no special handling — `db/migrations/index.ts` imports them
 * statically, so they land in the bundle like any other module. A provider that
 * globbed the filesystem would not have.
 */
import { build } from 'esbuild'

/**
 * TWO entry points, and the second is not optional.
 *
 * `create-account.mts` is how the first owner account comes into existence, and
 * the runtime image has no source, no pnpm and no tsx to run it the way
 * DEPLOY.md §5 does. Without it bundled alongside the server, a freshly
 * deployed public stack has no way to make its own first account short of
 * opening public signup — which is a gate you would then have to remember to
 * close again.
 */
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['pg-native'],
  banner: {
    js: [
      "import { createRequire as __esbuildCreateRequire } from 'node:module'",
      'const require = __esbuildCreateRequire(import.meta.url)',
    ].join('\n'),
  },
  logLevel: 'warning',
}

await build({ ...shared, entryPoints: ['src/main.ts'], outfile: 'dist/server.mjs' })
await build({
  ...shared,
  entryPoints: ['scripts/create-account.mts'],
  outfile: 'dist/create-account.mjs',
})
