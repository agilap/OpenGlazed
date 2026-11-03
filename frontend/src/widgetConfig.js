export function safeCitationUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function widgetConfig(search = '') {
  const params = new URLSearchParams(search);
  const color = params.get('color') || '';
  return {
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#121218',
    greeting: (params.get('greeting') || '').trim().slice(0, 300),
    dark: params.get('theme') === 'dark',
  };
}

export function colorText(hex) {
  const channels = hex.slice(1).match(/../g).map((v) => {
    const channel = parseInt(v, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.179 ? '#121218' : '#ffffff';
}
