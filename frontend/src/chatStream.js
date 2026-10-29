export async function readChatStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      const line = frame.replace(/^data:\s*/, '').trim();
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch (_parseErr) {
        continue;
      }
      onEvent(evt);
    }
  }
}
