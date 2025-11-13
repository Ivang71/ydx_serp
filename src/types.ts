export type SearchItem = { text: string; links: string[] }
export type TaskPayload = { query: string; timeoutMs: number; getAiAnswer: boolean; signal?: AbortSignal }


