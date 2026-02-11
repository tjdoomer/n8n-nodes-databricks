import {
    NodeConnectionTypes,
    type INodeType,
    type INodeTypeDescription,
    type ISupplyDataFunctions,
    type SupplyData,
    type ILoadOptionsFunctions,
    type INodeListSearchResult,
} from 'n8n-workflow';
import { ChatOpenAI } from '@langchain/openai';
// import { N8nLlmTracing } from '../N8nLlmTracing';

// Cache interface and setup
interface CacheEntry {
    data: any;
    timestamp: number;
}

// In-memory cache for model endpoints
const modelCache: Map<string, CacheEntry> = new Map();
const CACHE_TTL = 1 * 60 * 1000; // 1 minute in milliseconds

// Helper function to generate cache key
function getCacheKey(host: string): string {
    return `${host}:models`;
}

// Helper function to check if cache is valid
function isCacheValid(entry: CacheEntry | undefined): boolean {
    if (!entry) return false;
    return Date.now() - entry.timestamp < CACHE_TTL;
}

export class LmChatDatabricks implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'Databricks Chat Model',
        name: 'lmChatDatabricks',
        icon: 'file:databricks.svg',
        group: ['transform'],
        version: 1,
        description: 'Use Databricks hosted LLM models',
        defaults: {
            name: 'Databricks Chat Model',
        },
        codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
				'Language Models': ['Chat Models (Recommended)'],
			},
            resources: {
                primaryDocumentation: [
                    {
                        url: 'https://docs.databricks.com/machine-learning/model-serving/index.html',
                    },
                ],
            },
        },
        inputs: [],
        outputs: [NodeConnectionTypes.AiLanguageModel],
        outputNames: ['Model'],
        credentials: [
            {
                name: 'databricks',
                required: true,
            },
        ],
        requestDefaults: {
            baseURL: '={{$credentials.host}}',
            headers: {
                Authorization: '=Bearer {{$credentials.token}}',
            },
        },
        properties: [
            {
                displayName: 'Model',
                name: 'model',
                type: 'resourceLocator',
                default: { mode: 'list', value: '' },
                required: true,
                description: 'The Databricks model serving endpoint to use for chat',
                modes: [
                    {
                        displayName: 'From List',
                        name: 'list',
                        type: 'list',
                        typeOptions: {
                            searchListMethod: 'getModels',
                            searchable: true,
                        },
                    },
                    {
                        displayName: 'By Name',
                        name: 'name',
                        type: 'string',
                        placeholder: 'e.g. databricks-meta-llama-3-1-70b-instruct',
                        validation: [
                            {
                                type: 'regex',
                                properties: {
                                    regex: '^[a-zA-Z0-9_-]+$',
                                    errorMessage: 'Must be a valid endpoint name (alphanumeric, hyphens, and underscores only)',
                                },
                            },
                        ],
                    },
                    {
                        displayName: 'By URL',
                        name: 'url',
                        type: 'string',
                        placeholder: 'e.g. https://adb-xxx.cloud.databricks.com/serving-endpoints/my-endpoint',
                        extractValue: {
                            type: 'regex',
                            regex: 'https://[^/]+/serving-endpoints/([a-zA-Z0-9_-]+)',
                        },
                    },
                ],
            },
            {
                displayName: 'Options',
                name: 'options',
                type: 'collection',
                placeholder: 'Add Option',
                default: {},
                options: [
                    {
                        displayName: 'Maximum Tokens',
                        name: 'max_tokens',
                        type: 'number',
                        typeOptions: {
                            maxValue: 32768,
                        },
                        default: 512,
                        routing: {
                            send: {
                                type: 'body',
                                property: 'max_tokens',
                            },
                        },
                    },
                    {
                        displayName: 'Temperature',
                        name: 'temperature',
                        type: 'number',
                        typeOptions: {
                            maxValue: 2,
                            minValue: 0,
                            numberPrecision: 1,
                        },
                        default: 0.7,
                        routing: {
                            send: {
                                type: 'body',
                                property: 'temperature',
                            },
                        },
                    },
                    {
                        displayName: 'Top P',
                        name: 'top_p',
                        type: 'number',
                        typeOptions: {
                            maxValue: 1,
                            minValue: 0,
                            numberPrecision: 1,
                        },
                        default: 1,
                        routing: {
                            send: {
                                type: 'body',
                                property: 'top_p',
                            },
                        },
                    },
                    {
                        displayName: 'Conversation ID',
                        name: 'conversation_id',
                        type: 'string',
                        default: '',
                        description: 'Unique identifier for tracking conversations across requests (Databricks-specific)',
                    },
                    {
                        displayName: 'Return Trace',
                        name: 'return_trace',
                        type: 'boolean',
                        default: false,
                        description: 'Whether to return the execution trace for debugging (Databricks-specific)',
                    },
                ],
            },
        ],
    };

    methods = {
        listSearch: {
            async getModels(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
                const credentials = await this.getCredentials('databricks');
                const host = (credentials.host as string).replace(/\/$/, '');
                const cacheKey = getCacheKey(host);
                
                // Check cache first
                let endpoints: Array<{ name: string; config?: { served_entities?: Array<{ external_model?: { name?: string }; foundation_model?: { name?: string } }> } }> = [];
                const cachedEntry = modelCache.get(cacheKey);
                
                if (isCacheValid(cachedEntry)) {
                    // Use cached data - no API call needed!
                    endpoints = cachedEntry!.data;
                } else {
                    // Fetch from API
                    const response = await this.helpers.httpRequest({
                        method: 'GET',
                        url: `${host}/api/2.0/serving-endpoints`,
                        headers: {
                            Authorization: `Bearer ${credentials.token}`,
                            'Accept': 'application/json',
                        },
                        json: true,
                    }) as { endpoints?: Array<{ name: string; config?: { served_entities?: Array<{ external_model?: { name?: string }; foundation_model?: { name?: string } }> } }> };

                    endpoints = response.endpoints ?? [];
                    
                    // Store in cache
                    modelCache.set(cacheKey, {
                        data: endpoints,
                        timestamp: Date.now(),
                    });
                }
                
                const allResults = endpoints.map((endpoint) => {
                    const modelNames = (endpoint.config?.served_entities || [])
                        .map(entity => entity.external_model?.name || entity.foundation_model?.name)
                        .filter(Boolean)
                        .join(', ');
                    
                    return {
                        name: endpoint.name,
                        value: endpoint.name,
                        description: modelNames || undefined,
                    };
                }).sort((a, b) => a.name.localeCompare(b.name));

                // Apply client-side filter
                if (filter) {
                    const filterLower = filter.toLowerCase();
                    const filteredResults = allResults.filter((result) =>
                        result.name.toLowerCase().includes(filterLower)
                    );
                    return { results: filteredResults };
                }

                return { results: allResults };
            },
        },
    };

    async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
        const credentials = await this.getCredentials('databricks');
        const modelName = this.getNodeParameter('model', itemIndex, '', { extractValue: true }) as string;
        
        const options = this.getNodeParameter('options', itemIndex, {}) as {
            maxTokens?: number;
            maxRetries?: number;
            timeout?: number;
            temperature?: number;
            topP?: number;
            responseFormat?: 'text' | 'json_object';
            conversation_id?: string;
            return_trace?: boolean;
        };

        // Detect Claude/Anthropic models to disable unsupported OpenAI-specific features
        const isClaude = modelName.toLowerCase().includes('claude') ||
            modelName.toLowerCase().includes('anthropic');

        // For Claude models, use a custom fetch wrapper that strips unsupported
        // OpenAI parameters (frequency_penalty, presence_penalty, parallel_tool_calls, etc.)
        // which cause 400 errors on Databricks Model Serving for Anthropic models.
        const configuration: Record<string, any> = {
            baseURL: `${credentials.host}/serving-endpoints`,
        };

        if (isClaude) {
            const UNSUPPORTED_CLAUDE_PARAMS = [
                'frequency_penalty',
                'presence_penalty',
                'parallel_tool_calls',
                'logprobs',
                'top_logprobs',
                'logit_bias',
                'stream_options',
            ];

            configuration.fetch = async (url: string, init: any) => {
                if (init?.body && typeof init.body === 'string') {
                    try {
                        const body = JSON.parse(init.body);
                        for (const param of UNSUPPORTED_CLAUDE_PARAMS) {
                            delete body[param];
                        }
                        // Claude rejects requests with both temperature and top_p
                        if (body.temperature !== undefined && body.top_p !== undefined) {
                            delete body.top_p;
                        }
                        init.body = JSON.stringify(body);
                    } catch {
                        // If body isn't valid JSON, pass through unchanged
                    }
                }
                return fetch(url, init);
            };
        }

        // Build modelKwargs with response_format and databricks_options
        const modelKwargs: any = {};

        if (options.responseFormat) {
            modelKwargs.response_format = { type: options.responseFormat };
        }

        // Add databricks_options if any are specified
        const hasDbOptions = options.conversation_id || options.return_trace !== undefined;

        if (hasDbOptions) {
            modelKwargs.databricks_options = {};
            if (options.conversation_id) {
                modelKwargs.databricks_options.conversation_id = options.conversation_id;
            }
            if (options.return_trace !== undefined) {
                modelKwargs.databricks_options.return_trace = options.return_trace;
            }
        }

        const model = new ChatOpenAI({
            openAIApiKey: `${credentials.token}`,
            modelName,
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            topP: isClaude ? undefined : options.topP,
            timeout: options.timeout ?? 60000,
            maxRetries: options.maxRetries ?? 2,
            configuration,
            // callbacks: [new N8nLlmTracing(this)],
            modelKwargs: Object.keys(modelKwargs).length > 0 ? modelKwargs : undefined,
        });

        return {
            response: model,
        };
    }
}