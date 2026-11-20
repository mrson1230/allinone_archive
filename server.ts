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

async function generatePlaceSearchResponse(ai: GoogleGenAI, prompt: string) {
  const attempts: Array<{ model: string; useSearch: boolean }> = [
    { model: 'gemini-4-hydrogen', useSearch: true },
    { model: 'gemini-3.1-flash-lite', useSearch: true },
    { model: 'gemini-4-hydrogen', useSearch: false },
    { model: 'gemini-3.1-flash-lite', useSearch: false },
  ];
  let lastError: unknown;

  for (const { model, useSearch } of attempts) {
    try {
      const config: Record<string, unknown> = {};
      if (useSearch) {
        config.tools = [{ googleSearch: {} }];
      }
      if (model === 'gemini-4-hydrogen') {
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
      }
      return await ai.models.generateContent({
        model,
        contents: prompt,
        ...(Object.keys(config).length > 0 ? { config } : {}),
      });
    } catch (error: unknown) {
      lastError = error;
      const status = (error as { status?: number })?.status;
      const shouldFallback =
        status === 429 ||
        status === 503 ||
        status === 500 ||
        status === 404 ||
        status === 403 ||
        status === 400;
      if (!shouldFallback) {
        throw error;
      }
    }
  }

  throw lastError;
}

app.post('/api/places/search', async (req: Request, res: Response) => {
  try {
    const { query, categories } = req.body as {
      query?: string;
      categories?: CategoryInput[];
    };

    if (!query || typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: '검색할 장소 링크 또는 가게 이름을 입력해 주세요.' });
      return;
    }

    const safeCategories = Array.isArray(categories) ? categories : [];
    const categoryKey = safeCategories.map((c) => c.id).join(',');
    const cacheKey = `${query.trim().toLowerCase()}::${categoryKey}`;
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json({ placeInfo: cached.placeInfo });
      return;
    }

    const ai = getGeminiClient();

    const categoryListDesc = safeCategories
      .map((c) => `${c.id} (${c.name}: ${(c.fields || []).join(', ')})`)
      .join(' / ');

    const prompt = `사용자가 입력한 장소 정보 또는 URL: "${query.trim()}"
위 장소에 대해 Google 실시간 검색을 수행하여 정확한 실제 정보를 찾아 아래 JSON 형식으로만 응답해줘. 마크다운 코드블록 없이 순수 JSON 객체만 출력해.
- categoryId: 다음 카테고리 중 가장 적합한 id 선택 [${categoryListDesc}]
- name: 실제 공식 상호명
- address: 실제 도로명 주소 (지점이 여러 개인 경우 입력된 지역/지점의 정확한 도로명 주소)
- hours: 실제 영업시간 및 휴무일 요약
- todoItems: 대표 추천 메뉴 또는 즐길 거리 2~3개 (쉼표로 구분된 문자열)
- memo: 주차 여부, 특징, 방문 꿀팁 한 줄 요약
- customFields: 선택한 카테고리의 전용 기록 항목 이름(원문 키 이름 그대로)을 키로 사용하는 키-값 객체`;

    const response = await generatePlaceSearchResponse(ai, prompt);

    const rawText = response.text ?? '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      res.status(502).json({ error: '검색 결과를 구조화하지 못했습니다.' });
      return;
    }

    const placeInfo = JSON.parse(jsonMatch[0]);
    if (Array.isArray(placeInfo.todoItems)) {
      placeInfo.todoItems = placeInfo.todoItems.join(', ');
    }
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
    if (status === 503) {
      res.status(503).json({
        error: '현재 AI 서버 사용량이 많아 응답이 지연되고 있습니다. 잠시 후 다시 눌러 주세요.',
      });
      return;
    }

    console.error('Gemini place search error:', error);
    res.status(500).json({
      error: errObj?.message || '장소 정보를 불러오는 중 오류가 발생했습니다.',
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
