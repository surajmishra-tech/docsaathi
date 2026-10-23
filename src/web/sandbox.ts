// Outer sandbox proxy for MCP Apps (double-iframe architecture, adapted from the
// modelcontextprotocol/ext-apps basic-host example).
//   Host page (port 3000) <-> this proxy (port 3001, different origin) <-> app view (inner iframe)
// The proxy loads the app's HTML into the inner iframe and relays messages both ways,
// checking origins, so the app can never touch the host page.
import {
  buildAllowAttribute,
  type McpUiSandboxProxyReadyNotification,
  type McpUiSandboxResourceReadyNotification,
} from '@modelcontextprotocol/ext-apps/app-bridge';

const ALLOWED_REFERRER = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

if (window.self === window.top) throw new Error('This page only runs inside the DocSaathi host.');
if (!document.referrer || !ALLOWED_REFERRER.test(document.referrer)) {
  throw new Error(`Embedding site not allowed: ${document.referrer || '(none)'}`);
}

const HOST_ORIGIN = new URL(document.referrer).origin;
const OWN_ORIGIN = window.location.origin;

// Self-test: reaching the top window must fail, or the sandbox is not isolated.
try {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  window.top!.document;
  throw new Error('SANDBOX_NOT_ISOLATED');
} catch (err) {
  if (err instanceof Error && err.message === 'SANDBOX_NOT_ISOLATED') throw new Error('The sandbox is not set up securely.');
}

const inner = document.createElement('iframe');
inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
inner.setAttribute('title', 'DocSaathi screen');
inner.style.cssText = 'width:100%;height:100%;border:none;';
document.body.appendChild(inner);

const RESOURCE_READY: McpUiSandboxResourceReadyNotification['method'] = 'ui/notifications/sandbox-resource-ready';
const PROXY_READY: McpUiSandboxProxyReadyNotification['method'] = 'ui/notifications/sandbox-proxy-ready';

window.addEventListener('message', (event) => {
  if (event.source === window.parent) {
    if (event.origin !== HOST_ORIGIN) return;
    const data = event.data as { method?: string; params?: { html?: string; sandbox?: string; permissions?: unknown } };
    if (data?.method === RESOURCE_READY) {
      const { html, sandbox, permissions } = data.params ?? {};
      if (typeof sandbox === 'string') inner.setAttribute('sandbox', sandbox);
      const allow = buildAllowAttribute(permissions as Parameters<typeof buildAllowAttribute>[0]);
      if (allow) inner.setAttribute('allow', allow);
      if (typeof html === 'string') {
        const doc = inner.contentDocument ?? inner.contentWindow?.document;
        if (doc) {
          doc.open();
          doc.write(html);
          doc.close();
        } else {
          inner.srcdoc = html;
        }
      }
    } else {
      inner.contentWindow?.postMessage(event.data, '*');
    }
  } else if (event.source === inner.contentWindow) {
    if (event.origin !== OWN_ORIGIN) return;
    window.parent.postMessage(event.data, HOST_ORIGIN);
  }
});

window.parent.postMessage({ jsonrpc: '2.0', method: PROXY_READY, params: {} }, HOST_ORIGIN);
