import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '1mb' }));

interface CategoryInput {
  id: string;
  name: string;
  fields?: string[];
}

interface UserLocation {
  lat: number;
  lng: number;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('서버에 GEMINI_API_KEY가 설정되어 있지 않습니다. Settings > Secrets 패널을 확인해 주세요.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
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

  // Fallback: 주소 검색 (사용자가 지번/도로명 주소만 입력한 경우)
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

app.post('/api/places/search', async (req: Request, res: Response) => {
  try {
    const { query, categories, userLocation } = req.body as {
      query?: string;
      categories?: CategoryInput[];
      userLocation?: UserLocation;
    };

    if (!query || typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: '검색할 장소 이름 또는 지도 링크를 입력해 주세요.' });
      return;
    }

    const kakaoRestApiKey = process.env.KAKAO_REST_API_KEY?.trim();
    if (!kakaoRestApiKey) {
      res.status(500).json({
        error: '서버에 KAKAO_REST_API_KEY가 설정되어 있지 않습니다. Settings > Secrets 패널에서 Kakao REST API 키를 설정해 주세요.',
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
      res.json({ placeInfo: cached.placeInfo });
      return;
    }

    const placeInfo = await searchPlacesWithKakaoLocal(kakaoRestApiKey, query, safeCategories, userLocation);

    searchCache.set(cacheKey, {
      placeInfo,
      expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
    });
    res.json({ placeInfo });
  } catch (error: unknown) {
    const errObj = error as { status?: number; message?: string };
    const status = errObj?.status;

    if (status === 401 || status === 403 || status === 400) {
      res.status(status).json({
        error: '카카오 REST API 키(KAKAO_REST_API_KEY)가 유효하지 않거나 카카오 로컬 API 활성화가 필요합니다. Settings > Secrets 및 카카오 개발자 콘솔을 확인해 주세요.',
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

    console.error('Kakao Local place search error:', error);
    res.status(500).json({
      error: errObj?.message || '카카오 로컬 API에서 장소 정보를 불러오지 못했습니다. 지역명을 함께 입력하거나 직접 입력해 주세요.',
    });
  }
});

interface SummaryBadge {
  label: string;
  value: string;
}

interface MemoSummary {
  headline: string;
  badges: SummaryBadge[];
}

const SUMMARIZE_CACHE_TTL_MS = 10 * 60 * 1000;
const SUMMARIZE_DEADLINE_MS = 10000;
const summarizeCache = new Map<string, { summary: MemoSummary; expiresAt: number }>();

app.post('/api/places/summarize', async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as {
      name?: string;
      categoryName?: string;
      memo?: string;
      doneItems?: string[];
      todoItems?: string[];
      customValues?: Record<string, string>;
    };

    const memo = typeof body.memo === 'string' ? body.memo.trim() : '';
    if (!memo) {
      res.status(400).json({ error: '요약할 메모 내용이 없습니다.' });
      return;
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const categoryName = typeof body.categoryName === 'string' ? body.categoryName.trim() : '';
    const doneItems = Array.isArray(body.doneItems) ? body.doneItems.filter(Boolean).slice(0, 8) : [];
    const todoItems = Array.isArray(body.todoItems) ? body.todoItems.filter(Boolean).slice(0, 8) : [];
    const customValues = body.customValues && typeof body.customValues === 'object' ? body.customValues : {};

    const cacheKey = JSON.stringify({ name, categoryName, memo, doneItems, todoItems, customValues });
    const cached = summarizeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json({ summary: cached.summary });
      return;
    }

    const contextLines = [
      name ? `장소명: ${name}` : '',
      categoryName ? `카테고리: ${categoryName}` : '',
      `메모 원문:\n${memo}`,
      doneItems.length ? `경험/메뉴 참고: ${doneItems.join(', ')}` : '',
      todoItems.length ? `다음에 할 것 참고: ${todoItems.join(', ')}` : '',
      Object.keys(customValues).length
        ? `맞춤 항목 참고: ${Object.entries(customValues).map(([k, v]) => `${k}=${v}`).join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const ai = getGeminiClient();
    const response = await withTimeout(
      ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `아래 장소 기록의 [메모 원문]을 중심으로 핵심 정보를 한국어로 깔끔하게 요약해 주세요.\n\n${contextLines}`,
        config: {
          systemInstruction:
            '당신은 개인 공간 기록 노트의 핵심 요약 도우미입니다. 반드시 메모 원문에 실제로 적힌 사실만 바탕으로 추천 메뉴, 분위기, 방문 팁, 주차/좌석, 주의사항 등 핵심 배지 2~4개와 짧은 한 줄 요약(headline)을 작성하세요. 메모에 없는 사실은 추측하거나 지어내지 마세요.',
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              headline: {
                type: Type.STRING,
                description: '메모 핵심을 담은 짧은 한 줄 요약 (공백 포함 32자 이내)',
              },
              badges: {
                type: Type.ARRAY,
                description: '추천 메뉴, 분위기, 방문 팁 등 핵심 키워드 배지 2~4개',
                items: {
                  type: Type.OBJECT,
                  properties: {
                    label: {
                      type: Type.STRING,
                      description: '짧은 분류명 (예: 추천 메뉴, 분위기, 방문 팁, 주차, 좌석)',
                    },
                    value: {
                      type: Type.STRING,
                      description: '핵심 내용 (공백 포함 18자 이내)',
                    },
                  },
                  required: ['label', 'value'],
                },
              },
            },
            required: ['headline', 'badges'],
          },
        },
      }),
      SUMMARIZE_DEADLINE_MS
    );

    const rawText = (response.text ?? '{}').trim();
    const parsed = JSON.parse(rawText) as Partial<MemoSummary>;

    const cleanBadges = Array.isArray(parsed.badges)
      ? parsed.badges
          .filter((b): b is SummaryBadge => Boolean(b && typeof b.label === 'string' && typeof b.value === 'string'))
          .map((b) => ({
            label: b.label.trim().slice(0, 14),
            value: b.value.trim().slice(0, 30),
          }))
          .filter((b) => b.label && b.value)
          .slice(0, 4)
      : [];

    const summary: MemoSummary = {
      headline: typeof parsed.headline === 'string' ? parsed.headline.trim().slice(0, 60) : '',
      badges: cleanBadges,
    };

    if (!summary.headline && summary.badges.length === 0) {
      throw new Error('메모에서 요약할 핵심 정보를 추출하지 못했습니다.');
    }

    summarizeCache.set(cacheKey, {
      summary,
      expiresAt: Date.now() + SUMMARIZE_CACHE_TTL_MS,
    });

    res.json({ summary });
  } catch (error: unknown) {
    const errObj = error as { status?: number; message?: string };
    const status = errObj?.status;

    if (status === 403 || status === 400) {
      res.status(status).json({
        error: 'API 키가 유효하지 않거나 권한이 없습니다. Settings > Secrets 패널에서 GEMINI_API_KEY를 확인해 주세요.',
      });
      return;
    }
    if (status === 429) {
      res.status(429).json({
        error: '현재 API 요청 한도(할당량)를 초과했습니다. 잠시 후 다시 시도해 주세요.',
      });
      return;
    }
    if (status === 503 || status === 504) {
      res.status(status).json({
        error: 'AI 요약 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.',
      });
      return;
    }

    console.error('Gemini memo summarize error:', error);
    res.status(500).json({
      error: errObj?.message || '메모 AI 요약을 생성하지 못했습니다.',
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
