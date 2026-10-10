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

const { routeRefusesImages } = await import('../src/index.ts')

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
