import { GoogleGenAI, type GoogleGenAIOptions } from '@google/genai';

type RuntimeEnvironment = Record<string, string | undefined>;

const getRuntimeEnvironment = (): RuntimeEnvironment | undefined =>
  typeof process === 'undefined' ? undefined : process.env;

export function getGoogleGenAIRuntimeEnvironment(): RuntimeEnvironment {
  return getRuntimeEnvironment() || {};
}

export function resolveGoogleGenAIOptions(
  env = getRuntimeEnvironment(),
  apiKeyOverride?: string
): GoogleGenAIOptions | null {
  if (!env) return null;

  const apiKey = apiKeyOverride?.trim() || env.GEMINI_API_KEY?.trim();
  const projectId = env.GOOGLE_PROJECT_ID?.trim();
  const projectNumber = env.GOOGLE_PROJECT_NUMBER?.trim();
  const useVertexAI = env.GOOGLE_GENAI_USE_VERTEXAI?.toLowerCase() === 'true';
  const location = env.GOOGLE_CLOUD_LOCATION?.trim() || 'us-central1';

  if (projectNumber && !/^\d+$/.test(projectNumber)) {
    throw new Error('GOOGLE_PROJECT_NUMBER must contain only digits.');
  }

  if (useVertexAI) {
    if (!projectId) {
      throw new Error('GOOGLE_PROJECT_ID is required when GOOGLE_GENAI_USE_VERTEXAI=true.');
    }

    return {
      vertexai: true,
      project: projectId,
      location,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    };
  }

  if (apiKey && apiKey !== 'MY_GEMINI_API_KEY') {
    return {
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    };
  }

  return null;
}

export function createGoogleGenAIClient(apiKeyOverride?: string): GoogleGenAI | null {
  const options = resolveGoogleGenAIOptions(undefined, apiKeyOverride);
  return options ? new GoogleGenAI(options) : null;
}
