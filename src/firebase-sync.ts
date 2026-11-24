import {
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { auth, db, googleProvider, handleFirestoreError, OperationType } from './firebase';

export interface LocalMediaItem {
  id?: string;
  type: 'image' | 'video' | 'video_url';
  url: string;
}

export interface LocalCategory {
  id: string;
  name: string;
  icon: string;
  fields?: string[];
}

export interface LocalPlace {
  id: string;
  categoryId: string;
  status: 'visited' | 'wishlist' | string;
  name: string;
  address?: string;
  hours?: string;
  link?: string;
  lastSynced?: string;
  videoUrl?: string;
  media?: LocalMediaItem[];
  customValues?: Record<string, string>;
  doneItems?: string[];
  todoItems?: string[];
  memo?: string;
  estimatedCost?: number;
  actualCost?: number;
  spentDate?: string;
  sortTimestamp?: number;
}

interface AppBridge {
  getLocalSnapshot: () => {
    categories: LocalCategory[];
    places: LocalPlace[];
    currentMoodId: string;
    currentLayout: string;
  };
  applyCloudState: (data: {
    categories?: LocalCategory[];
    places?: LocalPlace[];
    currentMoodId?: string;
    currentLayout?: string;
  }) => void;
  onAuthStatusChanged: (status: {
    ready: boolean;
    signedIn: boolean;
    email: string | null;
    displayName: string | null;
    syncing: boolean;
    errorMessage?: string | null;
  }) => void;
  showToast: (msg: string) => void;
}

declare global {
  interface Window {
    __dangolBridge?: AppBridge;
    cloudSync?: typeof cloudSyncApi;
  }
}

const MAX_MEDIA_URL_LENGTH = 750000;

function sanitizeId(raw: string, prefix: string): string {
  const cleaned = String(raw || '')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 120);
  return cleaned || `${prefix}_${Date.now()}`;
}

function clampStr(val: unknown, maxLen: number, fallback = ''): string {
  const s = typeof val === 'string' ? val : fallback;
  return s.slice(0, maxLen);
}

function clampStringList(val: unknown, maxItems: number, maxItemLen = 120): string[] {
  if (!Array.isArray(val)) return [];
  return val
    .map((item) => String(item ?? '').trim().slice(0, maxItemLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function sanitizeCustomValues(val: unknown): Record<string, string> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(val).slice(0, 30)) {
    const cleanKey = String(k).trim().slice(0, 60);
    const cleanVal = String(v ?? '').trim().slice(0, 300);
    if (cleanKey && cleanVal) {
      result[cleanKey] = cleanVal;
    }
  }
  return result;
}

function sanitizeLayout(val: unknown): 'card' | 'compact' | 'grid' {
  return val === 'compact' || val === 'grid' ? val : 'card';
}

function sanitizeMoodId(val: unknown): string {
  const cleaned = String(val || 'energetic')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 40);
  return cleaned || 'energetic';
}

function sanitizeStatus(val: unknown): 'visited' | 'wishlist' {
  return val === 'wishlist' ? 'wishlist' : 'visited';
}

function sanitizeCost(val: unknown): number {
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(1000000000, Math.round(num));
}

function sanitizeSpentDate(val: unknown): string {
  const s = typeof val === 'string' ? val.trim().slice(0, 10) : '';
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) ? s : '';
}

let currentUser: User | null = null;
let authReady = false;
let unsubscribers: Unsubscribe[] = [];

let cloudCategories: LocalCategory[] | null = null;
let cloudPlacesRaw: Array<LocalPlace & { sortTimestamp: number }> | null = null;
let cloudMediaByPlace = new Map<string, Array<{ id: string; type: 'image' | 'video' | 'video_url'; url: string; sortOrder: number }>>();
let cloudPrefs: { currentMoodId?: string; currentLayout?: string } | null = null;

const knownCategoryIds = new Set<string>();
const knownPlaceIds = new Set<string>();
const knownMediaIdsByPlace = new Map<string, string[]>();

function teardownListeners() {
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers = [];
  cloudCategories = null;
  cloudPlacesRaw = null;
  cloudMediaByPlace = new Map();
  cloudPrefs = null;
  knownCategoryIds.clear();
  knownPlaceIds.clear();
  knownMediaIdsByPlace.clear();
}

function isMobileInAppBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\/|DaumApps|; wv\)/i.test(ua);
}

function isStandaloneTopWindow(): boolean {
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
}

function formatAuthErrorMessage(err: unknown): { message: string; isCancel?: boolean } {
  const code = (err as { code?: string })?.code || '';
  const rawMsg = err instanceof Error ? err.message : String(err || '');

  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return { message: '구글 로그인이 취소되었습니다.', isCancel: true };
  }
  if (code === 'auth/unauthorized-domain') {
    const host = typeof window !== 'undefined' ? window.location.hostname : '';
    return {
      message: `승인되지 않은 도메인(${host})입니다. Firebase 콘솔 → Authentication → Settings → Authorized domains에 이 도메인을 추가해 주세요. (${code})`,
    };
  }
  if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
    return {
      message: `브라우저에서 로그인 팝업이 차단되었습니다. Safari/Chrome 팝업 차단을 해제한 뒤 다시 시도해 주세요. (${code})`,
    };
  }
  if (code === 'auth/web-storage-unsupported') {
    return {
      message: `브라우저 쿠키·저장소가 차단되어 로그인할 수 없습니다. 시크릿 모드를 끄거나 쿠키 허용 후 다시 시도해 주세요. (${code})`,
    };
  }
  if (code === 'auth/network-request-failed') {
    return {
      message: `네트워크 연결이 불안정해 로그인하지 못했습니다. 인터넷 연결을 확인 후 다시 시도해 주세요. (${code})`,
    };
  }
  return {
    message: `구글 로그인 오류${code ? ` (${code})` : ''}: ${rawMsg || '다시 시도해 주세요.'}`,
  };
}

function formatFirestoreErrorToast(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err || '');
  if (msg.includes('Quota exceeded')) {
    return '⚠️ 클라우드 무료 일일 사용량 한도를 초과했습니다. 내일 다시 시도하거나 업그레이드해 주세요.';
  }
  if (msg.includes('permission-denied') || msg.includes('PERMISSION_DENIED')) {
    return '⚠️ 클라우드 접근 권한이 거부되었습니다. 다시 로그인해 주세요.';
  }
  return `⚠️ 클라우드 동기화 오류: ${msg}`;
}

function emitAuthStatus(syncing = false, errorMessage: string | null = null) {
  window.__dangolBridge?.onAuthStatusChanged({
    ready: authReady,
    signedIn: Boolean(currentUser),
    email: currentUser?.email ?? null,
    displayName: currentUser?.displayName ?? null,
    syncing,
    errorMessage,
  });
}

function pushMergedCloudStateToUI() {
  if (!window.__dangolBridge) return;
  const payload: {
    categories?: LocalCategory[];
    places?: LocalPlace[];
    currentMoodId?: string;
    currentLayout?: string;
  } = {};

  if (cloudPrefs?.currentMoodId) payload.currentMoodId = cloudPrefs.currentMoodId;
  if (cloudPrefs?.currentLayout) payload.currentLayout = cloudPrefs.currentLayout;
  if (cloudCategories !== null) payload.categories = cloudCategories;

  if (cloudPlacesRaw !== null) {
    payload.places = cloudPlacesRaw.map((p) => {
      const attached = (cloudMediaByPlace.get(p.id) || [])
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((m) => ({ id: m.id, type: m.type, url: m.url }));
      return {
        ...p,
        media: attached,
      };
    });
  }

  if (Object.keys(payload).length > 0) {
    window.__dangolBridge.applyCloudState(payload);
  }
}

async function ensureUserProfileAndInitialSync(user: User) {
  const uid = user.uid;
  const userPath = `users/${uid}`;
  const userRef = doc(db, 'users', uid);

  let existingSnap;
  try {
    existingSnap = await getDoc(userRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, userPath);
  }

  const local = window.__dangolBridge?.getLocalSnapshot() || {
    categories: [],
    places: [],
    currentMoodId: 'energetic',
    currentLayout: 'card',
  };

  if (!existingSnap.exists()) {
    // First time signing in with this Google account: create user profile & upload existing local data
    try {
      await setDoc(userRef, {
        uid,
        email: clampStr(user.email, 254, 'user@example.com'),
        displayName: clampStr(user.displayName, 100, '단골노트 사용자'),
        currentMoodId: sanitizeMoodId(local.currentMoodId),
        currentLayout: sanitizeLayout(local.currentLayout),
        seededDefaults: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, userPath);
    }

    await uploadSnapshotToFirestore(uid, local.categories, local.places);
    window.__dangolBridge?.showToast('☁️ 구글 계정과 연결되어 기존 기록이 클라우드에 저장되었습니다!');
  } else {
    const data = existingSnap.data();
    if (data?.seededDefaults === false) {
      await uploadSnapshotToFirestore(uid, local.categories, local.places);
      try {
        await updateDoc(userRef, {
          seededDefaults: true,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, userPath);
      }
    }
  }
}

async function uploadSnapshotToFirestore(
  uid: string,
  categories: LocalCategory[],
  places: LocalPlace[]
) {
  let batch = writeBatch(db);
  let opCount = 0;

  const commitIfNeeded = async (force = false) => {
    if (opCount >= 400 || (force && opCount > 0)) {
      try {
        await batch.commit();
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `users/${uid}`);
      }
      batch = writeBatch(db);
      opCount = 0;
    }
  };

  categories.forEach((cat, idx) => {
    const catId = sanitizeId(cat.id, `cat_${idx}`);
    const catRef = doc(db, 'users', uid, 'categories', catId);
    batch.set(catRef, {
      uid,
      id: catId,
      name: clampStr(cat.name, 60, '카테고리') || '카테고리',
      icon: clampStr(cat.icon, 16, '📍') || '📍',
      fields: clampStringList(cat.fields, 30, 60),
      sortOrder: idx,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    opCount++;
  });
  await commitIfNeeded();

  let skippedOversizedMedia = 0;
  const baseTs = Date.now();
  for (let pIdx = 0; pIdx < places.length; pIdx++) {
    const p = places[pIdx];
    const placeId = sanitizeId(p.id, `p_${baseTs}_${pIdx}`);
    const placeRef = doc(db, 'users', uid, 'places', placeId);
    const sortTs = typeof p.sortTimestamp === 'number' ? p.sortTimestamp : baseTs - pIdx * 1000;
    batch.set(placeRef, {
      uid,
      id: placeId,
      categoryId: sanitizeId(p.categoryId, 'cat_food'),
      status: sanitizeStatus(p.status),
      name: clampStr(p.name, 150, '이름 없는 장소') || '이름 없는 장소',
      address: clampStr(p.address, 300),
      hours: clampStr(p.hours, 200),
      link: clampStr(p.link, 1000),
      lastSynced: clampStr(p.lastSynced, 100),
      videoUrl: clampStr(p.videoUrl, 1000),
      customValues: sanitizeCustomValues(p.customValues),
      doneItems: clampStringList(p.doneItems, 50, 120),
      todoItems: clampStringList(p.todoItems, 50, 120),
      memo: clampStr(p.memo, 2000),
      estimatedCost: sanitizeCost(p.estimatedCost),
      actualCost: sanitizeCost(p.actualCost),
      spentDate: sanitizeSpentDate(p.spentDate),
      sortTimestamp: sortTs,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    opCount++;
    await commitIfNeeded();

    const mediaList = Array.isArray(p.media) ? p.media : [];
    for (let mIdx = 0; mIdx < mediaList.length; mIdx++) {
      const m = mediaList[mIdx];
      if (!m?.url) continue;
      if (m.url.length > MAX_MEDIA_URL_LENGTH) {
        skippedOversizedMedia++;
        continue;
      }
      const mediaId = sanitizeId(m.id || `m_${placeId}_${mIdx}_${baseTs}`, 'm');
      const mediaRef = doc(db, 'users', uid, 'media', mediaId);
      const mediaType =
        m.type === 'video' || m.type === 'video_url' ? m.type : 'image';
      batch.set(mediaRef, {
        uid,
        id: mediaId,
        placeId,
        type: mediaType,
        url: m.url,
        sortOrder: mIdx,
        createdAt: serverTimestamp(),
      });
      opCount++;
      await commitIfNeeded();
    }
  }

  await commitIfNeeded(true);
  if (skippedOversizedMedia > 0) {
    window.__dangolBridge?.showToast(
      `⚠️ 대용량 영상 ${skippedOversizedMedia}건은 크기 제한으로 제외되고 나머지 기록이 동기화되었습니다.`
    );
  }
}

function attachRealtimeListeners(uid: string) {
  teardownListeners();

  const userPath = `users/${uid}`;
  const unsubUser = onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      cloudPrefs = {
        currentMoodId: typeof data.currentMoodId === 'string' ? data.currentMoodId : undefined,
        currentLayout: typeof data.currentLayout === 'string' ? data.currentLayout : undefined,
      };
      pushMergedCloudStateToUI();
      emitAuthStatus(false);
    },
    (err) => {
      const msg = formatFirestoreErrorToast(err);
      emitAuthStatus(false, msg);
      window.__dangolBridge?.showToast(msg);
      handleFirestoreError(err, OperationType.GET, userPath);
    }
  );

  const catsPath = `users/${uid}/categories`;
  const catsQuery = query(collection(db, 'users', uid, 'categories'), where('uid', '==', uid));
  const unsubCats = onSnapshot(
    catsQuery,
    (snapshot) => {
      knownCategoryIds.clear();
      const rows = snapshot.docs.map((d) => {
        knownCategoryIds.add(d.id);
        const data = d.data();
        return {
          id: data.id || d.id,
          name: data.name || '카테고리',
          icon: data.icon || '📍',
          fields: Array.isArray(data.fields) ? data.fields : [],
          sortOrder: typeof data.sortOrder === 'number' ? data.sortOrder : 0,
        };
      });
      rows.sort((a, b) => a.sortOrder - b.sortOrder);
      cloudCategories = rows.map(({ sortOrder: _s, ...rest }) => rest);
      pushMergedCloudStateToUI();
      emitAuthStatus(false);
    },
    (err) => {
      const msg = formatFirestoreErrorToast(err);
      emitAuthStatus(false, msg);
      window.__dangolBridge?.showToast(msg);
      handleFirestoreError(err, OperationType.LIST, catsPath);
    }
  );

  const placesPath = `users/${uid}/places`;
  const placesQuery = query(collection(db, 'users', uid, 'places'), where('uid', '==', uid));
  const unsubPlaces = onSnapshot(
    placesQuery,
    (snapshot) => {
      knownPlaceIds.clear();
      const rows = snapshot.docs.map((d) => {
        knownPlaceIds.add(d.id);
        const data = d.data();
        return {
          id: data.id || d.id,
          categoryId: data.categoryId || 'cat_food',
          status: data.status === 'wishlist' ? 'wishlist' : 'visited',
          name: data.name || '',
          address: data.address || '',
          hours: data.hours || '',
          link: data.link || '',
          lastSynced: data.lastSynced || '',
          videoUrl: data.videoUrl || '',
          customValues: data.customValues || {},
          doneItems: Array.isArray(data.doneItems) ? data.doneItems : [],
          todoItems: Array.isArray(data.todoItems) ? data.todoItems : [],
          memo: data.memo || '',
          estimatedCost: sanitizeCost(data.estimatedCost),
          actualCost: sanitizeCost(data.actualCost),
          spentDate: sanitizeSpentDate(data.spentDate),
          sortTimestamp: typeof data.sortTimestamp === 'number' ? data.sortTimestamp : 0,
        };
      });
      rows.sort((a, b) => b.sortTimestamp - a.sortTimestamp);
      cloudPlacesRaw = rows;
      pushMergedCloudStateToUI();
      emitAuthStatus(false);
    },
    (err) => {
      const msg = formatFirestoreErrorToast(err);
      emitAuthStatus(false, msg);
      window.__dangolBridge?.showToast(msg);
      handleFirestoreError(err, OperationType.LIST, placesPath);
    }
  );

  const mediaPath = `users/${uid}/media`;
  const mediaQuery = query(collection(db, 'users', uid, 'media'), where('uid', '==', uid));
  const unsubMedia = onSnapshot(
    mediaQuery,
    (snapshot) => {
      const grouped = new Map<
        string,
        Array<{ id: string; type: 'image' | 'video' | 'video_url'; url: string; sortOrder: number }>
      >();
      knownMediaIdsByPlace.clear();

      snapshot.docs.forEach((d) => {
        const data = d.data();
        const placeId = String(data.placeId || '');
        if (!placeId) return;
        const arr = grouped.get(placeId) || [];
        arr.push({
          id: data.id || d.id,
          type:
            data.type === 'video' || data.type === 'video_url' ? data.type : 'image',
          url: data.url || '',
          sortOrder: typeof data.sortOrder === 'number' ? data.sortOrder : 0,
        });
        grouped.set(placeId, arr);

        const idList = knownMediaIdsByPlace.get(placeId) || [];
        idList.push(d.id);
        knownMediaIdsByPlace.set(placeId, idList);
      });

      cloudMediaByPlace = grouped;
      pushMergedCloudStateToUI();
      emitAuthStatus(false);
    },
    (err) => {
      const msg = formatFirestoreErrorToast(err);
      emitAuthStatus(false, msg);
      window.__dangolBridge?.showToast(msg);
      handleFirestoreError(err, OperationType.LIST, mediaPath);
    }
  );

  unsubscribers = [unsubUser, unsubCats, unsubPlaces, unsubMedia];
}

getRedirectResult(auth)
  .then((result) => {
    if (result?.user) {
      window.__dangolBridge?.showToast('☁️ 구글 계정 로그인 완료! 기록을 동기화합니다.');
    }
  })
  .catch((err: unknown) => {
    const formatted = formatAuthErrorMessage(err);
    if (!formatted.isCancel) {
      console.error('Google Redirect Sign-In error:', err);
      emitAuthStatus(false, formatted.message);
      window.__dangolBridge?.showToast(`⚠️ ${formatted.message}`);
    }
  });

onAuthStateChanged(auth, async (user) => {
  authReady = true;
  currentUser = user;

  if (!user) {
    teardownListeners();
    emitAuthStatus(false);
    return;
  }

  emitAuthStatus(true);
  try {
    await ensureUserProfileAndInitialSync(user);
    attachRealtimeListeners(user.uid);
  } catch (err) {
    console.error('Auth sync initialization failed:', err);
    const msg = formatFirestoreErrorToast(err);
    emitAuthStatus(false, msg);
    window.__dangolBridge?.showToast(msg);
  }
});

const cloudSyncApi = {
  isSignedIn(): boolean {
    return Boolean(currentUser);
  },

  async signInWithGoogle(): Promise<void> {
    if (isMobileInAppBrowser()) {
      const msg =
        '카카오톡·네이버 등 앱 내 브라우저에서는 Google 로그인이 차단됩니다. 우측 메뉴(⋯)에서 "Safari로 열기" 또는 "다른 브라우저(Chrome)로 열기"를 눌러 열어주세요.';
      emitAuthStatus(false, msg);
      window.__dangolBridge?.showToast(`⚠️ ${msg}`);
      return;
    }

    try {
      emitAuthStatus(true);
      await signInWithPopup(auth, googleProvider);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || '';
      if (
        (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') &&
        isStandaloneTopWindow()
      ) {
        try {
          window.__dangolBridge?.showToast('🔄 팝업이 차단되어 Google 로그인 페이지로 이동합니다...');
          await signInWithRedirect(auth, googleProvider);
          return;
        } catch (redirectErr: unknown) {
          const formattedRedirect = formatAuthErrorMessage(redirectErr);
          emitAuthStatus(false, formattedRedirect.message);
          window.__dangolBridge?.showToast(`⚠️ ${formattedRedirect.message}`);
          console.error('Google Redirect fallback error:', redirectErr);
          return;
        }
      }

      const formatted = formatAuthErrorMessage(err);
      if (formatted.isCancel) {
        emitAuthStatus(false);
        window.__dangolBridge?.showToast(formatted.message);
        return;
      }

      emitAuthStatus(false, formatted.message);
      window.__dangolBridge?.showToast(`⚠️ ${formatted.message}`);
      console.error('Google Sign-In error:', err);
    }
  },

  async signOutUser(): Promise<void> {
    try {
      await signOut(auth);
      window.__dangolBridge?.showToast('로그아웃되었습니다. (현재 기기 로컬 모드로 전환)');
    } catch (err) {
      console.error('Sign-out error:', err);
      window.__dangolBridge?.showToast('⚠️ 로그아웃 중 오류가 발생했습니다.');
    }
  },

  async savePreferences(currentMoodId: string, currentLayout: string): Promise<void> {
    if (!currentUser) return;
    const uid = currentUser.uid;
    const path = `users/${uid}`;
    try {
      await updateDoc(doc(db, 'users', uid), {
        currentMoodId: sanitizeMoodId(currentMoodId),
        currentLayout: sanitizeLayout(currentLayout),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  },

  async upsertCategory(cat: LocalCategory, sortOrder: number): Promise<void> {
    if (!currentUser) return;
    const uid = currentUser.uid;
    const catId = sanitizeId(cat.id, 'cat');
    const path = `users/${uid}/categories/${catId}`;
    const catRef = doc(db, 'users', uid, 'categories', catId);
    const payload = {
      name: clampStr(cat.name, 60, '카테고리') || '카테고리',
      icon: clampStr(cat.icon, 16, '📍') || '📍',
      fields: clampStringList(cat.fields, 30, 60),
      sortOrder: Math.max(0, Math.min(1000000, Math.floor(sortOrder))),
      updatedAt: serverTimestamp(),
    };

    try {
      if (knownCategoryIds.has(catId)) {
        await updateDoc(catRef, payload);
      } else {
        await setDoc(catRef, {
          uid,
          id: catId,
          ...payload,
          createdAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  },

  async deleteCategory(categoryId: string): Promise<void> {
    if (!currentUser) return;
    const uid = currentUser.uid;
    const catId = sanitizeId(categoryId, 'cat');
    const path = `users/${uid}/categories/${catId}`;
    try {
      await deleteDoc(doc(db, 'users', uid, 'categories', catId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  },

  async savePlaceWithMedia(place: LocalPlace, isEdit: boolean): Promise<void> {
    if (!currentUser) return;
    const uid = currentUser.uid;
    const placeId = sanitizeId(place.id, 'p');
    const placeRef = doc(db, 'users', uid, 'places', placeId);
    const sortTs = typeof place.sortTimestamp === 'number' ? place.sortTimestamp : Date.now();

    const editableFields = {
      categoryId: sanitizeId(place.categoryId, 'cat_food'),
      status: sanitizeStatus(place.status),
      name: clampStr(place.name, 150, '이름 없는 장소') || '이름 없는 장소',
      address: clampStr(place.address, 300),
      hours: clampStr(place.hours, 200),
      link: clampStr(place.link, 1000),
      lastSynced: clampStr(place.lastSynced, 100),
      videoUrl: clampStr(place.videoUrl, 1000),
      customValues: sanitizeCustomValues(place.customValues),
      doneItems: clampStringList(place.doneItems, 50, 120),
      todoItems: clampStringList(place.todoItems, 50, 120),
      memo: clampStr(place.memo, 2000),
      estimatedCost: sanitizeCost(place.estimatedCost),
      actualCost: sanitizeCost(place.actualCost),
      spentDate: sanitizeSpentDate(place.spentDate),
      sortTimestamp: sortTs,
      updatedAt: serverTimestamp(),
    };

    const batch = writeBatch(db);
    if (isEdit && knownPlaceIds.has(placeId)) {
      batch.update(placeRef, editableFields);
    } else {
      batch.set(placeRef, {
        uid,
        id: placeId,
        ...editableFields,
        createdAt: serverTimestamp(),
      });
    }

    const desiredMedia = Array.isArray(place.media) ? place.media : [];
    const desiredIds = new Set<string>();
    let skippedOversized = 0;
    const ts = Date.now();

    desiredMedia.forEach((m, idx) => {
      if (!m?.url) return;
      if (m.url.length > MAX_MEDIA_URL_LENGTH) {
        skippedOversized++;
        return;
      }
      const mediaId = sanitizeId(m.id || `m_${placeId}_${ts}_${idx}`, 'm');
      m.id = mediaId;
      desiredIds.add(mediaId);
      const existingIds = knownMediaIdsByPlace.get(placeId) || [];
      if (!existingIds.includes(mediaId)) {
        const mediaRef = doc(db, 'users', uid, 'media', mediaId);
        batch.set(mediaRef, {
          uid,
          id: mediaId,
          placeId,
          type: m.type === 'video' || m.type === 'video_url' ? m.type : 'image',
          url: m.url,
          sortOrder: idx,
          createdAt: serverTimestamp(),
        });
      }
    });

    const prevMediaIds = knownMediaIdsByPlace.get(placeId) || [];
    prevMediaIds.forEach((oldId) => {
      if (!desiredIds.has(oldId)) {
        batch.delete(doc(db, 'users', uid, 'media', oldId));
      }
    });

    try {
      await batch.commit();
      if (skippedOversized > 0) {
        window.__dangolBridge?.showToast(
          '⚠️ 500KB 초과 동영상은 클라우드 크기 제한으로 제외되었고 나머지 기록은 동기화되었습니다.'
        );
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${uid}/places/${placeId}`);
    }
  },

  async appendPlaceMedia(placeId: string, items: LocalMediaItem[], startOrder: number): Promise<void> {
    if (!currentUser || items.length === 0) return;
    const uid = currentUser.uid;
    const cleanPlaceId = sanitizeId(placeId, 'p');
    const batch = writeBatch(db);
    let added = 0;
    let skippedOversized = 0;
    const ts = Date.now();

    items.forEach((m, idx) => {
      if (!m?.url) return;
      if (m.url.length > MAX_MEDIA_URL_LENGTH) {
        skippedOversized++;
        return;
      }
      const mediaId = sanitizeId(m.id || `m_${cleanPlaceId}_${ts}_${idx}`, 'm');
      m.id = mediaId;
      batch.set(doc(db, 'users', uid, 'media', mediaId), {
        uid,
        id: mediaId,
        placeId: cleanPlaceId,
        type: m.type === 'video' || m.type === 'video_url' ? m.type : 'image',
        url: m.url,
        sortOrder: startOrder + idx,
        createdAt: serverTimestamp(),
      });
      added++;
    });

    if (added > 0) {
      try {
        await batch.commit();
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `users/${uid}/media`);
      }
    }
    if (skippedOversized > 0) {
      window.__dangolBridge?.showToast(
        '⚠️ 500KB 초과 동영상은 클라우드 크기 제한으로 현재 기기에만 남고 사진/짧은 영상은 동기화됩니다.'
      );
    }
  },

  async updatePlaceQuickStatus(place: LocalPlace): Promise<void> {
    if (!currentUser) return;
    const uid = currentUser.uid;
    const placeId = sanitizeId(place.id, 'p');
    const path = `users/${uid}/places/${placeId}`;
    try {
      await updateDoc(doc(db, 'users', uid, 'places', placeId), {
        status: sanitizeStatus(place.status),
        doneItems: clampStringList(place.doneItems, 50, 120),
        todoItems: clampStringList(place.todoItems, 50, 120),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  },

  async updatePlaceSyncedInfo(place: LocalPlace): Promise<void> {
    if (!currentUser) return;
    const uid = currentUser.uid;
    const placeId = sanitizeId(place.id, 'p');
    const path = `users/${uid}/places/${placeId}`;
    try {
      await updateDoc(doc(db, 'users', uid, 'places', placeId), {
        link: clampStr(place.link, 1000),
        address: clampStr(place.address, 300),
        hours: clampStr(place.hours, 200),
        memo: clampStr(place.memo, 2000),
        lastSynced: clampStr(place.lastSynced, 100),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  },

  async deletePlaceAndMedia(placeId: string): Promise<void> {
    if (!currentUser) return;
    const uid = currentUser.uid;
    const cleanPlaceId = sanitizeId(placeId, 'p');
    const batch = writeBatch(db);
    batch.delete(doc(db, 'users', uid, 'places', cleanPlaceId));
    const mediaIds = knownMediaIdsByPlace.get(cleanPlaceId) || [];
    mediaIds.forEach((mId) => {
      batch.delete(doc(db, 'users', uid, 'media', mId));
    });
    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `users/${uid}/places/${cleanPlaceId}`);
    }
  },

  async clearAllPlacesAndMedia(): Promise<void> {
    if (!currentUser) return;
    const uid = currentUser.uid;
    let batch = writeBatch(db);
    let opCount = 0;
    const flush = async (force = false) => {
      if (opCount >= 400 || (force && opCount > 0)) {
        try {
          await batch.commit();
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `users/${uid}`);
        }
        batch = writeBatch(db);
        opCount = 0;
      }
    };

    for (const placeId of knownPlaceIds) {
      batch.delete(doc(db, 'users', uid, 'places', placeId));
      opCount++;
      await flush();
    }
    for (const mediaIds of knownMediaIdsByPlace.values()) {
      for (const mId of mediaIds) {
        batch.delete(doc(db, 'users', uid, 'media', mId));
        opCount++;
        await flush();
      }
    }
    await flush(true);
  },

  async replaceAllCloudData(
    categories: LocalCategory[],
    places: LocalPlace[],
    currentMoodId: string,
    currentLayout: string
  ): Promise<void> {
    if (!currentUser) return;
    const uid = currentUser.uid;

    // Delete existing categories, places, and media
    let batch = writeBatch(db);
    let opCount = 0;
    const flush = async (force = false) => {
      if (opCount >= 400 || (force && opCount > 0)) {
        try {
          await batch.commit();
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `users/${uid}`);
        }
        batch = writeBatch(db);
        opCount = 0;
      }
    };

    for (const catId of knownCategoryIds) {
      batch.delete(doc(db, 'users', uid, 'categories', catId));
      opCount++;
      await flush();
    }
    for (const placeId of knownPlaceIds) {
      batch.delete(doc(db, 'users', uid, 'places', placeId));
      opCount++;
      await flush();
    }
    for (const mediaIds of knownMediaIdsByPlace.values()) {
      for (const mId of mediaIds) {
        batch.delete(doc(db, 'users', uid, 'media', mId));
        opCount++;
        await flush();
      }
    }
    await flush(true);

    await this.savePreferences(currentMoodId, currentLayout);
    if (categories.length > 0 || places.length > 0) {
      await uploadSnapshotToFirestore(uid, categories, places);
    }
  },
};

window.cloudSync = cloudSyncApi;
emitAuthStatus(false);
