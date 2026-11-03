/** One long-term memory as the retrieval scorer sees it. */
export interface MemorySearchCandidate {
  id: string
  description: string
  body: string
  kind?: 'profile' | 'fact' | 'episode' | string
  importance?: number
  pinned?: boolean
  createdAt?: number
  updatedAt: number
  lastUsedAt?: number
  useCount?: number
}

export interface ScoredMemory<T extends MemorySearchCandidate> {
  memory: T
  score: number
  similarity: number
}

const CJK_RUN = /[\u3400-\u9FFF\uF900-\uFAFF]+/g
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'he',
  'her',
  'his',
  'i',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'that',
  'the',
  'their',
  'them',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
  'your',
])

let segmenter: Intl.Segmenter | undefined

function wordsOf(text: string) {
  try {
    segmenter ??= new Intl.Segmenter('zh-Hans', { granularity: 'word' })
    return [...segmenter.segment(text)]
      .filter(part => part.isWordLike && part.segment.trim().length > 0)
      .map(part => part.segment.toLowerCase())
  }
  catch {
    return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  }
}

/**
 * Splits text for lexical retrieval. Chinese needs both word segments and character
 * bigrams: a segmenter can miss a name, and bigrams keep partial matches useful.
 */
export function tokenizeMemoryText(text: string): string[] {
  const normalized = text.toLowerCase()
  const tokens = wordsOf(normalized)
    .filter(token => !STOP_WORDS.has(token))
    .filter(token => token.length > 1 || /[\u3400-\u9FFF\uF900-\uFAFF]/.test(token))

  for (const run of normalized.match(CJK_RUN) ?? []) {
    for (let index = 0; index < run.length - 1; index++)
      tokens.push(run.slice(index, index + 2))
  }

  return [...new Set(tokens)]
}

function termFrequency(tokens: string[]) {
  const frequency = new Map<string, number>()
  for (const token of tokens)
    frequency.set(token, (frequency.get(token) ?? 0) + 1)
  return frequency
}

/**
 * Ranks memories by lexical similarity, importance, recency, and past use.
 * The same scorer runs on the local cache and on the memory server.
 */
export function scoreMemoryCandidates<T extends MemorySearchCandidate>(
  candidates: readonly T[],
  query: string,
  options: { now?: number, limit?: number } = {},
): Array<ScoredMemory<T>> {
  const now = options.now ?? Date.now()
  const limit = options.limit ?? 8
  if (candidates.length === 0)
    return []

  const queryTokens = tokenizeMemoryText(query)
  const documents = candidates.map(memory => ({
    memory,
    tokens: tokenizeMemoryText(`${memory.description}\n${memory.body}`),
  }))

  const averageLength = documents.reduce((sum, document) => sum + document.tokens.length, 0) / Math.max(1, documents.length)
  const documentFrequency = new Map<string, number>()
  for (const document of documents) {
    for (const token of new Set(document.tokens))
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
  }

  const k1 = 1.2
  const b = 0.75
  const bm25 = documents.map((document) => {
    if (queryTokens.length === 0)
      return 0
    const frequency = termFrequency(document.tokens)
    let score = 0
    for (const token of queryTokens) {
      const tf = frequency.get(token) ?? 0
      if (tf === 0)
        continue
      const df = documentFrequency.get(token) ?? 0
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
      const lengthRatio = document.tokens.length / Math.max(1, averageLength)
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * lengthRatio))
    }
    return score
  })

  const maxBm25 = Math.max(0, ...bm25)
  const scored = documents.map((document, index) => {
    const { memory } = document
    const similarity = maxBm25 > 0 ? bm25[index] / maxBm25 : 0
    const importance = Math.min(1, Math.max(0, (memory.importance ?? 3) / 5))
    const reference = memory.kind === 'episode'
      ? memory.createdAt ?? memory.updatedAt
      : memory.updatedAt
    const ageDays = Math.max(0, now - reference) / 86_400_000
    const recency = Math.exp(-ageDays / 60)
    const usage = Math.min(1, Math.log1p(memory.useCount ?? 0) / Math.log1p(20))
    const pinned = memory.pinned ? 1 : 0
    const score = 0.5 * similarity + 0.2 * importance + 0.15 * recency + 0.1 * usage + 0.05 * pinned
    return { memory, score, similarity }
  })

  // A retrieval result must share at least one term with the query. The stable
  // profile and pinned index already cover the "nothing matched" case, so an
  // empty result is better than padding the prompt with unrelated memories.
  return scored
    .filter(item => item.similarity > 0)
    .sort((left, right) => right.score - left.score || right.memory.updatedAt - left.memory.updatedAt)
    .slice(0, Math.max(1, limit))
}
