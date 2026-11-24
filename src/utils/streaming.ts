import { sendStream, type H3Event } from 'h3';

export async function sendBody(
  event: H3Event,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  if (!event.node.res.socket) {
    return sendStream(event, body);
  }
  const controller = new AbortController();
  const onClose = () => controller.abort();
  event.node.res.once('close', onClose);
  try {
    await body.pipeTo(
      new WritableStream({
        write(chunk) {
          return new Promise<void>((resolve, reject) => {
            event.node.res.write(chunk, (error) =>
              error ? reject(error) : resolve(),
            );
          });
        },
      }),
      { signal: controller.signal },
    );
    event.node.res.end();
  } catch (error) {
    if (!controller.signal.aborted) {
      event.node.res.destroy();
      throw error;
    }
  } finally {
    event.node.res.removeListener('close', onClose);
  }
}
