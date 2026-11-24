/**
 * Security test specification verifying the 12 adversarial ("Dirty Dozen") payloads
 * against firestore.rules when run with the Firebase Rules Unit Testing emulator.
 */
export interface DirtyDozenScenario {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  auth: { uid: string; email: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const dirtyDozenPayloads: DirtyDozenScenario[] = [
  {
    id: 1,
    name: 'Cross-User Read/Write',
    operation: 'get',
    path: '/users/userA/places/p1',
    auth: { uid: 'userB', email: 'b@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Unverified Email Write',
    operation: 'create',
    path: '/users/userA',
    auth: { uid: 'userA', email: 'a@example.com', email_verified: false },
    payload: {
      uid: 'userA',
      email: 'a@example.com',
      displayName: 'A',
      currentMoodId: 'energetic',
      currentLayout: 'card',
      seededDefaults: true,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'UID Spoofing on Create',
    operation: 'create',
    path: '/users/userA/places/p1',
    auth: { uid: 'userA', email: 'a@example.com', email_verified: true },
    payload: { uid: 'userB', id: 'p1', name: 'Spoofed' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Shadow Update / Ghost Field',
    operation: 'update',
    path: '/users/userA',
    auth: { uid: 'userA', email: 'a@example.com', email_verified: true },
    payload: { currentMoodId: 'cozy', isAdmin: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Immutable createdAt Tampering',
    operation: 'update',
    path: '/users/userA/places/p1',
    auth: { uid: 'userA', email: 'a@example.com', email_verified: true },
    payload: { name: 'Updated', createdAt: '2020-01-01T00:00:00Z' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Client-Spoofed Server Timestamp',
    operation: 'create',
    path: '/users/userA/categories/cat_1',
    auth: { uid: 'userA', email: 'a@example.com', email_verified: true },
    payload: {
      uid: 'userA',
      id: 'cat_1',
      name: 'Cafe',
      icon: '☕',
      fields: [],
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Invalid Document ID Poisoning',
    operation: 'create',
    path: '/users/userA/places/bad$id.invalid',
    auth: { uid: 'userA', email: 'a@example.com', email_verified: true },
    payload: { uid: 'userA', id: 'bad$id.invalid', name: 'Bad' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Orphaned Media Write',
    operation: 'create',
    path: '/users/userA/media/m1',
    auth: { uid: 'userA', email: 'a@example.com', email_verified: true },
    payload: {
      uid: 'userA',
      id: 'm1',
      placeId: 'nonexistent_place',
      type: 'image',
      url: 'data:image/jpeg;base64,abc',
      sortOrder: 0,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Blanket User Collection List',
    operation: 'list',
    path: '/users',
    auth: { uid: 'userA', email: 'a@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Oversized Memo or Negative Cost Poisoning',
    operation: 'update',
    path: '/users/userA/places/p1',
    auth: { uid: 'userA', email: 'a@example.com', email_verified: true },
    payload: { memo: 'x'.repeat(2500), actualCost: -5000 },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Invalid Enum Value',
    operation: 'update',
    path: '/users/userA',
    auth: { uid: 'userA', email: 'a@example.com', email_verified: true },
    payload: { currentLayout: 'invalid_layout' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Immutable Media Update Attempt',
    operation: 'update',
    path: '/users/userA/media/m1',
    auth: { uid: 'userA', email: 'a@example.com', email_verified: true },
    payload: { url: 'https://evil.example/payload' },
    expected: 'PERMISSION_DENIED',
  },
];
