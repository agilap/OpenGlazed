export async function readChatStream(response, onEvent) {
  if (!response.body) throw new Error('Streaming is unavailable. Please retry.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  function frame(value) {
    const data = value.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    let event;
    try { event = JSON.parse(data); } catch { throw new Error('Invalid chat stream. Please retry.'); }
    if (event.error) throw new Error('The assistant could not finish. Please retry.');
    onEvent(event);
    if (event.done) completed = true;
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error('Chat stream exceeded its size limit.');
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        frame(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (completed) break;
      if (done) {
        if (buffer.trim()) frame(buffer);
        if (!completed) throw new Error('Connection interrupted. Please retry.');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
