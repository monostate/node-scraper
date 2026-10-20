import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SENSITIVE_FIELD_RE, SENSITIVE_QUERY_KEYS,
  isSensitiveField, redactUrl, redactText, redactErrorMessage, redactValue,
} from '../redact.js';

describe('isSensitiveField', () => {
  it('treats password inputs as sensitive', () => assert.equal(isSensitiveField({ type: 'password' }), true));
  it('treats otp-named inputs as sensitive', () => assert.equal(isSensitiveField({ name: 'otp' }), true));
  it('treats one-time-code autocomplete as sensitive', () => assert.equal(isSensitiveField({ autocomplete: 'one-time-code' }), true));
  it('treats cc-number autocomplete as sensitive', () => assert.equal(isSensitiveField({ autocomplete: 'cc-number' }), true));
  it('treats labels mentioning secret as sensitive', () => assert.equal(isSensitiveField({ label: 'API secret' }), true));
  it('does not treat an email input as sensitive', () => assert.equal(isSensitiveField({ name: 'email', type: 'email' }), false));
  it('does not treat a plain text input with no hints as sensitive', () => assert.equal(isSensitiveField({ type: 'text', name: 'q' }), false));
  it('exports the regex and key list', () => {
    assert.ok(SENSITIVE_FIELD_RE instanceof RegExp);
    assert.ok(SENSITIVE_QUERY_KEYS.includes('token'));
  });
});

describe('redactUrl', () => {
  it('strips userinfo and masks sensitive query values', () => {
    assert.equal(redactUrl('https://u:p@x.com/a?token=abc&q=1'), 'https://x.com/a?token=%5Bredacted%5D&q=1');
  });
  it('is case-insensitive on query keys', () => {
    assert.equal(redactUrl('https://x.com/?API_KEY=K&Access_Token=T'), 'https://x.com/?API_KEY=%5Bredacted%5D&Access_Token=%5Bredacted%5D');
  });
  it('returns non-URLs unchanged', () => assert.equal(redactUrl('not a url'), 'not a url'));
  it('returns URLs without secrets unchanged', () => assert.equal(redactUrl('https://x.com/p?q=1'), 'https://x.com/p?q=1'));
});

describe('redactText / redactValue', () => {
  it('replaces text with a length marker', () => assert.equal(redactText('hunter2'), '[redacted 7 chars]'));
  it('redacts values of sensitive fields only', () => {
    assert.equal(redactValue('hunter2', { type: 'password' }), '[redacted 7 chars]');
    assert.equal(redactValue('bob', { name: 'username' }), 'bob');
  });
});

describe('redactErrorMessage', () => {
  it('masks URL secrets and key=value secrets', () => {
    const out = redactErrorMessage('fail at https://a.com/?key=K123 password=p4ss token=tok');
    assert.doesNotMatch(out, /K123/);
    assert.doesNotMatch(out, /p4ss/);
    assert.doesNotMatch(out, /tok\b/);
    assert.match(out, /fail at https:\/\/a\.com\//);
  });
  it('passes ordinary messages through', () => assert.equal(redactErrorMessage('Timeout after 5000ms'), 'Timeout after 5000ms'));
  it('handles non-string input', () => assert.equal(redactErrorMessage(undefined), ''));
});
