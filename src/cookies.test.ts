import { test } from 'node:test'
import assert from 'node:assert'
import { cookieHeaderFromSetCookie, mergeCookieHeader } from './cookies.ts'

// shaped exactly like what setSessionCookies emits for an NHI exchange
test('captures the session cookies and drops the deletions', () => {
  const header = cookieHeaderFromSetCookie([
    'id_token=eyJhbGciOi.eyJpZCI6; path=/; samesite=lax',
    'id_token_sign=SIGNATURE; path=/; expires=Thu, 10 Sep 2026 12:30:00 GMT; httponly',
    'id_token_org=myorg; path=/; samesite=lax',
    'id_token_dep=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'id_token_role=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ])
  assert.equal(header, 'id_token=eyJhbGciOi.eyJpZCI6; id_token_sign=SIGNATURE; id_token_org=myorg')
})

test('keeps a department and role when the exchange sets them', () => {
  const header = cookieHeaderFromSetCookie([
    'id_token=a.b; path=/',
    'id_token_dep=sales; path=/',
    'id_token_role=admin; path=/'
  ])
  assert.equal(header, 'id_token=a.b; id_token_dep=sales; id_token_role=admin')
})

test('merging preserves unrelated cookies already on the request', () => {
  assert.equal(
    mergeCookieHeader('theme_dark=1; i18n_lang=fr', 'id_token=a.b; id_token_org=myorg'),
    'theme_dark=1; i18n_lang=fr; id_token=a.b; id_token_org=myorg'
  )
})

test('merging overrides a stale session cookie the tool already had', () => {
  assert.equal(
    mergeCookieHeader('id_token=STALE; theme_dark=1', 'id_token=FRESH'),
    'theme_dark=1; id_token=FRESH'
  )
})

test('merging works with no existing cookie header', () => {
  assert.equal(mergeCookieHeader(undefined, 'id_token=a.b'), 'id_token=a.b')
})
