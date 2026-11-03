(function() {
  var script = document.currentScript;
  var dataset = (script && script.dataset) || {};
  var scriptUrl = script && script.src;
  function initWidget() {
    var businessId = dataset.businessId;
    if (!businessId) return;
    var primaryColor = /^#[0-9a-f]{6}$/i.test(dataset.primaryColor || '') ? dataset.primaryColor : '#6366f1';
    var position = dataset.position === 'left' ? 'left' : 'right';
    var greeting = (dataset.greeting || 'Hi! How can I help today?').slice(0, 300);
    var embedUrl;
    try {
      embedUrl = new URL('/embed/' + encodeURIComponent(businessId), dataset.appUrl || scriptUrl || window.location.href);
      if (!/^https?:$/.test(embedUrl.protocol)) return;
    } catch (_) { return; }
    embedUrl.searchParams.set('color', primaryColor);
    embedUrl.searchParams.set('greeting', greeting);
    embedUrl.searchParams.set('theme', dataset.theme === 'dark' ? 'dark' : 'light');
    var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var isOpen = false;
    var root = document.createElement('div');
    root.style.cssText = 'position:fixed;z-index:2147483000;pointer-events:none;bottom:0;left:0;right:0';
    var button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', 'Open chat');
    button.setAttribute('aria-expanded', 'false');
    button.style.cssText = 'position:fixed;width:56px;height:56px;border-radius:50%;border:2px solid white;padding:0;margin:0;cursor:pointer;color:white;display:grid;place-items:center;box-shadow:0 8px 32px #0003;pointer-events:auto;bottom:24px';
    button.style.background = primaryColor;
    var channels = primaryColor.slice(1).match(/../g).map(function(hex) {
      var value = parseInt(hex, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    button.style.color = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 0.179 ? '#121218' : '#ffffff';
    button.style[position] = '24px';
    button.textContent = 'Chat';
    var iframe = document.createElement('iframe');
    iframe.title = 'Business chat assistant';
    iframe.src = embedUrl.href;
    iframe.style.cssText = 'position:fixed;border:0;box-shadow:0 8px 32px #0003;display:none;pointer-events:auto';
    iframe.setAttribute('aria-hidden', 'true');
    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close chat';
    close.style.cssText = 'position:fixed;display:none;pointer-events:auto;top:8px;right:8px;min-height:44px;padding:8px 12px;background:white;color:#121218;border:1px solid #777;border-radius:6px;cursor:pointer';
    function layout() {
      var mobile = window.innerWidth <= 768;
      iframe.style.width = mobile ? '100vw' : 'min(380px, calc(100vw - 48px))';
      iframe.style.height = mobile ? '100dvh' : 'min(560px, calc(100dvh - 116px))';
      iframe.style.top = mobile ? '0' : 'auto';
      iframe.style.bottom = mobile ? 'auto' : '92px';
      iframe.style.left = mobile ? '0' : position === 'left' ? '24px' : 'auto';
      iframe.style.right = mobile ? 'auto' : position === 'right' ? '24px' : 'auto';
      iframe.style.borderRadius = mobile ? '0' : '16px';
      close.style.display = isOpen && mobile ? 'block' : 'none';
      button.style.display = isOpen && mobile ? 'none' : 'grid';
    }
    function open(value) {
      isOpen = value;
      button.setAttribute('aria-expanded', String(value));
      button.setAttribute('aria-label', value ? 'Close chat' : 'Open chat');
      button.textContent = value ? 'Close' : 'Chat';
      iframe.style.display = value ? 'block' : 'none';
      iframe.setAttribute('aria-hidden', String(!value));
      iframe.style.transition = reducedMotion ? 'none' : 'opacity 150ms ease';
      layout();
      if (value) iframe.focus();
      else button.focus();
    }
    button.addEventListener('click', function() { open(!isOpen); });
    close.addEventListener('click', function() { open(false); });
    window.addEventListener('keydown', function(event) { if (event.key === 'Escape' && isOpen) open(false); });
    window.addEventListener('message', function(event) {
      if (event.source === iframe.contentWindow && event.origin === embedUrl.origin && event.data && event.data.type === 'GLAZED_CLOSE') open(false);
    });
    window.addEventListener('resize', layout);
    layout();
    root.appendChild(iframe);
    root.appendChild(button);
    root.appendChild(close);
    document.body.appendChild(root);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initWidget, { once: true });
  else initWidget();
})();
