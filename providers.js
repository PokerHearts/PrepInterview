/**
 * providers.js — Multi-Provider AI Abstraction Layer
 *
 * Client-side BYOK (Bring Your Own Key) provider registry and unified LLM
 * calling interface. All API calls go directly from the browser using the
 * user's own API key — no backend proxy required.
 *
 * Supported providers: Google Gemini, OpenAI, Groq, OpenRouter
 *
 * Usage:
 *   const result = await callLLM('gemini', apiKey, 'gemini-2.0-flash', messages, { temperature: 0.7, maxTokens: 1024 });
 *   console.log(result.text);
 */

/* =========================================================================
 * PROVIDER REGISTRY
 * ========================================================================= */

const PROVIDERS = {
  gemini: {
    name: 'Google Gemini',
    icon: '✦',
    models: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', tier: 'free' },
      { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', tier: 'free' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', tier: 'paid' }
    ],
    corsSupported: true,
    freeAvailable: true,
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyPlaceholder: 'AIzaSy...'
  },

  openai: {
    name: 'OpenAI',
    icon: '◎',
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', tier: 'paid' },
      { id: 'gpt-4o', name: 'GPT-4o', tier: 'paid' },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', tier: 'paid' }
    ],
    corsSupported: true,
    freeAvailable: false,
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-...'
  },

  groq: {
    name: 'Groq',
    icon: '⚡',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', tier: 'free' },
      { id: 'gemma2-9b-it', name: 'Gemma 2 9B', tier: 'free' },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', tier: 'free' }
    ],
    corsSupported: true,
    freeAvailable: true,
    keyUrl: 'https://console.groq.com/keys',
    keyPlaceholder: 'gsk_...'
  },

  openrouter: {
    name: 'OpenRouter',
    icon: '🔀',
    models: [
      { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash (Free)', tier: 'free' },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (Free)', tier: 'free' },
      { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', tier: 'paid' }
    ],
    corsSupported: true,
    freeAvailable: true,
    keyUrl: 'https://openrouter.ai/keys',
    keyPlaceholder: 'sk-or-...'
  }
};


/* =========================================================================
 * HELPER / UTILITY FUNCTIONS
 * ========================================================================= */

/**
 * Returns the full provider config object for a given key.
 * @param {string} key — Provider key (e.g. 'gemini', 'openai')
 * @returns {object|undefined} Provider config or undefined if not found
 */
function getProvider(key) {
  return PROVIDERS[key];
}

/**
 * Returns the array of models available for a provider.
 * @param {string} providerKey
 * @returns {Array<{id: string, name: string, tier: string}>}
 */
function getModels(providerKey) {
  const provider = PROVIDERS[providerKey];
  return provider ? provider.models : [];
}

/**
 * Returns all providers as a flat array with their registry key included.
 * Useful for rendering provider selection UI.
 * @returns {Array<{key: string, name: string, icon: string, models: Array, ...}>}
 */
function getProviderList() {
  return Object.entries(PROVIDERS).map(([key, config]) => ({
    key,
    ...config
  }));
}

/**
 * Basic format validation for an API key.
 * Checks expected prefix and minimum length per provider.
 * This is a client-side sanity check — it does NOT verify the key is active.
 *
 * @param {string} providerKey
 * @param {string} key — The API key string to validate
 * @returns {{ valid: boolean, message: string }}
 */
function validateApiKey(providerKey, key) {
  if (!key || typeof key !== 'string') {
    return { valid: false, message: 'API key is required.' };
  }

  const trimmed = key.trim();

  const rules = {
    gemini: { prefix: 'AIzaSy', minLength: 30, label: 'Google Gemini' },
    openai: { prefix: 'sk-', minLength: 20, label: 'OpenAI' },
    groq: { prefix: 'gsk_', minLength: 20, label: 'Groq' },
    openrouter: { prefix: 'sk-or-', minLength: 20, label: 'OpenRouter' }
  };

  const rule = rules[providerKey];
  if (!rule) {
    return { valid: false, message: `Unknown provider: ${providerKey}` };
  }

  if (!trimmed.startsWith(rule.prefix)) {
    return {
      valid: false,
      message: `${rule.label} keys should start with "${rule.prefix}".`
    };
  }

  if (trimmed.length < rule.minLength) {
    return {
      valid: false,
      message: `Key appears too short for ${rule.label}. Please check you copied the full key.`
    };
  }

  return { valid: true, message: 'Key format looks valid.' };
}


/* =========================================================================
 * PROVIDER ADAPTERS
 *
 * Each adapter converts the universal message format into the provider's
 * native API format, makes the fetch call, and normalises the response.
 *
 * Universal message format:
 *   [{ role: 'system'|'user'|'assistant', content: string }, ...]
 *
 * Return value on success:  { text: string }
 * On failure:               throws Error with descriptive message
 * ========================================================================= */

/**
 * Google Gemini adapter.
 *
 * - Uses the `systemInstruction` field for system messages.
 * - Maps 'user' → 'user' and 'assistant' → 'model' roles.
 * - API key is passed as a query parameter (no Authorization header).
 */
async function callGemini(apiKey, modelId, messages, config) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  // --- Convert universal messages to Gemini format ---

  // Extract system instruction (concatenate all system messages)
  const systemParts = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content);

  const systemInstruction =
    systemParts.length > 0
      ? { parts: [{ text: systemParts.join('\n\n') }] }
      : undefined;

  // Build contents array (user / model turns only)
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

  // Build request body
  const body = {
    contents,
    generationConfig: {
      temperature: config.temperature,
      maxOutputTokens: config.maxTokens
    }
  };

  // Only include systemInstruction if we have one
  if (systemInstruction) {
    body.systemInstruction = systemInstruction;
  }

  // --- Make the request ---
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok) {
    const errMsg = data.error?.message || `HTTP ${response.status}`;
    throw new Error(`Google Gemini API error: ${errMsg}`);
  }

  // --- Parse response ---
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(
      'Google Gemini returned an empty response. The model may have refused to answer or the prompt was filtered.'
    );
  }

  return { text };
}

/**
 * OpenAI adapter.
 *
 * Uses the standard OpenAI Chat Completions API.
 * Messages are passed through as-is (OpenAI natively supports
 * system / user / assistant roles).
 */
async function callOpenAI(apiKey, modelId, messages, config) {
  const endpoint = 'https://api.openai.com/v1/chat/completions';

  const body = {
    model: modelId,
    messages: messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok) {
    const errMsg = data.error?.message || `HTTP ${response.status}`;
    throw new Error(`OpenAI API error: ${errMsg}`);
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(
      'OpenAI returned an empty response. The model may have refused to answer or the prompt was filtered.'
    );
  }

  return { text };
}

/**
 * Groq adapter.
 *
 * Groq's API is OpenAI-compatible so the request/response format
 * is identical — only the base URL and header differ.
 */
async function callGroq(apiKey, modelId, messages, config) {
  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';

  const body = {
    model: modelId,
    messages: messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok) {
    const errMsg = data.error?.message || `HTTP ${response.status}`;
    throw new Error(`Groq API error: ${errMsg}`);
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(
      'Groq returned an empty response. The model may have refused to answer or the prompt was filtered.'
    );
  }

  return { text };
}

/**
 * OpenRouter adapter.
 *
 * OpenAI-compatible format with additional headers for attribution.
 * The HTTP-Referer and X-Title headers help OpenRouter track usage
 * and are recommended by their docs.
 */
async function callOpenRouter(apiKey, modelId, messages, config) {
  const endpoint = 'https://openrouter.ai/api/v1/chat/completions';

  const body = {
    model: modelId,
    messages: messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': window.location.href,
      'X-Title': 'AI Interview Prep'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok) {
    const errMsg = data.error?.message || `HTTP ${response.status}`;
    throw new Error(`OpenRouter API error: ${errMsg}`);
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(
      'OpenRouter returned an empty response. The model may have refused to answer or the prompt was filtered.'
    );
  }

  return { text };
}


/* =========================================================================
 * ADAPTER DISPATCH MAP
 * ========================================================================= */

const ADAPTERS = {
  gemini: callGemini,
  openai: callOpenAI,
  groq: callGroq,
  openrouter: callOpenRouter
};


/* =========================================================================
 * MAIN ENTRY POINT — callLLM
 * ========================================================================= */

/**
 * Unified function to call any supported LLM provider.
 *
 * @param {string} providerKey  — One of: 'gemini', 'openai', 'groq', 'openrouter'
 * @param {string} apiKey       — The user's API key for the chosen provider
 * @param {string} modelId      — Model identifier (e.g. 'gemini-2.0-flash', 'gpt-4o-mini')
 * @param {Array<{role: string, content: string}>} messages — Universal message array
 * @param {{ temperature?: number, maxTokens?: number }} config — Generation config
 *
 * @returns {Promise<{ text: string }>} — The model's response text
 * @throws {Error} Descriptive error with provider name included
 *
 * @example
 *   const result = await callLLM(
 *     'gemini',
 *     'AIzaSy...',
 *     'gemini-2.0-flash',
 *     [
 *       { role: 'system', content: 'You are a helpful interviewer.' },
 *       { role: 'user', content: 'Tell me about yourself.' }
 *     ],
 *     { temperature: 0.7, maxTokens: 1024 }
 *   );
 *   console.log(result.text);
 */
async function callLLM(providerKey, apiKey, modelId, messages, config = {}) {
  // --- Validate inputs ---
  const provider = PROVIDERS[providerKey];
  if (!provider) {
    throw new Error(`Unknown provider: "${providerKey}". Supported: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error(`${provider.name}: API key is required. Get one at ${provider.keyUrl}`);
  }

  if (!modelId) {
    throw new Error(`${provider.name}: A model ID must be specified.`);
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error(`${provider.name}: At least one message is required.`);
  }

  // Apply defaults for optional config values
  const finalConfig = {
    temperature: config.temperature ?? 0.7,
    maxTokens: config.maxTokens ?? 2048
  };

  // --- Dispatch to the correct adapter ---
  const adapter = ADAPTERS[providerKey];

  try {
    return await adapter(apiKey.trim(), modelId, messages, finalConfig);
  } catch (error) {
    // Re-throw adapter errors that already have provider context
    if (error.message && error.message.includes('API error')) {
      throw error;
    }

    // Handle network / CORS / other fetch failures
    if (error instanceof TypeError && error.message === 'Failed to fetch') {
      // This is the typical error for CORS blocks or network outages
      throw new Error(
        `${provider.name}: Network error — please check your internet connection. ` +
        `If you're online, this provider may be blocking browser-based (CORS) requests.`
      );
    }

    // Generic catch-all with provider context
    throw new Error(`${provider.name}: ${error.message || 'An unexpected error occurred.'}`);
  }
}
