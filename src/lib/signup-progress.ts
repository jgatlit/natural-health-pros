export type SignupProgress = 'requested' | 'onboarding-started' | 'profile-complete';

export const SIGNUP_PROGRESS_LABEL: Record<SignupProgress, string> = {
  requested: 'Signed up (link sent)',
  'onboarding-started': 'Onboarding started',
  'profile-complete': 'Profile complete',
};

/** Where a cohort sign-up stands. `profileComplete` is the existing completeness gate's verdict. */
export function signupProgress(input: {
  acceptedAt: Date | null;
  hasPractitioner: boolean;
  profileComplete: boolean;
}): SignupProgress {
  if (input.hasPractitioner && input.profileComplete) return 'profile-complete';
  if (input.acceptedAt || input.hasPractitioner) return 'onboarding-started';
  return 'requested';
}
