# Firestore Security Specification

## 1. Data Invariants
1. Every document under `/users/{userId}` and its subcollections (`categories`, `places`, `media`) belongs strictly to the authenticated, email-verified user whose `request.auth.uid == userId`.
2. Every subcollection document (`categories`, `places`, `media`) requires the parent `/users/{userId}` document to exist (`existsAfter`), and `media` documents require their referenced `placeId` to exist (`existsAfter`).
3. `uid`, `id`, and `createdAt` are immutable after creation.
4. `createdAt` and `updatedAt` must equal `request.time` (server timestamps).
5. All strings, arrays (`fields`, `doneItems`, `todoItems`), maps (`customValues`), and expense fields (`estimatedCost`, `actualCost` bounded `[0, 1000000000]`, `spentDate` matching `YYYY-MM-DD` or `""`) are strictly bounded, and ghost fields are rejected via `hasAll` / `hasOnly` and `affectedKeys().hasOnly(...)`.
6. User PII (`email`) is strictly isolated to `/users/{userId}` where `get` is owner-only and `list` is forbidden (`false`).

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Cross-User Read/Write**: User B attempts `get` or `write` on `/users/userA/places/p1`. -> `PERMISSION_DENIED`.
2. **Unverified Email Write**: User with `email_verified: false` attempts `create` on `/users/userA`. -> `PERMISSION_DENIED`.
3. **UID Spoofing**: User A sends `{ uid: "userB", ... }` to `/users/userA/places/p1`. -> `PERMISSION_DENIED`.
4. **Ghost Field / Shadow Update**: User A includes `{ isAdmin: true }` in `create` or `update`. -> `PERMISSION_DENIED`.
5. **Immutable Field Tampering**: User A attempts to change `createdAt`, `uid`, or `id` during `update`. -> `PERMISSION_DENIED`.
6. **Client-Spoofed Timestamp**: User A passes a fixed Date instead of `request.time` for `createdAt` or `updatedAt`. -> `PERMISSION_DENIED`.
7. **ID Poisoning**: User A writes to `/users/userA/places/bad$id..with.spaces` or a >128 char ID. -> `PERMISSION_DENIED`.
8. **Orphaned Media Write**: User A creates a `media` doc referencing a nonexistent `placeId`. -> `PERMISSION_DENIED`.
9. **Blanket User List**: User A attempts `list` on `/users`. -> `PERMISSION_DENIED`.
10. **Unbounded Array/String/Number Overflow**: User A sends `memo` > 2000 chars, `todoItems` > 50 items, `actualCost` < 0, or `url` > 750,000 chars. -> `PERMISSION_DENIED`.
11. **Invalid Enum Value**: User A sets `status: "archived"` or `currentLayout: "unknown"`. -> `PERMISSION_DENIED`.
12. **Media Mutation Attack**: User A attempts `update` on an existing `/users/userA/media/{mediaId}` doc (media is create/delete only). -> `PERMISSION_DENIED`.
