import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAllowedStudentEmail,
  isValidDob,
  isValidEmail,
  isValidOtpPurpose,
  isValidSignupRole,
} from './authSecurity';

test('student email policy allows Qatar and configured school domains', () => {
  assert.equal(isAllowedStudentEmail('student@example.qa'), true);
  assert.equal(isAllowedStudentEmail('student@abdn.ac.uk'), true);
  assert.equal(isAllowedStudentEmail('student@example.com'), false);
});

test('auth validation rejects malformed values', () => {
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidOtpPurpose('admin'), false);
  assert.equal(isValidSignupRole('admin'), false);
  assert.equal(isValidDob('2999-01-01'), false);
});
