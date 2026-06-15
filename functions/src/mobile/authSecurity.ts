import { createHash } from 'crypto';
import { CallableRequest } from 'firebase-functions/v2/https';

const ALLOWED_STUDENT_EMAIL_DOMAINS = new Set([
  'gemsed.com',
  'dpsmisdoha.com',
  'oliveschooldoha.com',
  'bpsdoha.edu.qa',
  'rajagiridoha.com',
  'education.qa',
  'americanacademy.sch.qa',
  'student.ukm.qa',
  'miesppu.edu.qa',
  'abdn.ac.uk',
  'student.dbs.sch.qa',
  'asd.equ.qa',
  'qu.edu.qa',
  'oryx.edu.qa',
  'lu.edu.qa',
  'tamu.edu',
  'hbku.edu.qa',
  'andrew.cmu.edu',
]);

const OTP_PURPOSES = ['signup', 'login', 'verification'];

export const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export const isAllowedStudentEmail = (email: string) => {
  const domain = email.split('@')[1]?.trim().toLowerCase();
  return !!domain && (domain.endsWith('.qa') || ALLOWED_STUDENT_EMAIL_DOMAINS.has(domain));
};

export const isValidOtpPurpose = (purpose: unknown) =>
  typeof purpose === 'string' && OTP_PURPOSES.includes(purpose);

export const isValidSignupRole = (role: unknown) =>
  role === 'student' || role === 'creator';

export const isValidSignupGender = (gender: unknown) =>
  gender === 'Male' || gender === 'Female';

export const isValidDob = (dob: unknown) => {
  if (typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return false;

  const parsed = new Date(`${dob}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() <= Date.now();
};

export const getRequestFingerprint = (request: CallableRequest) => {
  const forwardedFor = request.rawRequest.headers['x-forwarded-for'];
  const ip = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(',')[0]?.trim() || request.rawRequest.ip || 'unknown';
  const userAgent = request.rawRequest.headers['user-agent'] || 'unknown';
  const appId = request.app?.appId || 'unknown';
  return createHash('sha256').update(`${ip}:${userAgent}:${appId}`).digest('hex');
};
