const TEXT_TRANSLATION_URL = 'https://api.openai.com/v1/responses'
const TEXT_TRANSLATION_MODEL = process.env.OPENAI_TEXT_TRANSLATION_MODEL || 'gpt-4.1-nano'

export type TextTranslationRequest = {
  text: string
}

export type TextTranslationStreamRequest = TextTranslationRequest & {
  requestId: number
}

export type TextTranslationResult = {
  text: string
  model: string
}

export type TextTranslationStreamEvent =
  | { type: 'started'; requestId: number; model: string }
  | { type: 'delta'; requestId: number; delta: string }
  | { type: 'done'; requestId: number; text: string; model: string }
  | { type: 'error'; requestId: number; message: string }

type ResponsesApiContentItem = {
  type?: unknown
  text?: unknown
}

type ResponsesApiOutputItem = {
  content?: unknown
}

type ResponsesApiResponse = {
  output_text?: unknown
  output?: unknown
  error?: {
    message?: unknown
  }
}

type ResponsesApiStreamEvent = {
  type?: unknown
  delta?: unknown
  text?: unknown
  response?: {
    model?: unknown
    error?: {
      message?: unknown
    } | null
  }
  error?: {
    message?: unknown
  }
}

function buildTextTranslationBody(text: string, stream: boolean): Record<string, unknown> {
  return {
    model: TEXT_TRANSLATION_MODEL,
    instructions:
      'Translate the user-provided Japanese text into natural English. Return only the English translation. Preserve line breaks when useful.',
    input: text,
    max_output_tokens: 1200,
    stream
  }
}

function extractOutputText(payload: ResponsesApiResponse): string {
  if (typeof payload.output_text === 'string') {
    return payload.output_text.trim()
  }

  if (!Array.isArray(payload.output)) {
    return ''
  }

  return payload.output
    .flatMap((item: ResponsesApiOutputItem) => (Array.isArray(item.content) ? item.content : []))
    .map((content: ResponsesApiContentItem) =>
      typeof content.text === 'string' ? content.text : ''
    )
    .join('')
    .trim()
}

export async function translateJapaneseTextToEnglish(
  request: TextTranslationRequest
): Promise<TextTranslationResult> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set.')
  }

  const text = request.text.trim()
  if (!text) {
    return {
      text: '',
      model: TEXT_TRANSLATION_MODEL
    }
  }

  const response = await fetch(TEXT_TRANSLATION_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildTextTranslationBody(text, false))
  })

  const payload = (await response.json().catch(() => ({}))) as ResponsesApiResponse

  if (!response.ok) {
    throw new Error(
      typeof payload.error?.message === 'string'
        ? payload.error.message
        : `OpenAI text translation failed (${response.status}).`
    )
  }

  const translatedText = extractOutputText(payload)
  if (!translatedText) {
    throw new Error('OpenAI returned an empty translation.')
  }

  return {
    text: translatedText,
    model: TEXT_TRANSLATION_MODEL
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function parseServerSentEvent(block: string): ResponsesApiStreamEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')

  if (!data || data === '[DONE]') {
    return null
  }

  try {
    return JSON.parse(data) as ResponsesApiStreamEvent
  } catch {
    return null
  }
}

function readStreamError(event: ResponsesApiStreamEvent): string | null {
  if (typeof event.error?.message === 'string') {
    return event.error.message
  }

  if (typeof event.response?.error?.message === 'string') {
    return event.response.error.message
  }

  return null
}

export async function streamJapaneseTextToEnglish(
  request: TextTranslationStreamRequest,
  onEvent: (event: TextTranslationStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set.')
  }

  const text = request.text.trim()
  if (!text) {
    onEvent({ type: 'done', requestId: request.requestId, text: '', model: TEXT_TRANSLATION_MODEL })
    return
  }

  onEvent({ type: 'started', requestId: request.requestId, model: TEXT_TRANSLATION_MODEL })

  const response = await fetch(TEXT_TRANSLATION_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildTextTranslationBody(text, true)),
    signal
  })

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ResponsesApiResponse
    throw new Error(
      typeof payload.error?.message === 'string'
        ? payload.error.message
        : `OpenAI text translation failed (${response.status}).`
    )
  }

  if (!response.body) {
    throw new Error('OpenAI returned an empty streaming response.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let translatedText = ''
  let completed = false

  const handleEvent = (event: ResponsesApiStreamEvent): void => {
    const streamError = readStreamError(event)
    if (event.type === 'error' || event.type === 'response.failed' || streamError) {
      throw new Error(streamError || 'OpenAI text translation failed while streaming.')
    }

    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      translatedText += event.delta
      onEvent({ type: 'delta', requestId: request.requestId, delta: event.delta })
      return
    }

    if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
      translatedText = event.text
      return
    }

    if (event.type === 'response.completed') {
      completed = true
      onEvent({
        type: 'done',
        requestId: request.requestId,
        text: translatedText,
        model:
          typeof event.response?.model === 'string' ? event.response.model : TEXT_TRANSLATION_MODEL
      })
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''

      for (const block of blocks) {
        const event = parseServerSentEvent(block)
        if (event) {
          handleEvent(event)
        }
      }
    }

    buffer += decoder.decode()
    const finalEvent = parseServerSentEvent(buffer)
    if (finalEvent) {
      handleEvent(finalEvent)
    }

    if (!completed) {
      onEvent({
        type: 'done',
        requestId: request.requestId,
        text: translatedText,
        model: TEXT_TRANSLATION_MODEL
      })
    }
  } catch (error) {
    if (signal?.aborted) {
      return
    }

    onEvent({ type: 'error', requestId: request.requestId, message: getErrorMessage(error) })
  } finally {
    reader.releaseLock()
  }
}
