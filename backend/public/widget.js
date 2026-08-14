(function() {
  function initWidget() {
    var script = document.currentScript;
    var dataset = (script && script.dataset) || {};

    var businessId = dataset.businessId;
    if (!businessId) {
      console.error('[Glazed widget] Missing required data-business-id.');
      return;
    }

    var primaryColor = dataset.primaryColor || '#6366f1';
    var position = dataset.position === 'left' ? 'left' : 'right';
    var greeting = dataset.greeting || 'Hi! How can I help today?';

    var isOpen = false;

    var root = document.createElement('div');
    root.style.position = 'fixed';
    root.style.zIndex = '2147483000';
    root.style.pointerEvents = 'none';
    root.style.bottom = '0';
    root.style.left = '0';
    root.style.right = '0';

    var button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', 'Toggle chat widget');
    button.style.position = 'fixed';
    button.style.width = '56px';
    button.style.height = '56px';
    button.style.borderRadius = '9999px';
    button.style.border = 'none';
    button.style.padding = '0';
    button.style.margin = '0';
    button.style.cursor = 'pointer';
    button.style.background = primaryColor;
    button.style.color = '#ffffff';
    button.style.display = 'grid';
    button.style.placeItems = 'center';
    button.style.boxShadow = '0 8px 32px rgba(0,0,0,0.18)';
    button.style.transition = 'opacity 200ms ease, transform 200ms ease';
    button.style.pointerEvents = 'auto';
    button.style.bottom = '24px';
    button.style[position] = '24px';

    var iframe = document.createElement('iframe');
    iframe.title = 'Glazed Chat Widget';
    iframe.src = '/embed/' + encodeURIComponent(businessId) + '?color=' + encodeURIComponent(primaryColor) + '&greeting=' + encodeURIComponent(greeting);
    iframe.style.position = 'fixed';
    iframe.style.border = 'none';
    iframe.style.boxShadow = '0 8px 32px rgba(0,0,0,0.18)';
    iframe.style.display = 'none';
    iframe.style.opacity = '0';
    iframe.style.transform = 'translateY(6px) scale(0.985)';
    iframe.style.transition = 'opacity 200ms ease, transform 200ms ease';
    iframe.style.pointerEvents = 'none';

    function chatIconSvg() {
      return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h16v10H8l-4 4V5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }

    function closeIconSvg() {
      return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6l-12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    }

    function applyResponsiveLayout() {
      var mobile = window.innerWidth <= 768;

      if (mobile) {
        iframe.style.width = '100vw';
        iframe.style.height = '100vh';
        iframe.style.top = '0';
        iframe.style.left = '0';
        iframe.style.right = 'auto';
        iframe.style.bottom = 'auto';
        iframe.style.borderRadius = '0';
      } else {
        iframe.style.width = '380px';
        iframe.style.height = '560px';
        iframe.style.top = 'auto';
        iframe.style.bottom = '92px';
        iframe.style.left = position === 'left' ? '24px' : 'auto';
        iframe.style.right = position === 'right' ? '24px' : 'auto';
        iframe.style.borderRadius = '16px';
      }
    }

    function applyOpenState(nextOpen) {
      isOpen = nextOpen;

      button.innerHTML = isOpen ? closeIconSvg() : chatIconSvg();
      button.style.transform = isOpen ? 'scale(0.96)' : 'scale(1)';
      button.style.opacity = isOpen ? '0.98' : '1';

      if (isOpen) {
        iframe.style.display = 'block';
        requestAnimationFrame(function() {
          iframe.style.opacity = '1';
          iframe.style.transform = 'translateY(0) scale(1)';
          iframe.style.pointerEvents = 'auto';
        });
      } else {
        iframe.style.opacity = '0';
        iframe.style.transform = 'translateY(6px) scale(0.985)';
        iframe.style.pointerEvents = 'none';
        window.setTimeout(function() {
          if (!isOpen) {
            iframe.style.display = 'none';
          }
        }, 200);
      }
    }

    button.innerHTML = chatIconSvg();

    button.addEventListener('click', function() {
      applyOpenState(!isOpen);
    });

    window.addEventListener('resize', applyResponsiveLayout);

    iframe.addEventListener('load', function() {
      iframe.contentWindow.postMessage(
        {
          type: 'GLAZED_INIT',
          greeting: greeting,
          primaryColor: primaryColor,
        },
        '*'
      );
    });

    applyResponsiveLayout();
    root.appendChild(iframe);
    root.appendChild(button);
    document.body.appendChild(root);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidget, { once: true });
  } else {
    initWidget();
  }
})();
