import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

/** Keep the internal LLM stream alive longer than the 15-minute CLI limit. */
export const DEFAULT_LLM_STREAM_BODY_TIMEOUT_MS = 16 * 60_000;

export function createLlmStreamFetch(
  bodyTimeoutMs = DEFAULT_LLM_STREAM_BODY_TIMEOUT_MS,
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request && init === undefined
      ? input
      : new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return fetch(request);
    }

    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    return await requestStreamingResponse(url, request, body, bodyTimeoutMs);
  };
}

function requestStreamingResponse(
  url: URL,
  request: Request,
  body: Buffer | undefined,
  bodyTimeoutMs: number,
): Promise<Response> {
  return new Promise<Response>((resolvePromise, rejectPromise) => {
    let responseStarted = false;
    let clientRequest: ClientRequest;
    const reject = (error: Error) => {
      if (!responseStarted) rejectPromise(error);
    };
    const abort = () => {
      clientRequest.destroy(request.signal.reason instanceof Error
        ? request.signal.reason
        : new Error("LLM stream request aborted"));
    };
    const onResponse = (incoming: IncomingMessage) => {
      responseStarted = true;
      request.signal.removeEventListener("abort", abort);
      incoming.socket.setTimeout(bodyTimeoutMs);
      incoming.socket.once("timeout", () => {
        incoming.destroy(new Error(`LLM stream body timed out after ${bodyTimeoutMs} ms`));
      });
      resolvePromise(new Response(toWebStream(incoming), {
        status: incoming.statusCode ?? 502,
        headers: incoming.headers as HeadersInit,
      }));
    };

    clientRequest = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
    }, onResponse);
    clientRequest.setTimeout(bodyTimeoutMs, () => {
      clientRequest.destroy(new Error(`LLM stream request timed out after ${bodyTimeoutMs} ms`));
    });
    clientRequest.once("error", reject);
    if (request.signal.aborted) {
      abort();
      return;
    }
    request.signal.addEventListener("abort", abort, { once: true });
    clientRequest.end(body);
  });
}

function toWebStream(incoming: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      incoming.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      incoming.once("end", () => controller.close());
      incoming.once("aborted", () => controller.error(new Error("LLM stream terminated")));
      incoming.once("error", (error) => controller.error(error));
    },
    cancel() {
      incoming.destroy();
    },
  });
}
