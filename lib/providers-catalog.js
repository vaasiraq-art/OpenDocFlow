'use strict';

const PROVIDER_CATALOG = [
  {
    id: 'google',
    name: 'Google AI Studio (Gemini 2.5 / 3)',
    tier: 'Free & Paid',
    badge: 'FREE 1M CONTEXT',
    envKey: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    builtin: true,
    defaultModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (All Free & Paid Models)',
    tier: 'Free & Paid',
    badge: '40+ FREE CODING MODELS',
    envKey: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    baseURL: 'https://openrouter.ai/api/v1',
    builtin: true,
    defaultModels: [
      'qwen/qwen3-coder:free',
      'deepseek/deepseek-r1:free',
      'deepseek/deepseek-chat-v3-0324:free',
      'z-ai/glm-4.5-air:free',
      'moonshotai/kimi-k2:free',
      'meta-llama/llama-3.3-70b-instruct:free'
    ]
  },
  {
    id: 'groq',
    name: 'Groq Cloud (Ultra-Fast LPU)',
    tier: 'Free & Paid',
    badge: 'FREE LPU TIER',
    envKey: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    baseURL: 'https://api.groq.com/openai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: [
      'llama-3.3-70b-versatile',
      'moonshotai/kimi-k2-instruct',
      'qwen/qwen3-32b',
      'deepseek-r1-distill-llama-70b'
    ]
  },
  {
    id: 'cerebras',
    name: 'Cerebras Wafer-Scale Inference',
    tier: 'Free & Paid',
    badge: 'FREE 2000 TOK/S',
    envKey: 'CEREBRAS_API_KEY',
    keyUrl: 'https://cloud.cerebras.ai/',
    baseURL: 'https://api.cerebras.ai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['qwen-3-coder-480b', 'qwen-3-235b-a22b', 'llama-3.3-70b']
  },
  {
    id: 'sambanova',
    name: 'SambaNova Cloud (RDU Fast Free Tier)',
    tier: 'Free & Paid',
    badge: 'FREE RDU TIER',
    envKey: 'SAMBANOVA_API_KEY',
    keyUrl: 'https://cloud.sambanova.ai/apis',
    baseURL: 'https://api.sambanova.ai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['DeepSeek-R1', 'DeepSeek-V3-0324', 'Qwen2.5-Coder-32B-Instruct', 'Meta-Llama-3.3-70B-Instruct']
  },
  {
    id: 'chutes',
    name: 'Chutes.ai (Serverless Open-Weights)',
    tier: 'Free & Paid',
    badge: 'FREE OPEN WEIGHTS',
    envKey: 'CHUTES_API_KEY',
    keyUrl: 'https://chutes.ai/',
    baseURL: 'https://llm.chutes.ai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['deepseek-ai/DeepSeek-V3-0324', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen3-235B-A22B']
  },
  {
    id: 'github-models',
    name: 'GitHub Models (PAT Token)',
    tier: 'Free & Paid',
    badge: 'FREE WITH GITHUB',
    envKey: 'GITHUB_TOKEN',
    keyUrl: 'https://github.com/settings/tokens',
    baseURL: 'https://models.inference.ai.azure.com',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['gpt-4o', 'o3-mini', 'DeepSeek-R1', 'Codestral-2501']
  },
  {
    id: 'mistral',
    name: 'Mistral AI (Codestral & Devstral)',
    tier: 'Free & Paid',
    badge: 'FREE EXPERIMENT TIER',
    envKey: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/api-keys/',
    baseURL: 'https://api.mistral.ai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['codestral-latest', 'devstral-small-latest', 'mistral-large-latest']
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM (Build Free Credits)',
    tier: 'Free & Paid',
    badge: 'FREE DEV CREDITS',
    envKey: 'NVIDIA_API_KEY',
    keyUrl: 'https://build.nvidia.com/',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['qwen/qwen2.5-coder-32b-instruct', 'deepseek-ai/deepseek-r1', 'nvidia/llama-3.1-nemotron-ultra-253b-v1']
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot AI K2)',
    tier: 'Free Credits & Paid',
    badge: 'AGENTIC CODER',
    envKey: 'MOONSHOT_API_KEY',
    keyUrl: 'https://platform.moonshot.ai/',
    baseURL: 'https://api.moonshot.ai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['kimi-k2-0711-preview', 'moonshot-v1-128k']
  },
  {
    id: 'zhipu',
    name: 'Z.ai / Zhipu (GLM-4.5 & Flash)',
    tier: 'Free & Paid',
    badge: 'GLM-4-FLASH FREE',
    envKey: 'ZHIPU_API_KEY',
    keyUrl: 'https://open.bigmodel.cn/',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['glm-4.5', 'glm-4-flash', 'codegeex-4']
  },
  {
    id: 'together',
    name: 'Together AI (Open-Weights Cloud)',
    tier: 'Free Credits & Paid',
    badge: 'FAST CODERS',
    envKey: 'TOGETHER_API_KEY',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    baseURL: 'https://api.together.xyz/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['Qwen/Qwen2.5-Coder-32B-Instruct', 'deepseek-ai/DeepSeek-R1', 'deepseek-ai/DeepSeek-V3']
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI (Ultra-Low Latency)',
    tier: 'Free Credits & Paid',
    badge: 'FIREATTENTION',
    envKey: 'FIREWORKS_API_KEY',
    keyUrl: 'https://fireworks.ai/account/api-keys',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['accounts/fireworks/models/qwen3-235b-a22b', 'accounts/fireworks/models/deepseek-v3']
  },
  {
    id: 'hyperbolic',
    name: 'Hyperbolic AI',
    tier: 'Free Credits & Paid',
    badge: 'OPEN WEIGHTS',
    envKey: 'HYPERBOLIC_API_KEY',
    keyUrl: 'https://app.hyperbolic.xyz/settings',
    baseURL: 'https://api.hyperbolic.xyz/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['Qwen/Qwen2.5-Coder-32B-Instruct', 'deepseek-ai/DeepSeek-R1']
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude Sonnet / Opus)',
    tier: 'Paid',
    badge: 'FRONTIER CODING PAID',
    envKey: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    baseURL: 'https://api.anthropic.com/v1',
    builtin: true,
    defaultModels: ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-3-7-sonnet-latest']
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT-5 / GPT-4.1 / o3 / o4-mini)',
    tier: 'Paid',
    badge: 'FRONTIER PAID',
    envKey: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    baseURL: 'https://api.openai.com/v1',
    builtin: true,
    defaultModels: ['gpt-5', 'gpt-4.1', 'o3', 'o4-mini']
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Official (V3.1 & R1)',
    tier: 'Paid (Ultra Low Cost)',
    badge: 'ULTRA LOW COST',
    envKey: 'DEEPSEEK_API_KEY',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    baseURL: 'https://api.deepseek.com/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    id: 'xai',
    name: 'xAI (Grok 4 & Grok 3 Coding)',
    tier: 'Paid',
    badge: 'GROK CODER',
    envKey: 'XAI_API_KEY',
    keyUrl: 'https://console.x.ai/',
    baseURL: 'https://api.x.ai/v1',
    builtin: true,
    defaultModels: ['grok-4', 'grok-3', 'grok-3-mini']
  },
  {
    id: 'ollama',
    name: 'Ollama (Local Offline GPU/CPU)',
    tier: 'Free Local',
    badge: '100% FREE OFFLINE',
    envKey: 'OLLAMA_API_KEY',
    keyUrl: 'https://ollama.com/library',
    baseURL: 'http://127.0.0.1:11434/v1',
    builtin: true,
    localNoKey: true,
    defaultModels: ['qwen2.5-coder:14b', 'qwen2.5-coder:7b', 'deepseek-coder-v2:16b']
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (Local GGUF Server)',
    tier: 'Free Local',
    badge: '100% FREE OFFLINE',
    envKey: 'LMSTUDIO_API_KEY',
    keyUrl: 'http://127.0.0.1:1234/v1',
    baseURL: 'http://127.0.0.1:1234/v1',
    builtin: true,
    localNoKey: true,
    defaultModels: ['qwen2.5-coder-14b-instruct']
  }
];

const CURATED_FREE_CODING_MODELS = [
  {
    rank: 1,
    tierLabel: 'S+ Tier (Best 1M Context Architect)',
    id: 'google/gemini-2.5-pro',
    provider: 'google',
    name: 'Gemini 2.5 Pro (Google AI Studio Free Tier)',
    context: '1,000,000',
    strengths: '1M token context, full-repo architecture, complex multi-file coding & debugging.',
    howToUse: 'Add one or more free Google AI Studio keys and click Use Model.'
  },
  {
    rank: 2,
    tierLabel: 'S+ Tier (Best Open-Weights Agentic Coder)',
    id: 'openrouter/qwen/qwen3-coder:free',
    provider: 'openrouter',
    name: 'Qwen 3 Coder 480B A35B (Free via OpenRouter / Cerebras)',
    context: '262,144',
    strengths: 'Purpose-built agentic coding model, top tool-use & repo refactoring.',
    howToUse: 'Add a free OpenRouter or Cerebras key and click Use Model.'
  },
  {
    rank: 3,
    tierLabel: 'S+ Tier (1T MoE Agentic Coder)',
    id: 'openrouter/moonshotai/kimi-k2:free',
    provider: 'openrouter',
    name: 'Kimi K2 1T MoE (Free via OpenRouter / Groq)',
    context: '131,072',
    strengths: 'Moonshot AI 1T-parameter MoE built specifically for agentic tool use & coding.',
    howToUse: 'Add an OpenRouter or Groq key and click Use Model.'
  },
  {
    rank: 4,
    tierLabel: 'S Tier (Deep Reasoning & Systems Code)',
    id: 'openrouter/deepseek/deepseek-r1:free',
    provider: 'openrouter',
    name: 'DeepSeek R1 (Free via OpenRouter / SambaNova / Chutes)',
    context: '163,840',
    strengths: 'Root-cause bug hunting, complex algorithms, C++/Rust/systems engineering.',
    howToUse: 'Add an OpenRouter, SambaNova, or Chutes key and click Use Model.'
  },
  {
    rank: 5,
    tierLabel: 'S Tier (Fast Full-Stack Daily Driver)',
    id: 'openrouter/deepseek/deepseek-chat-v3-0324:free',
    provider: 'openrouter',
    name: 'DeepSeek V3 0324 (Free via OpenRouter / Chutes)',
    context: '163,840',
    strengths: 'Clean, fast full-stack code generation across TS, Python, C#, GDScript.',
    howToUse: 'Add an OpenRouter key and click Use Model.'
  },
  {
    rank: 6,
    tierLabel: 'S Tier (Agentic Full-Stack Coder)',
    id: 'openrouter/z-ai/glm-4.5-air:free',
    provider: 'openrouter',
    name: 'GLM-4.5 Air / Flash (Free via OpenRouter / Z.ai)',
    context: '131,072',
    strengths: 'High-speed UI & web application generation with native tool calling.',
    howToUse: 'Add an OpenRouter or Z.ai key and click Use Model.'
  },
  {
    rank: 7,
    tierLabel: 'A+ Tier (High-Speed 1M Agentic)',
    id: 'google/gemini-2.5-flash',
    provider: 'google',
    name: 'Gemini 2.5 Flash (Google AI Studio Free Tier)',
    context: '1,000,000',
    strengths: 'Generous free rate limits, ultra-fast tool execution, long sessions.',
    howToUse: 'Add a free Google AI Studio key and click Use Model.'
  },
  {
    rank: 8,
    tierLabel: 'A+ Tier (2000 tok/s Wafer-Scale)',
    id: 'cerebras/qwen-3-coder-480b',
    provider: 'cerebras',
    name: 'Qwen 3 Coder 480B (Cerebras Free Tier)',
    context: '128,000',
    strengths: 'Instant full-file generation at 2,000+ tokens/sec on Cerebras hardware.',
    howToUse: 'Add a free Cerebras key and click Use Model.'
  },
  {
    rank: 9,
    tierLabel: 'A+ Tier (80+ Languages & Diffs)',
    id: 'mistral/codestral-latest',
    provider: 'mistral',
    name: 'Mistral Codestral & Devstral (Mistral Free Tier)',
    context: '256,000',
    strengths: '256K context, fast code edits, diffs, and unit test generation.',
    howToUse: 'Add a free Mistral AI key and click Use Model.'
  },
  {
    rank: 10,
    tierLabel: 'A Tier (Instant LPU Inference)',
    id: 'groq/llama-3.3-70b-versatile',
    provider: 'groq',
    name: 'Llama 3.3 70B Versatile (Groq Free Tier)',
    context: '128,000',
    strengths: '300+ tokens/sec on Groq LPU, zero-wait responses for web & scripts.',
    howToUse: 'Add a free Groq key and click Use Model.'
  },
  {
    rank: 11,
    tierLabel: 'A Tier (RDU Fast Free Inference)',
    id: 'sambanova/Qwen2.5-Coder-32B-Instruct',
    provider: 'sambanova',
    name: 'Qwen 2.5 Coder 32B Instruct (SambaNova Free Tier)',
    context: '128,000',
    strengths: 'High-accuracy 32B coder running on SambaNova RDU hardware.',
    howToUse: 'Add a free SambaNova key and click Use Model.'
  },
  {
    rank: 12,
    tierLabel: 'B+ Tier (100% Offline Local GPU/CPU)',
    id: 'ollama/qwen2.5-coder:14b',
    provider: 'ollama',
    name: 'Qwen 2.5 Coder 14B / 7B (Local Ollama)',
    context: '128,000',
    strengths: 'Zero API limits, 100% private offline fallback when internet/quotas finish.',
    howToUse: 'Run: ollama pull qwen2.5-coder:14b'
  }
];

module.exports = {
  PROVIDER_CATALOG,
  CURATED_FREE_CODING_MODELS
};
