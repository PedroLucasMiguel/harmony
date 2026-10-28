// Says to the page that opened this window that it is ready to be filled.
window.opener?.postMessage({ type: 'harmony-pip-ready' }, location.origin);
