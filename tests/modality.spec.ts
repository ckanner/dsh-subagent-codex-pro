/**
 * When this plugin withholds an image.
 *
 * The rule is the harness's own, and getting it wrong is not cosmetic: the first
 * version failed closed, so a session whose route could not be resolved was told
 * "image not delivered" about screenshots it could have displayed. The default
 * `deepseek-flash` route declares `['text', 'image']`, which is exactly the case
 * that has to pass.
 *
 * @module dsh-subagent-codex-pro/tests/modality
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const { routeRefusesImages, withImageNote, checkedWorkdir, checkedImagePath } = await import('../src/index.ts')

test('the default route declares image input and is not refused', () => {
  assert.equal(routeRefusesImages({ inputModalities: ['text', 'image'] }), false)
})

test('a route that declares only text is refused', () => {
  assert.equal(routeRefusesImages({ inputModalities: ['text'] }), true)
})

test('an undeclared route is left to the harness, not refused here', () => {
  assert.equal(routeRefusesImages({}), false)
  assert.equal(routeRefusesImages(undefined), false)
})

test('a declared list without image is the only refusal', () => {
  assert.equal(routeRefusesImages({ inputModalities: [] }), true)
  assert.equal(routeRefusesImages({ inputModalities: ['text'] }), true)
  // An unrelated modality is still a declaration that excludes image.
  assert.equal(routeRefusesImages({ inputModalities: ['text', 'audio'] }), true)
})

test('an image line names each image, because a background call reads only text', () => {
  assert.equal(withImageNote('answer', [{ path: '/tmp/a.png' }]), 'answer\n\n[1 image: /tmp/a.png]')
  assert.equal(
    withImageNote('answer', [{ path: '/tmp/a.png' }, { path: '/tmp/b.png' }]),
    'answer\n\n[2 images: /tmp/a.png, /tmp/b.png]',
  )
})

test('an image with no host path is still counted', () => {
  // An MCP screenshot arrives as bytes, so there is no path to name.
  assert.equal(withImageNote('answer', [{ data: 'AAAA' }]), 'answer\n\n[1 image]')
  assert.equal(withImageNote('answer', []), 'answer')
})

test('a caller-named working directory must be absolute', () => {
  assert.equal(checkedWorkdir('/tmp/smoke'), '/tmp/smoke')
  assert.throws(() => checkedWorkdir('smoke'), /absolute path/)
  assert.throws(() => checkedWorkdir('./smoke'), /absolute path/)
  assert.throws(() => checkedWorkdir('~/smoke'), /absolute path/)
  assert.throws(() => checkedWorkdir('   '), /must not be empty/)
})

test('a caller-named image path must be absolute', () => {
  assert.equal(checkedImagePath('/tmp/shot.png'), '/tmp/shot.png')
  assert.throws(() => checkedImagePath('shot.png'), /must be absolute/)
  assert.throws(() => checkedImagePath('./shot.png'), /must be absolute/)
  assert.throws(() => checkedImagePath('  '), /must not be empty/)
})
