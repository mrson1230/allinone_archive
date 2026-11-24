import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

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

interface MapCandidate {
  title: string;
  uri: string;
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
const TOTAL_SEARCH_DEADLINE_MS = 12000;
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

function extractGroundingMaps(response: unknown): MapCandidate[] {
  const candidates = (response as { candidates?: Array<{ groundingMetadata?: { groundingChunks?: Array<{ maps?: { uri?: string; title?: string } }> } }> })?.candidates;
  const chunks = candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set<string>();
  const results: MapCandidate[] = [];
  for (const chunk of chunks) {
    const uri = chunk?.maps?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    results.push({
      title: String(chunk?.maps?.title || '').trim(),
      uri,
    });
  }
  return results;
}

async function generateGroundedPlaceInfo(
  ai: GoogleGenAI,
  rawQuery: string,
  safeCategories: CategoryInput[],
  userLocation?: UserLocation
) {
  const startedAt = Date.now();
  const isUrlInput = /^https?:\/\//i.test(rawQuery.trim());
  const urlHint = isUrlInput ? await resolveUrlHint(rawQuery) : {};

  const searchSubject = [
    urlHint.title ? `페이지 제목: "${urlHint.title}"` : '',
    urlHint.description ? `설명: "${urlHint.description}"` : '',
    urlHint.finalUrl && urlHint.finalUrl !== rawQuery.trim() ? `최종 URL: ${urlHint.finalUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const categoryListDesc = safeCategories
    .map((c) => `${c.id} (${c.name}: ${(c.fields || []).join(', ')})`)
    .join(' / ');

  const mapsPrompt = `사용자가 찾는 실제 장소: "${rawQuery.trim()}"
${searchSubject ? `[링크에서 추출한 단서]\n${searchSubject}\n` : ''}
Google 지도(Maps)에서 위 장소의 실제 공식 정보를 조회해서 아래 항목을 한국어로 정확히 정리해줘.
모르거나 확인되지 않은 주소·지점은 절대 추측하지 마.
- 공식 상호명:
- 정확한 도로명 주소 (지점이 여러 개라면 입력된 지역/단서에 맞는 정확한 지점 주소):
- 영업시간 및 휴무일:
- 대표 추천 메뉴 또는 즐길 거리 2~3개:
- 주차 여부 및 방문 꿀팁 1줄:
- 가장 알맞은 카테고리 ID (${categoryListDesc}):`;

  const searchPrompt = `사용자 입력: "${rawQuery.trim()}"
${searchSubject ? `[링크에서 추출한 단서]\n${searchSubject}\n` : ''}
Google 웹 검색을 통해 위 실제 장소의 공식 상호명, 정확한 도로명 주소, 영업시간, 추천 메뉴/즐길 거리, 방문 팁을 확인해 정리해줘. 확인되지 않은 주소는 절대 추측하지 마.`;

  let groundedText = '';
  let mapCandidates: MapCandidate[] = [];
  let sourceType: 'google_maps' | 'google_search' = 'google_maps';

  const mapsConfig: Record<string, unknown> = {
    tools: [{ googleMaps: {} }],
    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
  };
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
    mapsConfig.toolConfig = {
      retrievalConfig: {
        latLng: {
          latitude: userLocation.lat,
          longitude: userLocation.lng,
        },
      },
    };
  }

  let mapsError: unknown = null;
  try {
    const remainingMs = TOTAL_SEARCH_DEADLINE_MS - (Date.now() - startedAt);
    const mapsResp = await withTimeout(
      ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: mapsPrompt,
        config: mapsConfig,
      }),
      Math.min(7500, Math.max(3000, remainingMs - 2500))
    );
    groundedText = mapsResp.text ?? '';
    mapCandidates = extractGroundingMaps(mapsResp);
  } catch (err) {
    mapsError = err;
  }

  if (!groundedText.trim() || (isUrlInput && mapCandidates.length === 0)) {
    const remainingMs = TOTAL_SEARCH_DEADLINE_MS - (Date.now() - startedAt);
    if (remainingMs >= 2500) {
      try {
        const searchResp = await withTimeout(
          ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: searchPrompt,
            config: {
              tools: [{ googleSearch: {} }],
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            },
          }),
          Math.min(6000, remainingMs - 1500)
        );
        const searchText = searchResp.text ?? '';
        if (searchText.trim()) {
          groundedText = groundedText.trim()
            ? `${groundedText}\n\n[웹 검색 보완]\n${searchText}`
            : searchText;
          sourceType = mapCandidates.length > 0 ? 'google_maps' : 'google_search';
        }
      } catch (searchErr) {
        if (!groundedText.trim()) {
          throw mapsError || searchErr;
        }
      }
    }
  }

  if (!groundedText.trim()) {
    throw mapsError || new Error('실제 지도 검색 결과를 찾지 못했습니다.');
  }

  const remainingForStructuring = TOTAL_SEARCH_DEADLINE_MS - (Date.now() - startedAt);
  const structuringPrompt = `아래 [지도/검색 결과]에 있는 사실만 JSON으로 정확히 추출해.
규칙:
1. 결과에 없는 주소·상호·영업시간을 절대 지어내지 말고, 확인되지 않으면 빈 문자열("")로 둬.
2. categoryId는 다음 중 가장 적절한 id 하나만 선택: [${categoryListDesc}]
3. todoItems는 쉼표로 구분된 문자열 1개.
4. customFields는 선택한 카테고리의 전용 기록 항목 키(원문 그대로)만 채운 객체.

[사용자 입력]
${rawQuery.trim()}

[지도/검색 결과]
${groundedText}

[확인된 지도 링크]
${mapCandidates.map((m, i) => `${i + 1}. ${m.title}: ${m.uri}`).join('\n') || '없음'}

반환 JSON 키:
{
  "categoryId": "",
  "name": "",
  "address": "",
  "hours": "",
  "todoItems": "",
  "memo": "",
  "customFields": {}
}`;

  const structResp = await withTimeout(
    ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: structuringPrompt,
      config: {
        responseMimeType: 'application/json',
      },
    }),
    Math.max(2500, Math.min(4000, remainingForStructuring))
  );

  const rawJsonText = structResp.text ?? '';
  const jsonMatch = rawJsonText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('검색 결과를 구조화하지 못했습니다.');
  }

  const placeInfo = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  if (Array.isArray(placeInfo.todoItems)) {
    placeInfo.todoItems = placeInfo.todoItems.join(', ');
  }

  const cleanName = typeof placeInfo.name === 'string' ? placeInfo.name.trim() : '';
  const cleanAddr = typeof placeInfo.address === 'string' ? placeInfo.address.trim() : '';
  const fallbackGoogleMapsUrl =
    cleanName || cleanAddr
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([cleanAddr, cleanName].filter(Boolean).join(' '))}`
      : '';

  placeInfo.mapUrl = mapCandidates[0]?.uri || fallbackGoogleMapsUrl;
  placeInfo.mapCandidates = mapCandidates.slice(0, 4);
  placeInfo.sourceType = sourceType;

  return placeInfo;
}

app.post('/api/places/search', async (req: Request, res: Response) => {
  try {
    const { query, categories, userLocation } = req.body as {
      query?: string;
      categories?: CategoryInput[];
      userLocation?: UserLocation;
    };

    if (!query || typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: '검색할 장소 링크 또는 가게 이름을 입력해 주세요.' });
      return;
    }

    const safeCategories = Array.isArray(categories) ? categories : [];
    const categoryKey = safeCategories.map((c) => c.id).join(',');
    const locKey =
      userLocation && Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng)
        ? `${userLocation.lat.toFixed(2)},${userLocation.lng.toFixed(2)}`
        : 'noloc';
    const cacheKey = `${query.trim().toLowerCase()}::${categoryKey}::${locKey}`;
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json({ placeInfo: cached.placeInfo });
      return;
    }

    const ai = getGeminiClient();
    const placeInfo = await generateGroundedPlaceInfo(ai, query, safeCategories, userLocation);

    searchCache.set(cacheKey, {
      placeInfo,
      expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
    });
    res.json({ placeInfo });
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
        error: '현재 API 요청 한도(할당량)를 초과했습니다. 잠시 후 다시 시도하거나 Settings > Secrets 패널에서 결제가 연결된 API 키를 선택해 주세요.',
      });
      return;
    }
    if (status === 503 || status === 504) {
      res.status(status).json({
        error: '지도 검색 응답이 지연되고 있습니다. 지역명(예: OO동/OO역)을 함께 입력해 다시 시도해 주세요.',
      });
      return;
    }

    console.error('Gemini place search error:', error);
    res.status(500).json({
      error: errObj?.message || '정확한 장소 정보를 불러오지 못했습니다. 지역명을 함께 입력하거나 지도를 확인해 주세요.',
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
