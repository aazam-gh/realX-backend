import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canCompleteApprovedVerificationSignup,
  getApprovedVerificationUid,
  hashOtp,
  isAllowedStudentEmail,
  isValidDob,
  isValidEmail,
  isValidOtpPurpose,
  isValidSignupRole,
  otpMatches,
} from './authSecurity';

test('student email policy allows Qatar and configured school domains', () => {
  assert.equal(isAllowedStudentEmail('student@example.qa'), true);
  assert.equal(isAllowedStudentEmail('student@abdn.ac.uk'), true);
  assert.equal(isAllowedStudentEmail('student@ulster.ac.uk'), true);
  assert.equal(isAllowedStudentEmail('student@student.dbsrawdat.com'), true);
  assert.equal(isAllowedStudentEmail('student@smail.astate.edu'), true);
  assert.equal(isAllowedStudentEmail('student@example.com'), false);
});

test('auth validation rejects malformed values', () => {
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidOtpPurpose('admin'), false);
  assert.equal(isValidSignupRole('admin'), false);
  assert.equal(isValidDob('2999-01-01'), false);
});

test('OTP hashes are bound to the normalized email and server secret', () => {
  const secret = 'test-only-secret';
  const hash = hashOtp(' Student@Example.com ', '123456', secret);

  assert.equal(otpMatches('student@example.com', '123456', hash, secret), true);
  assert.equal(otpMatches('other@example.com', '123456', hash, secret), false);
  assert.equal(otpMatches('student@example.com', '654321', hash, secret), false);
  assert.equal(otpMatches('student@example.com', '123456', hash, 'other-secret'), false);
});

test('approved verification access is bound to the reviewed email and auth UID', () => {
  const record = { status: 'approved', email: 'student@example.com', authUid: 'uid-1' };

  assert.equal(getApprovedVerificationUid(record, 'STUDENT@example.com'), 'uid-1');
  assert.equal(canCompleteApprovedVerificationSignup(record, 'uid-1', 'student@example.com'), true);
  assert.equal(canCompleteApprovedVerificationSignup(record, 'uid-2', 'student@example.com'), false);
  assert.equal(getApprovedVerificationUid({ ...record, status: 'pending' }, 'student@example.com'), null);
});
