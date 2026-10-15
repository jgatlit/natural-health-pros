export type EditNavEntry = {
  id: string;
  label: string;
  children?: readonly EditNavEntry[];
};

export type EditNavFlags = {
  isSetUp: boolean;
  hasCaseStudies: boolean;
  showJoinLink: boolean;
};

const PROFILE_CHILDREN: readonly EditNavEntry[] = [
  { id: 'profile-photo', label: 'Photo' },
  { id: 'profile-name', label: 'Name and bio' },
  { id: 'profile-qualifications', label: 'Qualifications' },
  { id: 'profile-specialties', label: 'Specialties' },
  { id: 'profile-extra-work', label: 'Open to outside work' },
];

/**
 * Single source for the side navigation. Order mirrors the page: while setup is incomplete the
 * checklist leads and Bookings/Clients follow Custom sections; once set up they lead. Entries
 * whose card renders conditionally on data (e.g. "Practitioners you brought in") are pruned in
 * the browser by anchor presence, so this list never has to re-derive that query.
 */
export function editNavEntries({ isSetUp, hasCaseStudies, showJoinLink }: EditNavFlags): EditNavEntry[] {
  const bookingsAndClients: EditNavEntry[] = [
    { id: 'bookings', label: 'Bookings' },
    { id: 'clients', label: 'Clients & referrals' },
  ];
  return [
    ...(isSetUp ? [] : [{ id: 'setup', label: 'Get set up' }]),
    ...(isSetUp ? bookingsAndClients : []),
    { id: 'profile', label: 'Profile', children: PROFILE_CHILDREN },
    ...(hasCaseStudies ? [{ id: 'client-outcomes', label: 'Client outcomes' }] : []),
    { id: 'plan', label: 'Plan' },
    { id: 'payments', label: 'Client payments' },
    { id: 'offerings', label: 'Offerings' },
    { id: 'booking-links', label: 'Booking links' },
    { id: 'sections', label: 'Custom sections' },
    ...(isSetUp ? [] : bookingsAndClients),
    ...(showJoinLink ? [{ id: 'share-signup', label: 'Invite another practitioner' }] : []),
    { id: 'brought-in', label: 'Practitioners you brought in' },
    { id: 'account', label: 'Account email' },
  ];
}

export function flattenEditNav(entries: readonly EditNavEntry[]): EditNavEntry[] {
  return entries.flatMap((e) => [e, ...(e.children ? flattenEditNav(e.children) : [])]);
}
