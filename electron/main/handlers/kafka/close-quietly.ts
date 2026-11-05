/**
 * Best-effort force-close of a Kafka producer or consumer (socket release on
 * a failed connect, a cancelled claim, or teardown); a close error is ignored.
 */
export async function closeQuietly(client: { close(force: boolean): unknown }): Promise<void> {
  try {
    await Promise.resolve(client.close(true));
  } catch {
    /* ignore — best-effort socket release */
  }
}
