/**
 * Read a response body with a hard byte cap.
 *
 * `Response.text()` buffers whatever the server sends, so a hostile or merely
 * huge page can balloon the agent's memory. Reading the stream lets the cap be
 * enforced while the body arrives, and a body that crosses it is cancelled
 * immediately rather than after the fact.
 */

export async function readCappedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released by cancel() */
    }
  }
  return Buffer.concat(chunks);
}

export async function readCappedBody(response: Response, maxBytes: number): Promise<string> {
  return (await readCappedBytes(response, maxBytes)).toString("utf-8");
}
