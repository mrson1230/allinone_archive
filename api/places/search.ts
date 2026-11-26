interface CategoryInput {
  id: string;
  name: string;
  fields?: string[];
}

interface UserLocation {
  lat: number;
  lng: number;
}

interface KakaoPlaceDocument {
  id?: string;
  place_name?: string;
  category_name?: string;
  category_group_code?: string;
  category_group_name?: string;
  phone?: string;
  address_name?: string;
  road_address_name?: string;
  x?: string;
  y?: string;
  place_url?: string;
}

interface KakaoAddressDocument {
  address_name?: string;
  road_address?: {
    address_name?: string;
    building_name?: string;
  } | null;
  x?: string;
  y?: string;
}

interface ServerlessRequest {
  method?: string;
  body?: unknown;
}

interface ServerlessResponse {
  status(code: number): ServerlessResponse;
  json(payload: unknown): void;
}

const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map<string, { placeInfo: unknown; expiresAt: number }>();

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('요청 시간이 초과되었습니다.') as Error & { status?: number };
      err.status = 504;
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isSafePublicHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolveUrlHint(rawQuery: string): Promise<{ finalUrl?: string; title?: string; description?: string }> {
  const trimmed = rawQuery.trim();
  if (!/^https?:\/\//i.test(trimmed) || !isSafePublicHttpUrl(trimmed)) {
    return {};
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2200);
  try {
    const resp = await fetch(trimmed, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DangolNote/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    const finalUrl = resp.url && isSafePublicHttpUrl(resp.url) ? resp.url : trimmed;
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return { finalUrl };
    }
    const html = (await resp.text()).slice(0, 32768);
    const ogTitleMatch =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const ogDescMatch =
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);

    const title = decodeHtmlEntities(ogTitleMatch?.[1] || titleMatch?.[1] || '').slice(0, 160);
    const description = decodeHtmlEntities(ogDescMatch?.[1] || '').slice(0, 260);
    return { finalUrl, title, description };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

function cleanPlaceQueryFromTitle(title: string): string {
  return title
    .replace(/\s*[-|:]\s*(네이버\s*지도|네이버\s*플레이스|네이버|카카오맵|카카오|Google\s*지도|Google\s*Maps).*$/i, '')
    .trim();
}

function mapKakaoCategoryToAppCategory(
  groupCode: string,
  categoryName: string,
  safeCategories: CategoryInput[]
): string {
  const availableIds = new Set(safeCategories.map((c) => c.id));
  const code = (groupCode || '').toUpperCase();
  const text = (categoryName || '').toLowerCase();

  const findByKeywords = (keywords: string[]) =>
    safeCategories.find((c) => keywords.some((kw) => c.name.toLowerCase().includes(kw)))?.id;

  if (code === 'FD6' || text.includes('음식점') || text.includes('식당')) {
    if (availableIds.has('food')) return 'food';
    return findByKeywords(['식당', '맛집', '음식', '밥']) || '';
  }
  if (code === 'CE7' || text.includes('카페') || text.includes('디저트') || text.includes('커피')) {
    if (availableIds.has('cafe')) return 'cafe';
    return findByKeywords(['카페', '커피', '디저트']) || '';
  }
  if (code === 'AD5' || text.includes('숙박') || text.includes('펜션') || text.includes('호텔') || text.includes('모텔') || text.includes('캠핑')) {
    if (availableIds.has('stay')) return 'stay';
    return findByKeywords(['펜션', '숙소', '호텔', '숙박', '캠핑']) || '';
  }
  if (
    code === 'AT4' ||
    code === 'CT1' ||
    text.includes('관광') ||
    text.includes('명소') ||
    text.includes('공원') ||
    text.includes('문화') ||
    text.includes('레저') ||
    text.includes('여가')
  ) {
    if (availableIds.has('play')) return 'play';
    return findByKeywords(['놀이터', '여가', '여행', '명소', '산', '바다']) || '';
  }

  return '';
}

function normalizeKakaoPlaceUrl(rawUrl: string | undefined, placeName: string, x?: string, y?: string): string {
  const trimmed = String(rawUrl || '').trim();
  if (/^https?:\/\/place\.map\.kakao\.com\//i.test(trimmed)) {
    return trimmed.replace(/^http:\/\//i, 'https://');
  }
  if (x && y && placeName) {
    return `https://map.kakao.com/link/map/${encodeURIComponent(placeName)},${encodeURIComponent(y)},${encodeURIComponent(x)}`;
  }
  return `https://map.kakao.com/link/search/${encodeURIComponent(placeName)}`;
}

async function searchPlacesWithKakaoLocal(
  kakaoRestApiKey: string,
  rawQuery: string,
  safeCategories: CategoryInput[],
  userLocation?: UserLocation
) {
  const trimmedInput = rawQuery.trim();
  const isUrlInput = /^https?:\/\//i.test(trimmedInput);
  let searchKeyword = trimmedInput;

  if (isUrlInput) {
    const urlHint = await resolveUrlHint(trimmedInput);
    const cleanedTitle = urlHint.title ? cleanPlaceQueryFromTitle(urlHint.title) : '';
    if (!cleanedTitle) {
      const err = new Error('입력한 링크에서 가게 이름을 자동으로 읽지 못했습니다. 가게 이름과 지점명을 직접 입력해 주세요.') as Error & { status?: number };
      err.status = 422;
      throw err;
    }
    searchKeyword = cleanedTitle;
  }

  const params = new URLSearchParams({
    query: searchKeyword,
    size: '5',
    sort: 'accuracy',
  });
  if (
    userLocation &&
    typeof userLocation.lat === 'number' &&
    typeof userLocation.lng === 'number' &&
    Number.isFinite(userLocation.lat) &&
    Number.isFinite(userLocation.lng) &&
    userLocation.lat >= -90 &&
    userLocation.lat <= 90 &&
    userLocation.lng >= -180 &&
    userLocation.lng <= 180
  ) {
    params.set('y', String(userLocation.lat));
    params.set('x', String(userLocation.lng));
  }

  const keywordResp = await withTimeout(
    fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?${params.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `KakaoAK ${kakaoRestApiKey}`,
      },
    }),
    6500
  );

  if (!keywordResp.ok) {
    const err = new Error(`카카오 로컬 API 요청 실패 (${keywordResp.status})`) as Error & { status?: number };
    err.status = keywordResp.status;
    throw err;
  }

  const keywordData = (await keywordResp.json()) as { documents?: KakaoPlaceDocument[] };
  const docs = Array.isArray(keywordData.documents) ? keywordData.documents : [];

  if (docs.length > 0) {
    const top = docs[0];
    const topName = (top.place_name || searchKeyword).trim();
    const topAddress = (top.road_address_name || top.address_name || '').trim();
    const topPhone = (top.phone || '').trim();
    const topCategoryName = (top.category_name || top.category_group_name || '').trim();
    const topCategoryId = mapKakaoCategoryToAppCategory(top.category_group_code || '', topCategoryName, safeCategories);
    const topMapUrl = normalizeKakaoPlaceUrl(top.place_url, topName, top.x, top.y);

    const memoParts = [
      topCategoryName ? `분류: ${topCategoryName}` : '',
      topPhone ? `☎ ${topPhone}` : '',
    ].filter(Boolean);

    const mapCandidates = docs.slice(0, 4).map((doc) => {
      const cName = (doc.place_name || '').trim();
      const cAddr = (doc.road_address_name || doc.address_name || '').trim();
      const cCatName = (doc.category_name || doc.category_group_name || '').trim();
      const cCatId = mapKakaoCategoryToAppCategory(doc.category_group_code || '', cCatName, safeCategories);
      return {
        title: cAddr ? `${cName} (${cAddr})` : cName,
        name: cName,
        address: cAddr,
        phone: (doc.phone || '').trim(),
        categoryName: cCatName,
        categoryId: cCatId,
        uri: normalizeKakaoPlaceUrl(doc.place_url, cName, doc.x, doc.y),
        x: doc.x || '',
        y: doc.y || '',
      };
    });

    return {
      categoryId: topCategoryId,
      name: topName,
      address: topAddress,
      hours: '',
      todoItems: '',
      memo: memoParts.join(' · '),
      customFields: {},
      mapUrl: topMapUrl,
      mapCandidates,
      x: top.x || '',
      y: top.y || '',
      sourceType: 'kakao_local',
    };
  }

  const addrParams = new URLSearchParams({ query: searchKeyword, size: '3' });
  const addrResp = await withTimeout(
    fetch(`https://dapi.kakao.com/v2/local/search/address.json?${addrParams.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `KakaoAK ${kakaoRestApiKey}`,
      },
    }),
    5000
  );

  if (addrResp.ok) {
    const addrData = (await addrResp.json()) as { documents?: KakaoAddressDocument[] };
    const addrDocs = Array.isArray(addrData.documents) ? addrData.documents : [];
    if (addrDocs.length > 0) {
      const topAddr = addrDocs[0];
      const roadAddr = (topAddr.road_address?.address_name || topAddr.address_name || searchKeyword).trim();
      const bldgName = (topAddr.road_address?.building_name || '').trim();
      const displayName = bldgName || searchKeyword;
      const mapUrl =
        topAddr.x && topAddr.y
          ? `https://map.kakao.com/link/map/${encodeURIComponent(displayName)},${encodeURIComponent(topAddr.y)},${encodeURIComponent(topAddr.x)}`
          : `https://map.kakao.com/link/search/${encodeURIComponent(roadAddr)}`;

      return {
        categoryId: '',
        name: displayName,
        address: roadAddr,
        hours: '',
        todoItems: '',
        memo: '',
        customFields: {},
        mapUrl,
        mapCandidates: addrDocs.slice(0, 3).map((d) => {
          const rAddr = (d.road_address?.address_name || d.address_name || '').trim();
          const bName = (d.road_address?.building_name || rAddr).trim();
          return {
            title: rAddr,
            name: bName,
            address: rAddr,
            uri:
              d.x && d.y
                ? `https://map.kakao.com/link/map/${encodeURIComponent(bName)},${encodeURIComponent(d.y)},${encodeURIComponent(d.x)}`
                : `https://map.kakao.com/link/search/${encodeURIComponent(rAddr)}`,
            x: d.x || '',
            y: d.y || '',
          };
        }),
        x: topAddr.x || '',
        y: topAddr.y || '',
        sourceType: 'kakao_local',
      };
    }
  }

  const notFoundErr = new Error('카카오 로컬에서 일치하는 장소를 찾지 못했습니다. 가게 이름과 지역명(예: OO동/OO역)을 함께 입력해 주세요.') as Error & { status?: number };
  notFoundErr.status = 422;
  throw notFoundErr;
}

export default async function handler(req: ServerlessRequest, res: ServerlessResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const parsedBody =
      typeof req.body === 'string'
        ? (JSON.parse(req.body || '{}') as {
            query?: string;
            categories?: CategoryInput[];
            userLocation?: UserLocation;
          })
        : ((req.body || {}) as {
            query?: string;
            categories?: CategoryInput[];
            userLocation?: UserLocation;
          });

    const { query, categories, userLocation } = parsedBody;
    if (!query || typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: '검색할 장소 이름 또는 지도 링크를 입력해 주세요.' });
      return;
    }

    const kakaoRestApiKey = process.env.KAKAO_REST_API_KEY?.trim();
    if (!kakaoRestApiKey) {
      res.status(500).json({
        error: '서버에 KAKAO_REST_API_KEY가 설정되어 있지 않습니다. 배포 환경변수(KAKAO_REST_API_KEY)를 설정해 주세요.',
      });
      return;
    }

    const safeCategories = Array.isArray(categories) ? categories : [];
    const categoryKey = safeCategories.map((c) => c.id).join(',');
    const locKey =
      userLocation && Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng)
        ? `${userLocation.lat.toFixed(2)},${userLocation.lng.toFixed(2)}`
        : 'noloc';
    const cacheKey = `kakao::${query.trim().toLowerCase()}::${categoryKey}::${locKey}`;
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.status(200).json({ placeInfo: cached.placeInfo });
      return;
    }

    const placeInfo = await searchPlacesWithKakaoLocal(kakaoRestApiKey, query, safeCategories, userLocation);
    searchCache.set(cacheKey, {
      placeInfo,
      expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
    });
    res.status(200).json({ placeInfo });
  } catch (error: unknown) {
    const errObj = error as { status?: number; message?: string };
    const status = errObj?.status;

    if (status === 401 || status === 403 || status === 400) {
      res.status(status).json({
        error: '카카오 REST API 키(KAKAO_REST_API_KEY)가 유효하지 않거나 카카오 로컬 API 활성화가 필요합니다. 환경변수 및 카카오 개발자 콘솔을 확인해 주세요.',
      });
      return;
    }
    if (status === 422) {
      res.status(422).json({
        error: errObj?.message || '일치하는 장소를 찾지 못했습니다.',
      });
      return;
    }
    if (status === 429) {
      res.status(429).json({
        error: '카카오 로컬 API 요청 한도(할당량)를 초과했습니다. 잠시 후 다시 시도해 주세요.',
      });
      return;
    }
    if (status === 503 || status === 504) {
      res.status(status).json({
        error: '카카오 로컬 지도 검색 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.',
      });
      return;
    }

    console.error('Serverless Kakao Local place search error:', error);
    res.status(500).json({
      error: errObj?.message || '카카오 로컬 API에서 장소 정보를 불러오지 못했습니다. 지역명을 함께 입력하거나 직접 입력해 주세요.',
    });
  }
}
