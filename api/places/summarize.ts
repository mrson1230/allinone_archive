import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

interface ServerlessRequest {
  method?: string;
  body?: unknown;
}

interface ServerlessResponse {
  status(code: number): ServerlessResponse;
  json(payload: unknown): void;
}

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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('요약 요청 시간이 초과되었습니다.') as Error & { status?: number };
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

export default async function handler(req: ServerlessRequest, res: ServerlessResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

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
      res.status(200).json({ summary: cached.summary });
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

    res.status(200).json({ summary });
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
}
