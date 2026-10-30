import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Paper } from '../../shared/types'
import { InvalidClipError, parseBrowserClip, type BrowserClip } from './browserClip'

/**
 * The local API the browser extension saves pages through, after Zotero's connector
 * server. Native Freddie serves the same API on the same port, so one extension works with
 * either app; whichever starts first owns the port.
 */
export const clipperPort = 23240
export const clipperAPIVersion = 1
/**
 * Required on every request. A web page can only send a custom header after a CORS
 * preflight, which this server never approves, so pages cannot call the API themselves.
 */
const clipperHeader = 'x-freddie-clipper'
/** Origins of extension pages; a web page's origin is refused even with the header. */
const extensionOriginPrefixes = ['chrome-extension://', 'moz-extension://', 'safari-web-extension://']
/**
 * Native Freddie, which only runs on macOS, also handles readpaper:// links, and only one of
 * the two apps can be the system's handler. On macOS this app therefore answers a save with
 * its own scheme, so "Open in Freddie" shows the paper in the app whose library has it.
 */
export const macLinkScheme = 'freddie-general'

export function paperOpenURL(paperId: string, platform: NodeJS.Platform = process.platform): string {
  return `${platform === 'darwin' ? macLinkScheme : 'readpaper'}://paper/${paperId}`
}

/** A link in this app's own scheme as the readpaper:// link it stands for. */
export function readpaperLink(url: string): string {
  return url.replace(new RegExp(`^${macLinkScheme}:`, 'i'), 'readpaper:')
}

/** Large enough for a base64 PDF of about 100 MB. */
const maxBodyBytes = 140 * 1024 * 1024

export interface ClipperRequest {
  method: string
  path: string
  /** Names are lowercased. */
  headers: Record<string, string | undefined>
  body: Buffer
}

export interface ClipperResponse {
  status: number
  body: unknown
}

export interface ClipperContext {
  version: string
  folders(): { id: string; name: string }[]
  save(clip: BrowserClip): Promise<{ paper: Paper; existing: boolean }>
}

/**
 * Requests that did not come from the extension. The host check stops DNS rebinding: a page
 * on a domain resolving to 127.0.0.1 would otherwise be same-origin with the API.
 */
export function clipperRejection(request: ClipperRequest, port = clipperPort): ClipperResponse | undefined {
  const host = request.headers.host?.toLowerCase()
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return { status: 403, body: { error: 'Forbidden host.' } }
  const origin = request.headers.origin?.toLowerCase()
  if (origin !== undefined && !extensionOriginPrefixes.some((prefix) => origin.startsWith(prefix))) {
    return { status: 403, body: { error: 'Forbidden origin.' } }
  }
  if (request.headers[clipperHeader] === undefined) return { status: 403, body: { error: `Missing ${clipperHeader} header.` } }
  return undefined
}

export async function handleClipperRequest(request: ClipperRequest, context: ClipperContext, port = clipperPort): Promise<ClipperResponse> {
  const rejection = clipperRejection(request, port)
  if (rejection) return rejection
  const route = `${request.method} ${request.path}`
  switch (route) {
    case 'GET /ping':
      return { status: 200, body: { app: 'Freddie', version: context.version, api: clipperAPIVersion } }
    case 'GET /folders':
      return { status: 200, body: { folders: context.folders().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) } }
    case 'POST /save': {
      let clip: BrowserClip
      try {
        clip = parseBrowserClip(JSON.parse(request.body.toString('utf8')))
      } catch (error) {
        return { status: 400, body: { error: error instanceof InvalidClipError ? error.message : 'Expected a JSON clip.' } }
      }
      try {
        const result = await context.save(clip)
        return {
          status: 200,
          body: { status: result.existing ? 'exists' : 'saved', paperID: result.paper.id, title: result.paper.title, openURL: paperOpenURL(result.paper.id) }
        }
      } catch (error) {
        return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } }
      }
    }
    default:
      return ['/ping', '/folders', '/save'].includes(request.path)
        ? { status: 405, body: { error: 'Method not allowed.' } }
        : { status: 404, body: { error: 'Not found.' } }
  }
}

/** Listens on the loopback interface only. `onError` reports a port already in use. */
export function startClipperServer(context: ClipperContext, port = clipperPort, onError?: (error: Error) => void): Server {
  const server = createServer((incoming, outgoing) => {
    void readBody(incoming).then(async (body) => {
      const response = body === undefined
        ? { status: 413, body: { error: 'Request too large.' } }
        : await handleClipperRequest({
            method: incoming.method ?? 'GET',
            path: (incoming.url ?? '/').split('?')[0],
            headers: Object.fromEntries(Object.entries(incoming.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value])),
            body
          }, context, port)
      // No CORS headers: only extensions, which skip CORS for hosts they may access, read responses.
      outgoing.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      outgoing.end(JSON.stringify(response.body))
    }).catch(() => outgoing.destroy())
  })
  server.on('error', (error) => onError?.(error))
  server.listen(port, '127.0.0.1')
  return server
}

/** The request body, or undefined once it passes the size limit. */
function readBody(incoming: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    incoming.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > maxBodyBytes) {
        incoming.removeAllListeners('data')
        incoming.resume()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    incoming.on('end', () => resolve(length > maxBodyBytes ? undefined : Buffer.concat(chunks)))
    incoming.on('error', reject)
  })
}
