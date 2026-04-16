export interface TimelineItem {
  id: string
  requestId: string
  kind: 'feathers' | 'graphql'
  status: 'ok' | 'error' | 'pending'
  connectionId: string
  connectionLabel: string
  connectionUrl: string
  startTime: number
  endTime: number
  durationMs: number
  summary: string
  responsePreview: string
  requestText: string
  responseText: string
}

export interface ConnectionSummary {
  id: string
  label: string
  url: string
  pairedRequests: number
}

export interface ParsedCapture {
  fileName: string
  items: TimelineItem[]
  connections: ConnectionSummary[]
  totalMessages: number
  totalWebSockets: number
  spanStart: number
  spanEnd: number
}

interface HarMessage {
  type?: string
  time?: number
  data?: unknown
}

interface HarEntry {
  request?: {
    url?: string
  }
  _webSocketMessages?: HarMessage[]
}

interface PendingFeathersRequest {
  ackId: string
  sentAt: number
  payload: unknown[]
  connectionId: string
  connectionLabel: string
  connectionUrl: string
}

interface PendingGraphqlRequest {
  requestId: string
  sentAt: number
  payload: Record<string, unknown>
  resultCount: number
  connectionId: string
  connectionLabel: string
  connectionUrl: string
}

export function parseHarCapture(text: string, fileName = 'capture.har'): ParsedCapture {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('This file is not valid JSON.')
  }

  const entries = (parsed as { log?: { entries?: HarEntry[] } })?.log?.entries

  if (!Array.isArray(entries)) {
    throw new Error('This file does not look like a HAR export.')
  }

  const items: TimelineItem[] = []
  const connections: ConnectionSummary[] = []
  const allTimes: number[] = []
  let totalMessages = 0

  entries.forEach((entry, index) => {
    const messages = Array.isArray(entry?._webSocketMessages)
      ? entry._webSocketMessages
      : []

    if (!messages.length) {
      return
    }

    const connectionId = `connection-${index + 1}`
    const connectionUrl =
      typeof entry.request?.url === 'string'
        ? entry.request.url
        : `connection-${index + 1}`
    const connectionLabel = formatConnectionLabel(connectionUrl)

    messages.forEach((message) => {
      if (typeof message.time === 'number') {
        allTimes.push(message.time)
      }
    })

    totalMessages += messages.length

    const connectionItems = parseWebSocketMessages(
      messages,
      connectionId,
      connectionLabel,
      connectionUrl,
    )

    connections.push({
      id: connectionId,
      label: connectionLabel,
      url: connectionUrl,
      pairedRequests: connectionItems.length,
    })

    items.push(...connectionItems)
  })

  if (!connections.length) {
    throw new Error('No websocket traffic was found in this HAR file.')
  }

  items.sort((left, right) => {
    if (left.startTime !== right.startTime) {
      return left.startTime - right.startTime
    }

    return left.endTime - right.endTime
  })

  const spanStart = allTimes.length ? Math.min(...allTimes) : 0
  const spanEnd = allTimes.length ? Math.max(...allTimes) : spanStart

  return {
    fileName,
    items,
    connections,
    totalMessages,
    totalWebSockets: connections.length,
    spanStart,
    spanEnd,
  }
}

function parseWebSocketMessages(
  messages: HarMessage[],
  connectionId: string,
  connectionLabel: string,
  connectionUrl: string,
) {
  const items: TimelineItem[] = []
  const pendingFeathers = new Map<string, PendingFeathersRequest>()
  const pendingGraphql = new Map<string, PendingGraphqlRequest>()

  messages.forEach((message) => {
    if (typeof message.data !== 'string' || typeof message.time !== 'number') {
      return
    }

    const frame = parseFrame(message.data)

    if (!frame) {
      return
    }

    if (frame.kind === 'feathers-request') {
      pendingFeathers.set(frame.ackId, {
        ackId: frame.ackId,
        sentAt: message.time,
        payload: frame.payload,
        connectionId,
        connectionLabel,
        connectionUrl,
      })

      return
    }

    if (frame.kind === 'feathers-response') {
      const matchingRequest = pendingFeathers.get(frame.ackId)

      if (!matchingRequest) {
        return
      }

      items.push(
        buildFeathersItem(matchingRequest, message.time, frame.payload, items.length),
      )
      pendingFeathers.delete(frame.ackId)

      return
    }

    if (frame.kind === 'graphql-execute') {
      pendingGraphql.set(frame.requestId, {
        requestId: frame.requestId,
        sentAt: message.time,
        payload: frame.payload,
        resultCount: 0,
        connectionId,
        connectionLabel,
        connectionUrl,
      })

      return
    }

    if (frame.kind === 'graphql-result') {
      const matchingRequest = pendingGraphql.get(frame.requestId)

      if (!matchingRequest) {
        return
      }

      matchingRequest.resultCount += 1

      items.push(
        buildGraphqlItem(
          matchingRequest,
          message.time,
          frame.payload,
          matchingRequest.resultCount,
          items.length,
        ),
      )

      if (frame.payload.isFinal !== false) {
        pendingGraphql.delete(frame.requestId)
      }
    }
  })

  pendingFeathers.forEach((request) => {
    items.push(buildPendingFeathersItem(request, items.length))
  })

  pendingGraphql.forEach((request) => {
    items.push(buildPendingGraphqlItem(request, items.length))
  })

  return items
}

function parseFrame(raw: string) {
  const feathersRequestMatch = raw.match(/^42(\d+)(\[.*)$/s)

  if (feathersRequestMatch) {
    const payload = safeJsonParse(feathersRequestMatch[2])

    if (Array.isArray(payload)) {
      return {
        kind: 'feathers-request' as const,
        ackId: feathersRequestMatch[1],
        payload,
      }
    }

    return null
  }

  const feathersResponseMatch = raw.match(/^43(\d+)(\[.*)$/s)

  if (feathersResponseMatch) {
    const payload = safeJsonParse(feathersResponseMatch[2])

    if (Array.isArray(payload)) {
      return {
        kind: 'feathers-response' as const,
        ackId: feathersResponseMatch[1],
        payload,
      }
    }

    return null
  }

  if (!raw.startsWith('42[')) {
    return null
  }

  const eventPayload = safeJsonParse(raw.slice(2))

  if (!Array.isArray(eventPayload)) {
    return null
  }

  const [eventName, payload] = eventPayload

  if (eventName === '@graphql/execute' && isRecord(payload)) {
    return {
      kind: 'graphql-execute' as const,
      requestId: String(payload.id ?? 'unknown'),
      payload,
    }
  }

  if (eventName === '@graphql/result' && isRecord(payload)) {
    return {
      kind: 'graphql-result' as const,
      requestId: String(payload.id ?? 'unknown'),
      payload,
    }
  }

  return null
}

function buildFeathersItem(
  request: PendingFeathersRequest,
  receivedAt: number,
  responsePayload: unknown[],
  index: number,
): TimelineItem {
  const error = responsePayload[0]
  const result = responsePayload[1]
  const durationMs = Math.max((receivedAt - request.sentAt) * 1000, 0)

  return {
    id: `${request.connectionId}-feathers-${request.ackId}-${index}`,
    requestId: request.ackId,
    kind: 'feathers',
    status: error ? 'error' : 'ok',
    connectionId: request.connectionId,
    connectionLabel: request.connectionLabel,
    connectionUrl: request.connectionUrl,
    startTime: request.sentAt,
    endTime: receivedAt,
    durationMs,
    summary: buildFeathersSummary(request.payload),
    responsePreview: error ? describeError(error) : describeResult(result),
    requestText: stringifyPretty({
      kind: 'feathers-request',
      ackId: request.ackId,
      payload: request.payload,
    }),
    responseText: stringifyPretty({
      kind: 'feathers-response',
      ackId: request.ackId,
      error,
      result,
    }),
  }
}

function buildGraphqlItem(
  request: PendingGraphqlRequest,
  receivedAt: number,
  responsePayload: Record<string, unknown>,
  resultIndex: number,
  index: number,
): TimelineItem {
  const durationMs = Math.max((receivedAt - request.sentAt) * 1000, 0)
  const errors = Array.isArray(responsePayload.errors) ? responsePayload.errors : []
  const hasErrors = errors.length > 0

  return {
    id: `${request.connectionId}-graphql-${request.requestId}-${resultIndex}-${index}`,
    requestId: request.requestId,
    kind: 'graphql',
    status: hasErrors ? 'error' : 'ok',
    connectionId: request.connectionId,
    connectionLabel: request.connectionLabel,
    connectionUrl: request.connectionUrl,
    startTime: request.sentAt,
    endTime: receivedAt,
    durationMs,
    summary: buildGraphqlSummary(request.payload, resultIndex),
    responsePreview: hasErrors
      ? `${errors.length} GraphQL errors`
      : describeGraphqlResult(responsePayload.data),
    requestText: stringifyPretty({
      kind: 'graphql-execute',
      id: request.requestId,
      payload: request.payload,
    }),
    responseText: stringifyPretty({
      kind: 'graphql-result',
      id: request.requestId,
      payload: responsePayload,
    }),
  }
}

function buildPendingFeathersItem(
  request: PendingFeathersRequest,
  index: number,
): TimelineItem {
  return {
    id: `${request.connectionId}-feathers-pending-${request.ackId}-${index}`,
    requestId: request.ackId,
    kind: 'feathers',
    status: 'pending',
    connectionId: request.connectionId,
    connectionLabel: request.connectionLabel,
    connectionUrl: request.connectionUrl,
    startTime: request.sentAt,
    endTime: request.sentAt,
    durationMs: 0,
    summary: buildFeathersSummary(request.payload),
    responsePreview: 'Waiting for response',
    requestText: stringifyPretty({
      kind: 'feathers-request',
      ackId: request.ackId,
      payload: request.payload,
    }),
    responseText: 'No matching acknowledgement frame was found.',
  }
}

function buildPendingGraphqlItem(
  request: PendingGraphqlRequest,
  index: number,
): TimelineItem {
  return {
    id: `${request.connectionId}-graphql-pending-${request.requestId}-${index}`,
    requestId: request.requestId,
    kind: 'graphql',
    status: 'pending',
    connectionId: request.connectionId,
    connectionLabel: request.connectionLabel,
    connectionUrl: request.connectionUrl,
    startTime: request.sentAt,
    endTime: request.sentAt,
    durationMs: 0,
    summary: buildGraphqlSummary(request.payload, request.resultCount),
    responsePreview: 'Waiting for result',
    requestText: stringifyPretty({
      kind: 'graphql-execute',
      id: request.requestId,
      payload: request.payload,
    }),
    responseText: 'No matching GraphQL result frame was found.',
  }
}

function buildFeathersSummary(payload: unknown[]) {
  const method = typeof payload[0] === 'string' ? payload[0].toUpperCase() : 'CALL'
  const service =
    typeof payload[1] === 'string' ? payload[1] : 'unknown-service'
  const suffix = buildFeathersSuffix(payload)

  return `${method} ${service}${suffix}`
}

function buildFeathersSuffix(payload: unknown[]) {
  const method = typeof payload[0] === 'string' ? payload[0] : ''

  if (method === 'find') {
    return toQuerySuffix(payload[2])
  }

  if (method === 'get' || method === 'remove') {
    const id = payload[2]
    const base = id == null ? '' : `/${String(id)}`

    return `${base}${toQuerySuffix(payload[3])}`
  }

  if (method === 'patch' || method === 'update') {
    const id = payload[2]
    const base = id == null ? '' : `/${String(id)}`

    return `${base}${toQuerySuffix(payload[4])}`
  }

  return ''
}

function buildGraphqlSummary(
  payload: Record<string, unknown>,
  resultIndex: number,
) {
  const operationName =
    typeof payload.operationName === 'string' && payload.operationName.length > 0
      ? payload.operationName
      : extractOperationName(payload.operation)
  const suffix = resultIndex > 1 ? ` #${resultIndex}` : ''

  return `GRAPHQL ${operationName}${suffix}`
}

function extractOperationName(operation: unknown) {
  if (typeof operation !== 'string') {
    return 'anonymous'
  }

  const cleaned = operation.replace(/\s+/g, ' ').trim()
  const namedMatch = cleaned.match(/^(query|mutation|subscription)\s+([A-Za-z0-9_]+)/)

  if (namedMatch) {
    return namedMatch[2]
  }

  return cleaned.slice(0, 42) || 'anonymous'
}

function toQuerySuffix(candidate: unknown) {
  if (!isRecord(candidate)) {
    return ''
  }

  const filteredEntries = Object.entries(candidate).filter(
    ([key]) => key !== '__meta' && candidate[key] !== undefined,
  )

  if (!filteredEntries.length) {
    return ''
  }

  const query = filteredEntries
    .map(([key, value]) => `${key}=${compactValue(value)}`)
    .join('&')

  return `?${truncate(query, 96)}`
}

function compactValue(value: unknown): string {
  if (value == null) {
    return 'null'
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value)
  }

  if (Array.isArray(value)) {
    return truncate(
      `[${value.slice(0, 3).map((entry) => compactValue(entry)).join(',')}${value.length > 3 ? ',…' : ''}]`,
      48,
    )
  }

  return truncate(JSON.stringify(value), 48)
}

function describeResult(result: unknown) {
  if (result == null) {
    return 'No payload'
  }

  if (Array.isArray(result)) {
    return `${result.length} items`
  }

  if (!isRecord(result)) {
    return truncate(String(result), 64)
  }

  if (Array.isArray(result.data)) {
    if (typeof result.total === 'number' && result.total >= 0) {
      return `${result.data.length} rows of ${result.total}`
    }

    return `${result.data.length} rows`
  }

  if (typeof result.id === 'string') {
    return `id ${result.id}`
  }

  const keys = Object.keys(result)

  if (!keys.length) {
    return 'Empty object'
  }

  return truncate(keys.join(', '), 64)
}

function describeGraphqlResult(result: unknown) {
  if (!isRecord(result)) {
    return result == null ? 'No data' : truncate(String(result), 64)
  }

  const keys = Object.keys(result)

  return keys.length ? truncate(keys.join(', '), 64) : 'Empty data'
}

function describeError(error: unknown) {
  if (isRecord(error)) {
    if (typeof error.message === 'string') {
      return truncate(error.message, 64)
    }

    if (typeof error.name === 'string') {
      return truncate(error.name, 64)
    }
  }

  return truncate(JSON.stringify(error) ?? 'Unknown error', 64)
}

function formatConnectionLabel(url: string) {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/\/$/, '')

    return `${parsed.host}${path || '/'}`
  } catch {
    return url
  }
}

function stringifyPretty(value: unknown) {
  return JSON.stringify(value, null, 2) ?? String(value)
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function truncate(value: string, length: number) {
  if (value.length <= length) {
    return value
  }

  return `${value.slice(0, Math.max(length - 1, 1))}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function formatDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '<1 ms'
  }

  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`
  }

  if (durationMs < 10000) {
    return `${(durationMs / 1000).toFixed(2)} s`
  }

  if (durationMs < 60000) {
    return `${(durationMs / 1000).toFixed(1)} s`
  }

  const minutes = Math.floor(durationMs / 60000)
  const seconds = Math.round((durationMs % 60000) / 1000)

  return `${minutes}m ${seconds}s`
}

export function formatAxisOffset(seconds: number) {
  return `+${formatDuration(seconds * 1000)}`
}

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export function formatClockTime(timeInSeconds: number) {
  return timeFormatter.format(new Date(timeInSeconds * 1000))
}
